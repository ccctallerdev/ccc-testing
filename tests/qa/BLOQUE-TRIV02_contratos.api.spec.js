const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BLOQUE-TRIV02 — contratos de API de los que dependen los fixes @api
 * (rama fix/bloque-triviales-02-front) — NUEVO, no reciclado
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   BL-48  `GET /entries/get-car-services/:carId/:clientId` solo lista OS
 *          ENTREGADAS y cada una trae `deliveredAt` (el sello de la entrega,
 *          OBS31-02/11). Sin ese campo la pantalla cae al ingreso y la columna
 *          "Fecha de entrega" mentiría.
 *   BL-48  `GET /cars/:id` trae `codeCar` — las placas del encabezado.
 *   BL-49  El alta de usuario NO necesita `photoURL`: el back acepta crearlo
 *          sin foto (el avatar lo resuelve el front). Se BORRA el usuario de
 *          prueba al terminar.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   $env:API="http://localhost:3001/v1"     # o el de QA
 *   $env:AUTH_REAL="1"; $env:SKIP_SEED="1"
 *   $env:ID_WORKSHOP="G85FhlhedkD4L4CEDWvW"
 *   $env:SEED_EMAIL="rsv_gpa@outlook.com"; $env:SEED_PASSWORD="admin123"
 *   $env:E2E_CAR_ID="<id de un auto ENTREGADO>"; $env:E2E_CLIENT_ID="<su cliente>"
 *   npx playwright test --project=qa tests/qa/BLOQUE-TRIV02_contratos.api.spec.js
 *
 * Los casos sin datos se marcan SKIP con el motivo: nunca pasan en verde de gratis.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "";
const CAR_ID = process.env.E2E_CAR_ID || "";
const CLIENT_ID = process.env.E2E_CLIENT_ID || "";

async function llamar(request, method, path, data) {
  const res = await request[method](`${API}${path}`, {
    headers: { ...(await authHeaders()), "Content-Type": "application/json" },
    ...(data !== undefined ? { data } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* cuerpo vacío */ }
  return { status: res.status(), json };
}

test.describe.configure({ mode: "default" });

test.describe("BLOQUE-TRIV02 — contratos de API @api", () => {
  test("BL-48 · get-car-services solo trae OS ENTREGADAS, con deliveredAt", async ({ request }) => {
    test.skip(!CAR_ID || !CLIENT_ID, "Faltan E2E_CAR_ID / E2E_CLIENT_ID (un auto ya entregado)");
    const r = await llamar(
      request,
      "get",
      `/entries/get-car-services/${encodeURIComponent(CAR_ID)}/${encodeURIComponent(CLIENT_ID)}`,
    );
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const servicios = r.json?.data?.carServices ?? [];
    expect(servicios.length, "el auto debe tener al menos un servicio entregado").toBeGreaterThan(0);
    for (const s of servicios) {
      expect(String(s.statusService).toUpperCase(), `OS ${s.sheet}`).toContain("ENTREGADO");
      expect(s.deliveredAt, `OS ${s.sheet}: sin deliveredAt la columna caería al ingreso`).toBeTruthy();
      expect(Number(s.deliveredAt)).toBeGreaterThan(Date.UTC(2024, 0, 1));
    }
  });

  test("BL-48 · GET /cars/:id trae las placas (codeCar)", async ({ request }) => {
    test.skip(!CAR_ID, "Falta E2E_CAR_ID");
    const r = await llamar(request, "get", `/cars/${encodeURIComponent(CAR_ID)}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const car = r.json?.data?.car ?? r.json?.data;
    expect(String(car?.codeCar ?? "").trim(), "sin codeCar el encabezado no puede decir de qué auto es").not.toBe("");
  });

  test("BL-49 · se puede crear un usuario SIN photoURL", async ({ request }) => {
    test.skip(!ID_WORKSHOP, "Falta ID_WORKSHOP");
    const S = String(Date.now()).slice(-7);
    const correo = `rsv_gpa+triv02api${S}@outlook.com`;
    const alta = await llamar(request, "post", "/users", {
      name: "Triv", firstSurname: "Cero", secondSurname: "Dos",
      email: correo,
      phone: `55${S}1`, // 10 dígitos exactos (OBS31-08)
      password: "Roles_123!",
      rol: "ASESOR", country: "México",
      idWorkshop: ID_WORKSHOP,
    });
    const uid = alta.json?.data?.id ?? alta.json?.data?.uid;
    try {
      expect(alta.status, `el alta sin foto falló: ${JSON.stringify(alta.json)}`).toBeLessThan(300);
      const leido = await llamar(request, "get", `/users/${encodeURIComponent(uid)}`);
      expect(String(leido.json?.data?.photoURL ?? ""), "no debe sembrarse ninguna URL de Storage").not.toMatch(
        /firebasestorage/,
      );
    } finally {
      // Baja lógica: no dejar cuentas de prueba sueltas en el taller.
      if (uid) await llamar(request, "delete", `/users/${encodeURIComponent(uid)}`);
    }
  });
});
