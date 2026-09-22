const { test, expect } = require("@playwright/test");
const { authHeaders, getApiToken } = require("#apiToken");
const { signIn } = require("../../qaAuth");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BLOQUE-TRIV01 — contratos de API en los que se apoyan los fixes de front @api
 * (rama fix/bloque-triviales-01-front) — NUEVO, no reciclado
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Los cuatro arreglos del bloque son de pantalla, pero cada uno da por hecho
 * un dato que manda el back. Si ese dato no llega, el front "arreglado" sigue
 * viéndose roto y nadie sabría por qué. Este spec lo fija:
 *
 *   BL-46     PUT /users/:uid con photoURL (con el `&v=` anti-caché) se guarda
 *             tal cual y GET lo regresa. Se RESTAURA la foto original al final.
 *   BL-46/me  Un rol SIN CAN_MANAGE_USERS (Mecánico): PUT /users/:uid da 403
 *             —por eso no podía guardar ni su foto— y PUT /users/me sí guarda
 *             foto y nombres. Se RESTAURA al final.
 *   OBS31-12  GET /clients trae `cars[].lastServiceAt` NUMÉRICO en los autos
 *             que ya se entregaron (Q18 lo sella al ENTREGAR).
 *   OBS31-10  GET /entries/:id trae `sheet` (el número de OS que pinta Costeo).
 *   BL-33     GET /entries?approvalState=APROBADA trae `needsProcurement` y
 *             `procurement` (lo que enciende y precarga el botón).
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"   # o http://localhost:3001/v1
 *   $env:AUTH_REAL="1"; $env:SKIP_SEED="1"
 *   $env:ID_WORKSHOP="<taller de pruebas de refac>"
 *   $env:SEED_EMAIL="rsv_gpa@outlook.com"; $env:SEED_PASSWORD="<contraseña>"
 *   $env:E2E_ENTRY_ID="<OS con diagnóstico>"            # para OBS31-10
 *   $env:ROL_MECANICO_EMAIL="rsv_gpa+mecanico1@outlook.com"; $env:ROL_MECANICO_PASS="Prueba_123!"
 *   npx playwright test --project=qa tests/qa/BLOQUE-TRIV01_contratos.api.spec.js
 *
 * Los casos con guardia de datos (sin autos entregados, sin OS aprobadas con
 * faltantes) se marcan SKIP con el motivo: nunca pasan en verde de gratis.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "";
const ENTRY_ID = process.env.E2E_ENTRY_ID || "";

/** uid del token (claim `user_id`), sin depender de otro endpoint. */
async function uidDelToken() {
  const token = await getApiToken();
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  return payload.user_id || payload.sub;
}

