const { test, expect } = require("@playwright/test");

/**
 * Seguridad — AISLAMIENTO ENTRE TALLERES (anti-IDOR). Paso 2.
 *
 * El middleware verifyWorkshopAccess compara el `idWorkshop` que pide el request
 * contra el del custom claim firmado del usuario. Un usuario del taller A NO debe
 * poder leer/escribir datos del taller B pasando su id (header/query/param).
 *
 * Escenario sembrado (global-setup → seed_emulator_user.js):
 *   - Owner: prueba@ccc.test, claim { role: ADMIN, idWorkshop: taller-prueba }.
 *   - Taller propio:  taller-prueba (ID_WORKSHOP).
 *   - Taller AJENO:   taller-prueba-b (ID_WORKSHOP_B) — existe, pero no es suyo.
 *   - TECH_SUPPORT: tech@ccc.test — rol de plataforma, EXENTO del aislamiento.
 *
 * PRERREQUISITOS: emuladores + backend + seed (global-setup).
 */

const API = process.env.API || "http://localhost:3001/v1";
const AUTH_EMU = process.env.AUTH_EMU || "http://127.0.0.1:9099";
const OWNER_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const OWNER_PASSWORD = process.env.SEED_PASSWORD || "prueba123";
const TECH_EMAIL = process.env.TECH_EMAIL || "tech@ccc.test";
const TECH_PASSWORD = process.env.TECH_PASSWORD || "prueba123";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const ID_WORKSHOP_B = process.env.ID_WORKSHOP_B || "taller-prueba-b";

async function tokenFor(request, email, password) {
  const res = await request.post(
    `${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`,
    { data: { email, password, returnSecureToken: true } },
  );
  if (!res.ok()) throw new Error(`signIn ${email} → ${res.status()}: ${await res.text()}`);
  return (await res.json()).idToken;
}

async function api(request, token, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), data: json?.data ?? json };
}

test.describe.serial("Seguridad — aislamiento entre talleres (fuga de talleres)", () => {
  test("1) el owner SÍ lee su propio taller (200)", { tag: ["@api"] }, async ({ request }) => {
    const t = await tokenFor(request, OWNER_EMAIL, OWNER_PASSWORD);
    const res = await api(request, t, "get", `/workshops/${ID_WORKSHOP}`);
    expect(res.status, "leer el taller propio debe funcionar").toBe(200);
  });

  test("2) el owner NO puede leer un taller ajeno por :id (403)", { tag: ["@api"] }, async ({ request }) => {
    const t = await tokenFor(request, OWNER_EMAIL, OWNER_PASSWORD);
    const res = await api(request, t, "get", `/workshops/${ID_WORKSHOP_B}`);
    expect(res.status, "GET /workshops/<ajeno> debe dar 403").toBe(403);
  });

  test("3) el owner NO puede ver el dashboard de un taller ajeno (403)", { tag: ["@api"] }, async ({ request }) => {
    const t = await tokenFor(request, OWNER_EMAIL, OWNER_PASSWORD);
    const res = await api(request, t, "get", `/dashboard?idWorkshop=${ID_WORKSHOP_B}`);
    expect(res.status, "GET /dashboard?idWorkshop=<ajeno> debe dar 403").toBe(403);
  });

  test("4) el owner NO puede listar clientes de un taller ajeno (403)", { tag: ["@api"] }, async ({ request }) => {
    const t = await tokenFor(request, OWNER_EMAIL, OWNER_PASSWORD);
    const res = await api(request, t, "get", `/clients?idWorkshop=${ID_WORKSHOP_B}`);
    expect(res.status, "GET /clients?idWorkshop=<ajeno> debe dar 403").toBe(403);
  });

  test("5) el dashboard del taller PROPIO no lo bloquea el aislamiento (no 403)", { tag: ["@api"] }, async ({ request }) => {
    const t = await tokenFor(request, OWNER_EMAIL, OWNER_PASSWORD);
    const res = await api(request, t, "get", `/dashboard?idWorkshop=${ID_WORKSHOP}`);
    expect(res.status, "el taller propio NO debe dar 403 (el aislamiento no estorba)").not.toBe(403);
  });

  test("6) TECH_SUPPORT está EXENTO del aislamiento (lee taller ajeno, no 403)", { tag: ["@api"] }, async ({ request }) => {
    const t = await tokenFor(request, TECH_EMAIL, TECH_PASSWORD);
    const res = await api(request, t, "get", `/workshops/${ID_WORKSHOP_B}`);
    expect(res.status, "TECH_SUPPORT (plataforma) no debe ser bloqueado por taller").not.toBe(403);
  });

  test("7) el owner NO puede BORRAR datos de un taller ajeno (data-management, 403)", { tag: ["@api"] }, async ({ request }) => {
    const t = await tokenFor(request, OWNER_EMAIL, OWNER_PASSWORD);
    // DELETE irreversible con idWorkshop ajeno en el body: el aislamiento debe
    // cortar ANTES de llegar al servicio de wipe. Si diera !=403, el borrado
    // destructivo de un taller ajeno sería posible.
    const res = await api(request, t, "delete", "/data-management/workshop", {
      idWorkshop: ID_WORKSHOP_B,
      confirm: true,
    });
    expect(res.status, "borrar datos de un taller ajeno debe dar 403").toBe(403);
  });
});
