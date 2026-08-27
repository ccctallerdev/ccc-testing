const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");
const { apiKeyPublica } = require("../../qaAuth");
const { oobCodeFor } = require("../../qaAdmin");

/**
 * COPIA PARA QA de comercial/alta-con-cuenta.spec.js.
 *
 * El original NO se toca: sigue corriendo contra emuladores como siempre.
 * Este gemelo prueba lo mismo contra refac, cambiando solo las tres cosas
 * que estaban atadas al emulador:
 *
 *   | Original (emuladores)                  | Aquí (refac)                        |
 *   |----------------------------------------|-------------------------------------|
 *   | signIn contra 127.0.0.1:9099           | identitytoolkit real + API key web  |
 *   | oobCode leído de /emulator/v1/oobCodes | generado con el Admin SDK (qaAdmin) |
 *   | resetPassword contra el emulador       | resetPassword real                  |
 *
 * ⚠️ Un matiz al leer los resultados: el oobCode lo GENERA el test, no es el
 * que Brevo mandó por correo. Se comprueba que la activación funciona, no que
 * el enlace del correo del backend sea correcto — eso solo se ve abriendo el
 * correo a mano, o con el spec original contra emuladores.
 *
 * USO:
 *   $env:BASE_URL="https://ccc-frontend-qa.vercel.app"
 *   $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"
 *   $env:SEED_EMAIL="rsv.cup@gmail.com"; $env:SEED_PASSWORD="admin123"
 *   $env:SKIP_SEED="1"
 *   npm run test:qa
 *
 * ID_WORKSHOP es opcional: se deduce del admin de SEED_EMAIL.
 * Necesita el serviceAccountKey de refac en ccc-backend/functions/
 * (o la ruta en SERVICE_ACCOUNT_KEY).
 */

const API = process.env.API || "http://localhost:3001/v1";
const SEED_EMAIL = process.env.SEED_EMAIL || "rsv.cup@gmail.com";

const stamp = String(Date.now()).slice(-7);
const EMAIL = `alta.cuenta.qa.${stamp}@ccc.test`;
const NEW_PASSWORD = "MiClave123!";

let ID_WORKSHOP = process.env.ID_WORKSHOP || null;

async function api(request, token, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json, data: json?.data ?? json };
}

/** Intento de login contra el Firebase REAL (no truena si falla: lo reporta). */
async function trySignIn(request, email, password) {
  const res = await request.post(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKeyPublica()}`,
    { data: { email, password, returnSecureToken: true } },
  );
  return { ok: res.ok(), json: await res.json().catch(() => null) };
}

test.describe.serial("QA · Clientes v2 — alta con cuenta oculta + activación", () => {
  let adminToken;
  let firstAlta;

  test.beforeAll(async ({ request }) => {
    adminToken = (await authHeaders()).Authorization.replace("Bearer ", "");
    if (!ID_WORKSHOP) {
      const yo = await api(request, adminToken, "get", `/users/email/${encodeURIComponent(SEED_EMAIL)}`);
      ID_WORKSHOP = yo.data?.idWorkshop;
      expect(ID_WORKSHOP, `no pude deducir el taller de ${SEED_EMAIL}`).toBeTruthy();
      console.log(`   🏢 Taller: ${ID_WORKSHOP}`);
    }
  });

  test("1) with-account crea cuenta+cliente+token y NO expone ninguna contraseña", { tag: ["@api"] }, async ({ request }) => {
    const res = await api(request, adminToken, "post", "/clients/with-account", {
      fullName: "Alta Cuenta QA",
      email: EMAIL,
      phone: `55${stamp}1`.slice(0, 10),
      createdBy: "spec-qa",
      idWorkshop: ID_WORKSHOP,
    });
    expect(res.status, `with-account: ${JSON.stringify(res.body)}`).toBe(201);
    firstAlta = res.data;
    expect(firstAlta.client?.id).toBeTruthy();
    expect(firstAlta.client.idUser).toBeTruthy();
    expect(firstAlta.token).toMatch(/^[A-Z0-9]{6}$/);
    expect(firstAlta.accountCreated).toBe(true);
    expect(firstAlta.clientCreated).toBe(true);
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
      fullName: "Alta Cuenta QA",
      email: EMAIL,
      phone: `55${stamp}1`.slice(0, 10),
      createdBy: "spec-qa",
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
      data: { email: `nadie.qa.${stamp}@ccc.test` },
      headers: { "x-forwarded-for": `10.9.${stamp.slice(0, 2)}.2` },
    });
    expect(existente.status()).toBe(200);
    expect(inexistente.status()).toBe(200);
    const a = await existente.json();
    const b = await inexistente.json();
    expect(a.descripcion).toBe(b.descripcion);
  });

  test("5) activar con el oobCode verifica el correo y crea la contraseña", { tag: ["@api"] }, async ({ request }) => {
    // Contra emuladores el código se leía del buzón falso; aquí lo genera el
    // Admin SDK. Es el mismo tipo (PASSWORD_RESET) que viaja en el enlace de
    // "Activa tu cuenta".
    const code = await oobCodeFor(EMAIL);
    expect(code, "debe poder generarse un oobCode para el correo").toBeTruthy();

    const reset = await request.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=${apiKeyPublica()}`,
      { data: { oobCode: code, newPassword: NEW_PASSWORD } },
    );
    expect(reset.ok(), `resetPassword: ${await reset.text()}`).toBe(true);

    const login = await trySignIn(request, EMAIL, NEW_PASSWORD);
    expect(login.ok, "login tras activar debe funcionar").toBe(true);

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