async function llamar(request, method, path, data) {
  const res = await request[method](`${API}${path}`, {
    headers: { ...(await authHeaders()), "Content-Type": "application/json" },
    ...(data !== undefined ? { data } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* cuerpo vacío */ }
  return { status: res.status(), json };
}

// Casos independientes: uno en rojo NO debe tumbar a los demás (con
// "serial" un fallo dejaba 26 sin correr).
test.describe.configure({ mode: "default" });

test.describe("BLOQUE-TRIV01 — contratos de API @api", () => {
  test("BL-46 · PUT /users/:uid guarda el photoURL (con &v=) y GET lo regresa", async ({ request }) => {
    const uid = await uidDelToken();
    const antes = await llamar(request, "get", `/users/${encodeURIComponent(uid)}`);
    expect(antes.status, JSON.stringify(antes.json)).toBe(200);
    const original = antes.json?.data?.photoURL ?? null;

    const nueva =
      "https://firebasestorage.googleapis.com/v0/b/e2e/o/x%2Fimagenes%2FprofilePic.png" +
      `?alt=media&token=e2e-bl46&v=${Date.now()}`;
    try {
      const put = await llamar(request, "put", `/users/${encodeURIComponent(uid)}`, { photoURL: nueva });
      expect(put.status, `PUT rechazó el photoURL: ${JSON.stringify(put.json)}`).toBeGreaterThanOrEqual(200);
      expect(put.status).toBeLessThan(300);

      const despues = await llamar(request, "get", `/users/${encodeURIComponent(uid)}`);
      expect(despues.json?.data?.photoURL, "el photoURL persistido debe ser EXACTO, con su &v=").toBe(nueva);
    } finally {
      // Restaurar: este usuario es real en refac. (El schema exige URL: si no
      // tenía foto no hay a qué volver — se avisa en vez de fallar callado.)
      if (original) await llamar(request, "put", `/users/${encodeURIComponent(uid)}`, { photoURL: original });
      else console.warn(`[BL-46] ${uid} no tenía foto; quedó la de prueba (e2e-bl46). Bórrala a mano si estorba.`);
    }
  });

  test("BL-46 · Mecánico: /users/:uid da 403 y /users/me guarda su foto", async ({ request }) => {
    const email = process.env.ROL_MECANICO_EMAIL;
    const pass = process.env.ROL_MECANICO_PASS;
    test.skip(!email || !pass, "Falta ROL_MECANICO_EMAIL / ROL_MECANICO_PASS");
    const token = await signIn(email, pass);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const uid = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).user_id;

    const antes = await request.get(`${API}/users/${encodeURIComponent(uid)}`, { headers });
    expect(antes.status(), "leer SU propio perfil debe estar permitido").toBe(200);
    const original = (await antes.json())?.data?.photoURL || "";

    const nueva = `https://firebasestorage.googleapis.com/v0/b/e2e/o/x?alt=media&token=e2e-me&v=${Date.now()}`;
    try {
      // La puerta vieja: exige CAN_MANAGE_USERS. Este 403 ERA el bug.
      const viejo = await request.put(`${API}/users/${encodeURIComponent(uid)}`, { headers, data: { photoURL: nueva } });
      expect(viejo.status(), "PUT /users/:id debe seguir cerrado para el Mecánico").toBe(403);

      // La puerta que usa ahora el front.
      const me = await request.put(`${API}/users/me`, { headers, data: { photoURL: nueva } });
      expect(me.status(), await me.text()).toBeLessThan(300);
      const despues = await request.get(`${API}/users/${encodeURIComponent(uid)}`, { headers });
      expect((await despues.json())?.data?.photoURL).toBe(nueva);
    } finally {
      await request.put(`${API}/users/me`, { headers, data: { photoURL: original } });
    }
  });

  test("OBS31-12 · GET /clients trae cars[].lastServiceAt numérico en autos entregados", async ({ request }) => {
    test.skip(!ID_WORKSHOP, "Falta ID_WORKSHOP");
    const r = await llamar(request, "get", `/clients?idWorkshop=${encodeURIComponent(ID_WORKSHOP)}&limit=100`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const autos = (r.json?.data?.clients ?? []).flatMap((c) => c?.cars ?? []);
    const conServicio = autos.filter((a) => a?.lastServiceAt != null);
    test.skip(
      conServicio.length === 0,
      `Ningún auto del taller tiene lastServiceAt (${autos.length} autos revisados). Entrega una OS y repite.`,
    );
    for (const a of conServicio) {
      expect(typeof a.lastServiceAt, `auto ${a.codeCar || a.id}`).toBe("number");
      expect(a.lastServiceAt).toBeGreaterThan(Date.UTC(2024, 0, 1));
    }
  });

  test("OBS31-10 · GET /entries/:id trae el número de OS (sheet)", async ({ request }) => {
    test.skip(!ENTRY_ID, "Falta E2E_ENTRY_ID");
    const r = await llamar(request, "get", `/entries/${encodeURIComponent(ENTRY_ID)}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const e = r.json?.data?.entry ?? r.json?.data;
    expect(String(e?.sheet ?? "").trim(), "sin sheet, el Costeo no tiene qué mostrar").not.toBe("");
  });

  test("BL-33 · las OS aprobadas con faltantes traen needsProcurement + procurement", async ({ request }) => {
    test.skip(!ID_WORKSHOP, "Falta ID_WORKSHOP");
    const r = await llamar(
      request,
      "get",
      `/entries?idWorkshop=${encodeURIComponent(ID_WORKSHOP)}&approvalState=APROBADA&status=1&limit=100&excludeDelivered=true`,
    );
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const conFaltantes = (r.json?.data?.entries ?? []).filter((e) => e?.needsProcurement === true);
    test.skip(conFaltantes.length === 0, "No hay OS aprobadas con refacciones fuera de stock en el taller.");
    for (const e of conFaltantes) {
      expect(Array.isArray(e.procurement), `OS ${e.sheet}: procurement debe ser lista`).toBe(true);
      expect(e.procurement.length, `OS ${e.sheet}: needsProcurement sin partidas`).toBeGreaterThan(0);
    }
  });
});
