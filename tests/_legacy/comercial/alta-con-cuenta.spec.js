const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * Clientes v2 (nuevo enfoque 19-ago) — ALTA COMPLETA DESDE EL TALLER:
 * POST /v1/clients/with-account crea cuenta de app con contraseña OCULTA
 * (nadie la ve) + cliente ligado + afiliación automática, y manda el correo
 * de ACTIVACIÓN (un enlace = verificar correo + crear contraseña).
 *
 * Verifica de punta a punta contra los emuladores:
 *   - nadie puede iniciar sesión antes de activar (la contraseña es aleatoria);
 *   - la activación usa el oobCode de PASSWORD_RESET (expuesto por el emulador
 *     en /emulator/v1/projects/{id}/oobCodes) y al completarla el correo queda
 *     VERIFICADO → /v1/app abre;
 *   - idempotencia: repetir el alta NO duplica cuenta/cliente/token;
 *   - /v1/public/resend-activation es no-oráculo.
 *
 * PRERREQUISITOS: emuladores + backend + seed (global-setup). Brevo puede no
 * estar configurado en local: el alta NO depende del envío (activationSent
 * puede ser false) y la activación del test usa el oobCode del emulador.
 */

const API = process.env.API || "http://localhost:3001/v1";
const AUTH_EMU = process.env.AUTH_EMU || "http://127.0.0.1:9099";
const PROJECT_ID = process.env.EMU_PROJECT_ID || "ccc-taller-refac";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";

const stamp = String(Date.now()).slice(-7);
const EMAIL = `alta.cuenta.${stamp}@ccc.test`;
const NEW_PASSWORD = "MiClave123!";

async function api(request, token, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json, data: json?.data ?? json };
}

async function trySignIn(request, email, password) {
  const res = await request.post(
    `${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`,
    { data: { email, password, returnSecureToken: true } },
  );
  return { ok: res.ok(), json: await res.json().catch(() => null) };
}

/** Último oobCode de PASSWORD_RESET para un correo, desde el emulador. */
async function lastResetCode(request, email) {
  const res = await request.get(`${AUTH_EMU}/emulator/v1/projects/${PROJECT_ID}/oobCodes`);
  const { oobCodes = [] } = await res.json();
  const mine = [...oobCodes]
    .reverse()
    .find((c) => c.email === email && c.requestType === "PASSWORD_RESET");
  return mine?.oobCode ?? null;
}

