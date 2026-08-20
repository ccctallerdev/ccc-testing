const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * Seguridad — API DE LA APP DEL CLIENTE (/v1/app). Fase 0 de Clientes v2.
 *
 * /v1/app se monta con gate PROPIO (requireClientRole + requireClient):
 *   - Solo cuentas con rol CLIENTE (claim firmado o users/{uid}.rol).
 *   - Correo VERIFICADO obligatorio (server-side, no solo en la app).
 *   - El personal del taller NO pasa (usa /v1/clients con sus capabilities)
 *     y el CLIENTE no pasa por las rutas del taller (CAN_VIEW_CLIENTS).
 *   - El token de afiliación debe pertenecer a MI cuenta (session/:token).
 *
 * PRERREQUISITOS: emuladores + backend + seed (global-setup).
 */

const API = process.env.API || "http://localhost:3001/v1";
const AUTH_EMU = process.env.AUTH_EMU || "http://127.0.0.1:9099";
const PROJECT_ID = process.env.EMU_PROJECT_ID || "ccc-taller-refac";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";

const stamp = String(Date.now()).slice(-7);
const CLIENT_EMAIL = `cliente.v1app.${stamp}@ccc.test`;
const CLIENT_PASSWORD = "Prueba123!";

async function api(request, token, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json, data: json?.data ?? json };
}

async function signIn(request, email, password) {
  const res = await request.post(
    `${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`,
    { data: { email, password, returnSecureToken: true } },
  );
  if (!res.ok()) throw new Error(`signIn ${email} → ${res.status()}: ${await res.text()}`);
  return await res.json(); // { idToken, localId, ... }
}

/**
 * Verifica el correo de una cuenta contra el EMULADOR de Auth:
 * pide el correo de verificación y aplica el oobCode que el emulador expone
 * en /emulator/v1/projects/{id}/oobCodes (no hay buzón real).
 */
async function verifyEmailInEmulator(request, idToken, email) {
  const send = await request.post(
    `${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=fake`,
    { data: { requestType: "VERIFY_EMAIL", idToken } },
  );
  if (!send.ok()) throw new Error(`sendOobCode → ${send.status()}: ${await send.text()}`);

  const codesRes = await request.get(`${AUTH_EMU}/emulator/v1/projects/${PROJECT_ID}/oobCodes`);
  const { oobCodes = [] } = await codesRes.json();
  const mine = [...oobCodes]
    .reverse()
    .find((c) => c.email === email && c.requestType === "VERIFY_EMAIL");
  if (!mine) throw new Error(`No hay oobCode VERIFY_EMAIL para ${email} en el emulador`);

  const apply = await request.post(
    `${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:update?key=fake`,
    { data: { oobCode: mine.oobCode } },
  );
  if (!apply.ok()) throw new Error(`aplicar oobCode → ${apply.status()}: ${await apply.text()}`);
}

test.describe.serial("Seguridad — /v1/app (API de la app del cliente)", () => {
  let adminToken; // personal del taller (seed)
  let clientId; // doc de `clients` creado por el taller
  let affToken; // token de afiliación del cliente al taller

  test.beforeAll(async ({ request }) => {
    adminToken = (await authHeaders()).Authorization.replace("Bearer ", "");

    // El taller registra al cliente global y lo afilia (flujo web actual).
    const c = await api(request, adminToken, "post", "/clients", {
      fullName: "Cliente Vuno App",
      email: CLIENT_EMAIL,
      phone: `55${stamp}0`.slice(0, 10),
      createdBy: "spec",
    });
    expect(c.status, `crear cliente: ${JSON.stringify(c.body)}`).toBe(201);
    clientId = c.data.id;

    const t = await api(request, adminToken, "post", "/tokens", {
      idClient: clientId,
      idWorkshop: ID_WORKSHOP,
    });
    expect(t.status, `afiliar: ${JSON.stringify(t.body)}`).toBe(200);
    affToken = t.data.token;

    // El cliente crea su cuenta de app (rol CLIENTE) — ruta pública.
    const s = await api(request, null, "post", "/public/signup", {
      name: "Cliente",
      firstSurname: "Vuno",
      email: CLIENT_EMAIL,
      phone: `55${stamp}0`.slice(0, 10),
      password: CLIENT_PASSWORD,
    });
    expect(s.status, `signup: ${JSON.stringify(s.body)}`).toBe(201);
  });

  test("1) el personal del taller NO entra a /v1/app (403)", { tag: ["@api"] }, async ({ request }) => {
    const res = await api(request, adminToken, "get", "/app/me");
    expect(res.status, "ADMIN no debe pasar el gate de la app").toBe(403);
  });

  test("2) cuenta CLIENTE con correo SIN verificar → 403 en /v1/app", { tag: ["@api"] }, async ({ request }) => {
    const { idToken } = await signIn(request, CLIENT_EMAIL, CLIENT_PASSWORD);
    const res = await api(request, idToken, "get", "/app/me");
    expect(res.status, "sin correo verificado no hay datos").toBe(403);
    expect(String(res.body?.descripcion || "")).toContain("Correo sin verificar");
  });

  test("3) con correo verificado: /app/me liga y responde el cliente (200)", { tag: ["@api"] }, async ({ request }) => {
    let { idToken } = await signIn(request, CLIENT_EMAIL, CLIENT_PASSWORD);
    await verifyEmailInEmulator(request, idToken, CLIENT_EMAIL);
    // Nuevo token con email_verified=true.
    ({ idToken } = await signIn(request, CLIENT_EMAIL, CLIENT_PASSWORD));

    const me = await api(request, idToken, "get", "/app/me");
    expect(me.status, `app/me: ${JSON.stringify(me.body)}`).toBe(200);
    expect(me.data.id).toBe(clientId);
    expect(me.data.email).toBe(CLIENT_EMAIL);
  });

  test("4) /app/tokens lista MI afiliación (sin mandar idClient)", { tag: ["@api"] }, async ({ request }) => {
    const { idToken } = await signIn(request, CLIENT_EMAIL, CLIENT_PASSWORD);
    const res = await api(request, idToken, "get", "/app/tokens");
    expect(res.status).toBe(200);
    const tokens = Array.isArray(res.data) ? res.data : [];
    expect(tokens.map((t) => t.token)).toContain(affToken);
  });

  test("5) /app/session/:token abre MI sesión de taller (200) y rechaza un token ajeno (403/404)", { tag: ["@api"] }, async ({ request }) => {
    const { idToken } = await signIn(request, CLIENT_EMAIL, CLIENT_PASSWORD);

    const ok = await api(request, idToken, "get", `/app/session/${affToken}`);
    expect(ok.status, `session propia: ${JSON.stringify(ok.body)}`).toBe(200);
    expect(ok.data.client.id).toBe(clientId);
    expect(Array.isArray(ok.data.cars)).toBe(true);

    // Token ajeno: el de la seed E2E (cliente del Nissan Versa) u otro
    // inexistente — nunca debe abrir datos de otro cliente.
    const ajena = await api(request, idToken, "get", "/app/session/ZZZZ99");
    expect([403, 404]).toContain(ajena.status);
  });

  test("6) el CLIENTE no pasa por las rutas del taller (/v1/clients → 403)", { tag: ["@api"] }, async ({ request }) => {
    const { idToken } = await signIn(request, CLIENT_EMAIL, CLIENT_PASSWORD);
    const res = await api(request, idToken, "get", `/clients?idWorkshop=${ID_WORKSHOP}`);
    expect(res.status, "CLIENTE está fuera de CAN_VIEW_CLIENTS").toBe(403);
  });
});
