const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * BACKLOG_TECNICO #6 (25-ago) — Editar cliente desde el taller sin romper la
 * cuenta (Clientes v2):
 *   - Correo editable SOLO mientras la cuenta NO esté verificada: se actualiza
 *     Firebase Auth (+ emailVerified=false), `users` y `clients`, y se
 *     reenvía la activación al buzón nuevo.
 *   - Cuenta verificada → 409 EMAIL_LOCKED y nada cambia.
 *   - Teléfono: único sobre users+clients (409 PHONE_TAKEN) y espejo en
 *     `users.phone`.
 *   - UI: el modal "Editar cliente" bloquea el correo (readOnly + leyenda)
 *     cuando la cuenta ya está verificada.
 *
 * PRERREQUISITOS: emuladores + backend :3001 + frontend :3000 + seed.
 */

const API = process.env.API || "http://localhost:3001/v1";
const AUTH_EMU = process.env.AUTH_EMU || "http://127.0.0.1:9099";
const PROJECT_ID = process.env.EMU_PROJECT_ID || "ccc-taller-refac";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const ADMIN_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const ADMIN_PASSWORD = process.env.SEED_PASSWORD || "prueba123";

const s = String(Date.now()).slice(-6);
const A = { name: `Cliente Editable ${s}`, email: `edit.a.${s}@ccc.test`, email2: `edit.a2.${s}@ccc.test`, phone: `5561${s}`, phone2: `5562${s}` };
const B = { name: `Cliente Verificado ${s}`, email: `edit.b.${s}@ccc.test`, email2: `edit.b2.${s}@ccc.test`, phone: `5563${s}`, password: "Prueba123!" };

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
  return await res.json();
}

async function verifyEmailInEmulator(request, idToken, email) {
  const send = await request.post(
    `${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=fake`,
    { data: { requestType: "VERIFY_EMAIL", idToken } },
  );
  if (!send.ok()) throw new Error(`sendOobCode → ${send.status()}: ${await send.text()}`);
  const codesRes = await request.get(`${AUTH_EMU}/emulator/v1/projects/${PROJECT_ID}/oobCodes`);
  const { oobCodes = [] } = await codesRes.json();
  const mine = [...oobCodes].reverse().find((c) => c.email === email && c.requestType === "VERIFY_EMAIL");
  if (!mine) throw new Error(`No hay oobCode VERIFY_EMAIL para ${email}`);
  const apply = await request.post(`${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:update?key=fake`, {
    data: { oobCode: mine.oobCode },
  });
  if (!apply.ok()) throw new Error(`aplicar oobCode → ${apply.status()}: ${await apply.text()}`);
}

async function login(page) {
  await page.goto("/login");
  await page.locator("#email").fill(ADMIN_EMAIL);
  await page.locator("#password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });
}

async function openEditModal(page, name) {
  await page.goto("/clientes");
  const search = page.getByPlaceholder(/nombre, email, teléfono/i);
  await search.fill(name);
  await page.getByRole("button", { name: /buscar/i }).click();
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: /editar cliente/i }).first().click();
  const emailInput = page.getByTestId("edit-client-email");
  await expect(emailInput).toBeVisible({ timeout: 10000 });
  return emailInput;
}

