const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-67 — /billing/status anuncia los días gratis del checkout @api
 * (rama fix/bl67-recontratar-sin-prueba-api) — escrito NUEVO, en ROJO sin el fix
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   Regla (12-oct): días gratis SOLO para usuarios nuevos. El back calcula con
 *   la misma función lo que pide a la pasarela y lo que anuncia en
 *   `diasGratisAlContratar`:
 *     - prueba sin tarjeta → (días que le queden) + cardTrialDays
 *     - cualquier otro taller con suscripción (ya tuvo tarjeta, legado) → 0
 *   El checkout real no se puede inspeccionar sin la llave de Stripe; la regla
 *   que lo decide está cubierta por tests/BL-67_recontratar-sin-prueba.unit.test.js.
 *
 * ── CÓMO CORRERLO ─────────────────────────────────────────────────────────
 *   $env:API="http://localhost:3001/v1"; $env:AUTH_REAL="1"
 *   $env:SEED_EMAIL="rsv_gpa@outlook.com"; $env:SEED_PASSWORD="<contraseña>"
 *   (opcional, otra cuenta: p. ej. la del taller de prueba de OBS21-10, ya cancelada)
 *   npx playwright test --project=qa tests/qa/BL-67_estado-dias-gratis.api.spec.js
 *
 * ── ROJO ESPERADO sin el fix ──────────────────────────────────────────────
 *   `diasGratisAlContratar` no existe.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "";

async function llamar(request, path) {
  const res = await request.get(`${API}${path}`, { headers: await authHeaders() });
  let json = null;
  try { json = await res.json(); } catch (_) { /* vacío */ }
  return { status: res.status(), json };
}

/**
 * Taller de la sesión. No hay GET /users/me para la web: se saca el uid del
 * token (claim user_id) y se lee GET /users/:uid. ID_WORKSHOP sigue sirviendo
 * de atajo. (Antes se pedía /users/me y solo funcionaba con ID_WORKSHOP puesto.)
 */
async function tallerDeLaSesion(request) {
  if (process.env.ID_WORKSHOP) return process.env.ID_WORKSHOP;
  const { Authorization } = await authHeaders();
  const token = String(Authorization || "").replace(/^Bearer\s+/, "");
  let uid = "";
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    uid = payload.user_id || payload.uid || payload.sub || "";
  } catch (_) { /* token ilegible */ }
  if (!uid) return "";
  const res = await request.get(`${API}/users/${encodeURIComponent(uid)}`, { headers: { Authorization } });
  const json = await res.json().catch(() => null);
  return json?.data?.idWorkshop ?? "";
}

test.describe.configure({ mode: "default" });

test.describe("BL-67 — diasGratisAlContratar en /billing/status @api", () => {
  let d = null;
  let lectura = null; // para que un fallo diga POR QUÉ, en vez de saltarse

  test.beforeAll(async ({ request }) => {
    const id = ID_WORKSHOP || (await tallerDeLaSesion(request));
    if (!id) { lectura = { status: "sin-taller", json: null }; return; }
    const r = await llamar(request, `/billing/status/${encodeURIComponent(id)}`);
    lectura = { status: r.status, json: r.json, id };
    if (r.status === 200) d = r.json?.data ?? null;
  });

  test("el campo existe y es un entero ≥ 0", async () => {
    test.skip(lectura?.status === 404, "El taller de la sesión no tiene suscripción (404).");
    expect(lectura?.status, `GET /billing/status → ${JSON.stringify(lectura)}`).toBe(200);
    expect(Number.isInteger(d.diasGratisAlContratar), `llegó ${JSON.stringify(d.diasGratisAlContratar)}`).toBe(true);
    expect(d.diasGratisAlContratar).toBeGreaterThanOrEqual(0);
  });

  test("ya tuvo suscripción con tarjeta (o es legado) → 0: volver a contratar se cobra hoy", async () => {
    test.skip(!d, "Sin datos de /billing/status.");
    test.skip(d.trialType === "cardless", "Este taller está en la prueba sin tarjeta (lo cubre el caso siguiente).");
    expect(d.diasGratisAlContratar).toBe(0);
  });

  test("prueba sin tarjeta → lo que le quede + cardTrialDays", async () => {
    test.skip(!d, "Sin datos de /billing/status.");
    test.skip(d.trialType !== "cardless", `El taller no está en la prueba sin tarjeta (trialType ${d.trialType}).`);
    const quedan = d.hasAccess && Number.isFinite(d.trialDaysLeft) ? d.trialDaysLeft : 0;
    expect(Math.abs(d.diasGratisAlContratar - (quedan + d.cardTrialDays))).toBeLessThanOrEqual(1);
  });
});