test.describe.serial("Clientes v2 — alta con cuenta oculta + activación", () => {
  let adminToken;
  let firstAlta; // respuesta del primer with-account

  test.beforeAll(async () => {
    adminToken = (await authHeaders()).Authorization.replace("Bearer ", "");
  });

  test("1) with-account crea cuenta+cliente+token y NO expone ninguna contraseña", { tag: ["@api"] }, async ({ request }) => {
    const res = await api(request, adminToken, "post", "/clients/with-account", {
      fullName: "Alta Cuenta Prueba",
      email: EMAIL,
      phone: `55${stamp}1`.slice(0, 10),
      createdBy: "spec",
      idWorkshop: ID_WORKSHOP,
    });
    expect(res.status, `with-account: ${JSON.stringify(res.body)}`).toBe(201);
    firstAlta = res.data;
    expect(firstAlta.client?.id).toBeTruthy();
    expect(firstAlta.client.idUser).toBeTruthy(); // ligado desde el alta
    expect(firstAlta.token).toMatch(/^[A-Z0-9]{6}$/);
    expect(firstAlta.accountCreated).toBe(true);
    expect(firstAlta.clientCreated).toBe(true);
    // La contraseña provisional NO viaja en la respuesta, con ningún nombre.
    const raw = JSON.stringify(res.body).toLowerCase();
    expect(raw).not.toContain("password");
    expect(raw).not.toContain("contraseña");
  });

  test("2) nadie puede iniciar sesión antes de activar (contraseña oculta)", { tag: ["@api"] }, async ({ request }) => {
    const intento = await trySignIn(request, EMAIL, "cualquiera123");
    expect(intento.ok, "una contraseña adivinada no debe entrar").toBe(false);
  });

  test("3) repetir el alta es idempotente: mismo cliente, mismo token, sin cuenta nueva", { tag: ["@api"] }, async ({ request }) => {
    const res = await api(request, adminToken, "post", "/clients/with-account", {
      fullName: "Alta Cuenta Prueba",
      email: EMAIL,
      phone: `55${stamp}1`.slice(0, 10),
      createdBy: "spec",
      idWorkshop: ID_WORKSHOP,
    });
    expect(res.status).toBe(201);
    expect(res.data.client.id).toBe(firstAlta.client.id);
    expect(res.data.token).toBe(firstAlta.token);
    expect(res.data.accountCreated).toBe(false);
    expect(res.data.clientCreated).toBe(false);
  });

  test("4) resend-activation es no-oráculo: misma respuesta exista o no la cuenta", { tag: ["@api", "@publico"] }, async ({ request }) => {
    const existente = await request.post(`${API}/public/resend-activation`, {
      data: { email: EMAIL },
      headers: { "x-forwarded-for": `10.9.${stamp.slice(0, 2)}.1` },
    });
    const inexistente = await request.post(`${API}/public/resend-activation`, {
      data: { email: `nadie.${stamp}@ccc.test` },
      headers: { "x-forwarded-for": `10.9.${stamp.slice(0, 2)}.2` },
    });
    expect(existente.status()).toBe(200);
    expect(inexistente.status()).toBe(200);
    const a = await existente.json();
    const b = await inexistente.json();
    expect(a.descripcion).toBe(b.descripcion);
  });

  test("5) activar (oobCode del emulador) verifica el correo y crea la contraseña", { tag: ["@api"] }, async ({ request }) => {
    // El correo de Brevo puede no salir en local; el oobCode del emulador es
    // el MISMO que iría dentro del enlace /acciones-cuenta?mode=activate.
    // resend-activation del caso 4 ya generó uno; si no, lo pedimos otra vez.
    let code = await lastResetCode(request, EMAIL);
    if (!code) {
      await request.post(`${API}/public/resend-activation`, {
        data: { email: EMAIL },
        headers: { "x-forwarded-for": `10.9.${stamp.slice(0, 2)}.3` },
      });
      code = await lastResetCode(request, EMAIL);
    }
    expect(code, "debe existir un oobCode PASSWORD_RESET para el correo").toBeTruthy();

    // Equivalente REST de confirmPasswordReset (lo que hace /acciones-cuenta).
    const reset = await request.post(
      `${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=fake`,
      { data: { oobCode: code, newPassword: NEW_PASSWORD } },
    );
    expect(reset.ok(), `resetPassword: ${await reset.text()}`).toBe(true);

    // Ya puede iniciar sesión con SU contraseña…
    const login = await trySignIn(request, EMAIL, NEW_PASSWORD);
    expect(login.ok, "login tras activar debe funcionar").toBe(true);

    // …y el correo quedó VERIFICADO: /v1/app (que lo exige) abre y liga.
    const me = await api(request, login.json.idToken, "get", "/app/me");
    expect(me.status, `app/me tras activar: ${JSON.stringify(me.body)}`).toBe(200);
    expect(me.data.id).toBe(firstAlta.client.id);
  });

  test("6) tras activar, /app/tokens ya trae la afiliación hecha por el taller", { tag: ["@api"] }, async ({ request }) => {
    const login = await trySignIn(request, EMAIL, NEW_PASSWORD);
    const res = await api(request, login.json.idToken, "get", "/app/tokens");
    expect(res.status).toBe(200);
    const tokens = Array.isArray(res.data) ? res.data : [];
    expect(tokens.map((t) => t.token)).toContain(firstAlta.token);
  });
});