test.describe.serial("Editar cliente — correo hasta verificar, teléfono único y espejo en users", () => {
  let adminToken;
  let clientA; // alta por el taller (with-account), cuenta oculta SIN verificar
  let uidA;
  let clientB; // registro desde la app + afiliado, correo VERIFICADO

  test.beforeAll(async ({ request }) => {
    adminToken = (await authHeaders()).Authorization.replace("Bearer ", "");

    // A: alta completa desde el taller (cuenta oculta, sin verificar).
    const a = await api(request, adminToken, "post", "/clients/with-account", {
      fullName: A.name, email: A.email, phone: A.phone, createdBy: "spec", idWorkshop: ID_WORKSHOP,
    });
    expect(a.status, `with-account A: ${JSON.stringify(a.body)}`).toBe(201);
    clientA = a.data.client;
    uidA = a.data.uid ?? clientA.idUser;

    // B: cuenta creada desde la app (contraseña conocida) + cliente afiliado + correo verificado.
    const signup = await api(request, null, "post", "/public/signup", {
      name: "Cliente", firstSurname: `Verificado${s}`, email: B.email, phone: B.phone, password: B.password,
    });
    expect(signup.status, `signup B: ${JSON.stringify(signup.body)}`).toBe(201);
    const b = await api(request, adminToken, "post", "/clients/with-account", {
      fullName: B.name, email: B.email, phone: B.phone, createdBy: "spec", idWorkshop: ID_WORKSHOP,
    });
    expect(b.status, `with-account B: ${JSON.stringify(b.body)}`).toBe(201);
    clientB = b.data.client;
    const { idToken } = await signIn(request, B.email, B.password);
    await verifyEmailInEmulator(request, idToken, B.email);
  });

  test("1) GET /clients/:id expone el estado de la cuenta (hasAccount / emailVerified)", { tag: ["@api"] }, async ({ request }) => {
    const ga = await api(request, adminToken, "get", `/clients/${clientA.id}`);
    expect(ga.status).toBe(200);
    expect(ga.data.account).toEqual({ hasAccount: true, emailVerified: false });
    const gb = await api(request, adminToken, "get", `/clients/${clientB.id}`);
    expect(gb.data.account).toEqual({ hasAccount: true, emailVerified: true });
  });

  test("2) cuenta SIN verificar: cambiar el correo actualiza Auth, users y clients, y reenvía la activación", { tag: ["@api"] }, async ({ request }) => {
    const r = await api(request, adminToken, "put", `/clients/${clientA.id}`, {
      fullName: A.name, email: A.email2, phone: A.phone, idWorkshop: ID_WORKSHOP,
    });
    expect(r.status, `PUT correo nuevo: ${JSON.stringify(r.body)}`).toBe(200);
    expect(r.data.emailChanged).toBe(true);
    expect(r.data.email).toBe(A.email2);
    expect(r.data.account.emailVerified).toBe(false);
    expect(r.data).toHaveProperty("activationSent"); // true con Brevo; false en local sin correo

    // clients
    const g = await api(request, adminToken, "get", `/clients/${clientA.id}`);
    expect(g.data.email).toBe(A.email2);
    // users (doc de la cuenta)
    const u = await api(request, adminToken, "get", `/users/${uidA}`);
    expect(u.status, `GET users/${uidA}: ${JSON.stringify(u.body)}`).toBe(200);
    expect(u.data.email).toBe(A.email2);
    // lookup por el correo nuevo lo encuentra afiliado; por el viejo ya no existe
    const lk = await api(request, adminToken, "get", `/clients/lookup?email=${encodeURIComponent(A.email2)}&idWorkshop=${ID_WORKSHOP}`);
    expect(lk.data.exists).toBe(true);
    const old = await api(request, adminToken, "get", `/clients/lookup?email=${encodeURIComponent(A.email)}&idWorkshop=${ID_WORKSHOP}`);
    expect(old.data.exists).toBe(false);
    // Firebase Auth: el correo viejo ya no inicia sesión (la cuenta se movió).
    const auth = await request.post(`${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
      data: { email: A.email, password: "cualquiera123", returnSecureToken: true },
    });
    expect((await auth.json())?.error?.message).toBe("EMAIL_NOT_FOUND");
  });

  test("3) el correo nuevo no puede ser el de otra persona (409 CLIENT_EXISTS / EMAIL_TAKEN)", { tag: ["@api"] }, async ({ request }) => {
    const r = await api(request, adminToken, "put", `/clients/${clientA.id}`, { email: B.email });
    expect(r.status).toBe(409);
    expect(r.body?.data?.code).toBe("CLIENT_EXISTS");
    expect(r.body?.data?.reason).toBe("EMAIL_TAKEN");
    const g = await api(request, adminToken, "get", `/clients/${clientA.id}`);
    expect(g.data.email, "no cambió").toBe(A.email2);
  });

  test("4) cuenta VERIFICADA: el correo está bloqueado (409 EMAIL_LOCKED) y no cambia nada", { tag: ["@api"] }, async ({ request }) => {
    const r = await api(request, adminToken, "put", `/clients/${clientB.id}`, { email: B.email2 });
    expect(r.status).toBe(409);
    expect(r.body?.data?.code).toBe("EMAIL_LOCKED");
    const g = await api(request, adminToken, "get", `/clients/${clientB.id}`);
    expect(g.data.email).toBe(B.email);
    expect(g.data.account.emailVerified).toBe(true);
    // El mismo correo (sin cambio) sigue aceptándose junto con otros campos.
    const same = await api(request, adminToken, "put", `/clients/${clientB.id}`, { email: B.email, fullName: `${B.name} Ok` });
    expect(same.status).toBe(200);
    expect(same.data.emailChanged).toBe(false);
  });

  test("5) teléfono: duplicado → 409 PHONE_TAKEN; nuevo → clients y users", { tag: ["@api"] }, async ({ request }) => {
    const dup = await api(request, adminToken, "put", `/clients/${clientA.id}`, { phone: B.phone });
    expect(dup.status).toBe(409);
    expect(dup.body?.data?.reason).toBe("PHONE_TAKEN");

    const ok = await api(request, adminToken, "put", `/clients/${clientA.id}`, { phone: A.phone2 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.data.phoneChanged).toBe(true);
    const g = await api(request, adminToken, "get", `/clients/${clientA.id}`);
    expect(g.data.phone).toBe(A.phone2);
    const u = await api(request, adminToken, "get", `/users/${uidA}`);
    expect(u.data.phone, "espejo en users.phone").toBe(A.phone2);
    // El mismo teléfono de la propia persona no es conflicto.
    const same = await api(request, adminToken, "put", `/clients/${clientA.id}`, { phone: A.phone2, fullName: A.name });
    expect(same.status).toBe(200);
  });

  test("6) UI: verificado → correo solo lectura con leyenda; sin verificar → editable con aviso de reenvío", { tag: ["@ui"] }, async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);

    const emailB = await openEditModal(page, B.name);
    await expect(emailB).toHaveAttribute("readonly", "");
    await expect(page.getByTestId("edit-client-email-help")).toContainText(/ya activó su cuenta/i);

    const emailA = await openEditModal(page, A.name);
    await expect(emailA).not.toHaveAttribute("readonly", "");
    await expect(page.getByTestId("edit-client-email-help")).toContainText(/reenviamos la activación/i);
  });
});
