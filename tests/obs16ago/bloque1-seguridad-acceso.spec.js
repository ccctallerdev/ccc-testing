const { test, expect } = require("@playwright/test");
const {
  API,
  AUTH_EMU,
  PROJECT_ID,
  ID_WORKSHOP,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  stamp,
  idOf,
  post,
  getJson,
  api,
  tokenFor,
  makeEntry,
  makeApprovedOs,
  login,
} = require("./_helpers");

/**
 * Bloque 1 (25-ago) — seguridad y acceso:
 *   1) GET /users/email/:email solo devuelve el perfil PROPIO (o con
 *      CAN_MANAGE_USERS). Antes cualquier cuenta autenticada leía el doc
 *      `users` de cualquier correo.
 *   2) PUT /entries/:id ya no acepta `sheet`: el número de OS no se pisa con
 *      el provisional del wizard.
 *   3) El pedido automático al aprobar NO usa el precio al cliente como costo
 *      (C3 / PDF #39) para partidas de texto libre sin costo de proveedor.
 *   4) Una cuenta CLIENTE (app móvil) no entra al ERP web: se cierra su
 *      sesión con aviso y /configuracion la rebota al login.
 *   6) La página de verificación de correo (/acciones-cuenta?mode=verifyEmail)
 *      manda a la app, NO al login web: solo los clientes verifican correo.
 *   7) BACK: el token de un CLIENTE no puede consultar nada "por taller" en las
 *      rutas sin authorize (entries, cars, users, settings): 403. Sus rutas de
 *      la app (reminders?clientId, /v1/app) siguen abiertas.
 *
 * PRERREQUISITOS: emuladores + backend :3001 + frontend :3000 + seed.
 */

const s = stamp();
const PASSWORD = "Password_123";
const ASESOR = { email: `obs1.asesor.${s}@ccc.test`, phone: `5591${s}`.slice(0, 10) };
const CLIENTE = { email: `obs1.cliente.${s}@ccc.test`, phone: `5592${s}`.slice(0, 10) };

test.describe.serial("Bloque 1 — seguridad y acceso", () => {
  let ownerToken;
  let asesorToken;

  test.beforeAll(async ({ request }) => {
    ownerToken = await tokenFor(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await api(request, ownerToken, "post", "/users", {
      idWorkshop: ID_WORKSHOP,
      name: "Asesora",
      firstSurname: "Obs",
      email: ASESOR.email,
      password: PASSWORD,
      rol: "ASESOR",
      country: "México",
      phone: ASESOR.phone,
    });
    expect(res.status, `POST /users asesor → ${JSON.stringify(res.body)}`).toBeLessThan(300);
    asesorToken = await tokenFor(request, ASESOR.email, PASSWORD);
  });

  test("1) /users/email: el propio 200, el ajeno 403 sin CAN_MANAGE_USERS, 200 para el dueño", { tag: ["@api"] }, async ({ request }) => {
    const own = await api(request, asesorToken, "get", `/users/email/${encodeURIComponent(ASESOR.email)}`);
    expect(own.status, "el asesor lee SU perfil").toBe(200);
    expect(own.data?.email).toBe(ASESOR.email);

    // Mayúsculas en la URL: se normaliza y sigue siendo "propio".
    const ownUpper = await api(request, asesorToken, "get", `/users/email/${encodeURIComponent(ASESOR.email.toUpperCase())}`);
    expect(ownUpper.status).toBe(200);

    const ajeno = await api(request, asesorToken, "get", `/users/email/${encodeURIComponent(ADMIN_EMAIL)}`);
    expect(ajeno.status, "el asesor NO lee el perfil del dueño").toBe(403);
    expect(JSON.stringify(ajeno.body)).not.toContain("idWorkshop");

    const owner = await api(request, ownerToken, "get", `/users/email/${encodeURIComponent(ASESOR.email)}`);
    expect(owner.status, "el dueño (CAN_MANAGE_USERS) sí lee al asesor").toBe(200);
  });

  test("2) PUT /entries/:id ignora `sheet`: el número de OS no se pisa", { tag: ["@api"] }, async ({ request }) => {
    const e = await makeEntry(request, { tag: "SHT" });
    expect(e.os, "la OS nace numerada por el backend").not.toBe("");

    const res = await api(request, ownerToken, "put", `/entries/${e.entryId}`, {
      observations: "cambio desde la hoja",
      sheet: "999999",
    });
    expect(res.status, `PUT con sheet → ${JSON.stringify(res.body)}`).toBeLessThan(300);

    const after = await getJson(request, `/entries/${e.entryId}`);
    expect(String(after?.sheet), "sheet intacto").toBe(e.os);
    expect(after?.observations).toBe("cambio desde la hoja");
  });

  test("3) C3: el pedido automático de una partida de texto libre sin costo de proveedor nace en 0, no con el precio al cliente", { tag: ["@api"] }, async ({ request }) => {
    const os = await makeApprovedOs(request, { tag: "CST" });
    const list = await getJson(request, `/purchase-orders?idWorkshop=${ID_WORKSHOP}&scope=all`);
    const orders = (list?.orders ?? []).filter((o) => o.entryId === os.entryId && o.origin !== "INVENTORY");
    expect(orders.length, "se generó la orden automática de la OS").toBeGreaterThan(0);
    const item = orders.flatMap((o) => o.items || []).find((it) => it.description === os.partName);
    expect(item, "la partida de la cotización está en el pedido").toBeTruthy();
    expect(Number(item.unitCost), "costo del pedido ≠ precio al cliente (1450)").toBe(0);
  });

  test("4) una cuenta CLIENTE no entra al ERP web: aviso + sesión cerrada + /configuracion rebota", { tag: ["@ui", "@api"] }, async ({ page, request }) => {
    // Cuenta de app (rol CLIENTE) por la ruta pública, con contraseña conocida.
    const signup = await api(request, null, "post", "/public/signup", {
      name: "Cliente",
      firstSurname: "Web",
      email: CLIENTE.email,
      phone: CLIENTE.phone,
      password: PASSWORD,
    });
    expect(signup.status, `signup → ${JSON.stringify(signup.body)}`).toBe(201);

    await page.goto("/login");
    await page.locator("#email").fill(CLIENTE.email);
    await page.locator("#password").fill(PASSWORD);
    await page.getByRole("button", { name: /iniciar sesión/i }).click();

    // Aviso claro y NO entra a ninguna pantalla del taller.
    await expect(page.getByText(/app móvil de control central car/i).first()).toBeVisible({ timeout: 20000 });
    await expect(page).toHaveURL(/\/login/, { timeout: 20000 });
    await expect(page.locator("aside")).toHaveCount(0);

    // Tecleando la URL tampoco: sin sesión → login.
    await page.goto("/configuracion");
    await expect(page).toHaveURL(/\/login/, { timeout: 20000 });
    await expect(page.getByText(/modelo operativo/i)).toHaveCount(0);
  });

  test("5) el personal sí entra y Configuración muestra Modelo Operativo solo con capability + taller", { tag: ["@ui"] }, async ({ page }) => {
    await login(page);
    await page.goto("/configuracion");
    await expect(page.getByText(/modelo operativo/i).first()).toBeVisible({ timeout: 20000 });
  });

  test("6) al verificar el correo desde el enlace, la página manda a la app y no al login web", { tag: ["@ui", "@api"] }, async ({ page, request }) => {
    // Código de verificación real del emulador para la cuenta CLIENTE del caso 4.
    const idToken = await tokenFor(request, CLIENTE.email, PASSWORD);
    const send = await request.post(
      `${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=fake`,
      { data: { requestType: "VERIFY_EMAIL", idToken } },
    );
    expect(send.ok(), `sendOobCode → ${send.status()}`).toBe(true);
    const codesRes = await request.get(`${AUTH_EMU}/emulator/v1/projects/${PROJECT_ID}/oobCodes`);
    const { oobCodes = [] } = await codesRes.json();
    const mine = [...oobCodes].reverse().find((c) => c.email === CLIENTE.email && c.requestType === "VERIFY_EMAIL");
    expect(mine?.oobCode, "oobCode VERIFY_EMAIL en el emulador").toBeTruthy();

    await page.goto(`/acciones-cuenta?mode=verifyEmail&oobCode=${encodeURIComponent(mine.oobCode)}`);
    await expect(page.getByText(/tu correo quedó verificado/i)).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/abre la app control central car/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /descargar la app/i })).toBeVisible();
    // Nunca al ERP: sin enlace al login web.
    await expect(page.getByRole("link", { name: /inicio de sesión/i })).toHaveCount(0);

    // Y el correo quedó verificado de verdad (el gate de /v1/app lo exige).
    const fresh = await tokenFor(request, CLIENTE.email, PASSWORD);
    const me = await api(request, fresh, "get", "/app/me");
    expect(me.status, "ya no es 403 'Correo sin verificar'").not.toBe(403);
  });

  test("7) BACK: el token de un CLIENTE no lista datos de ningún taller (403), pero sus rutas de la app siguen", { tag: ["@api"] }, async ({ request }) => {
    const clienteToken = await tokenFor(request, CLIENTE.email, PASSWORD);
    // Rutas del ERP sin authorize, consultadas "por taller": antes pasaban en modo suave.
    for (const path of [
      `/entries?idWorkshop=${ID_WORKSHOP}`,
      `/cars?idWorkshop=${ID_WORKSHOP}`,
      `/users?idWorkshop=${ID_WORKSHOP}`,
      `/settings/operating-model?idWorkshop=${ID_WORKSHOP}`,
      `/followups?idWorkshop=${ID_WORKSHOP}`,
    ]) {
      const res = await api(request, clienteToken, "get", path);
      expect(res.status, `${path} con token de cliente`).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain("taller-prueba-b"); // ni rastro de datos
    }
    // Y también por header/body, no solo por query.
    const viaHeader = await request.get(`${API}/entries`, {
      headers: { Authorization: `Bearer ${clienteToken}`, "x-workshop-id": ID_WORKSHOP },
    });
    expect(viaHeader.status()).toBe(403);
    // Módulos gateados por capability: 403 de siempre (fail-closed).
    const sup = await api(request, clienteToken, "get", `/suppliers?idWorkshop=${ID_WORKSHOP}`);
    expect(sup.status).toBe(403);
    // Lo suyo sigue vivo: recordatorios por cliente (sin idWorkshop) y /v1/app.
    const rem = await api(request, clienteToken, "get", "/reminders?clientId=nadie");
    expect(rem.status, "ruta de la app sin idWorkshop no se bloquea").not.toBe(403);
    // /v1/app no lleva verifyWorkshopAccess: el gate de cliente responde lo
    // suyo (esta cuenta no tiene cliente ligado → "Cuenta sin cliente
    // vinculado"), nunca el 403 nuevo "API del personal del taller".
    const tokens = await api(request, clienteToken, "get", "/app/tokens");
    expect(JSON.stringify(tokens.body)).not.toContain("personal del taller");
    const me = await api(request, clienteToken, "get", "/app/me");
    expect(me.status, "/app/me sigue respondiendo al cliente").not.toBe(403);
  });
});
