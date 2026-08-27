const { test, expect } = require("@playwright/test");
const { db: qaDb, auth: qaAuthAdmin, oobCodeFor } = require("../../qaAdmin");
const { apiKeyPublica } = require("../../qaAuth");

/**
 * ─────────────────────────────────────────────────────────────────────────
 * COPIA PARA QA — el original en tests/comercial/ NO se toca.
 *
 * Mismo test, mismas aserciones; solo cambia lo que estaba atado a los
 * emuladores:
 *   · signIn / resetPassword  → identitytoolkit REAL con la API key web
 *   · oobCode del buzón falso → generado con el Admin SDK (qaAdmin)
 *   · Firestore del emulador  → Firestore de refac con el serviceAccountKey
 *
 * ⚠️ El oobCode lo genera el test, no viene del correo de Brevo: se prueba
 * que la activación funciona, no que el enlace del correo sea el correcto.
 *
 * Requiere ID_WORKSHOP (un taller real de refac) y el serviceAccountKey en
 * ccc-backend/functions/ (o SERVICE_ACCOUNT_KEY).
 * ─────────────────────────────────────────────────────────────────────────
 */
const { authHeaders } = require("#apiToken");

/**
 * Clientes v2 — CANCELAR EL REGISTRO DE ENTRADA (22-ago):
 *
 *   - Cliente CREADO en ese registro → se deshace el alta por completo:
 *     borrado FÍSICO de `clients`, `tokens`, `users` y la cuenta de Auth
 *     (POST /clients/:id/undo-alta). Nada queda que estorbe si la persona
 *     luego se registra desde la app o el taller la vuelve a capturar.
 *   - Cliente que YA EXISTÍA (se afilió) → NO se borra: solo se desafilia.
 *   - Candados del undo: si el cliente tiene autos/entradas, otra
 *     afiliación viva, o su cuenta ya fue ACTIVADA (alguien real la usa),
 *     undone=false con `reason` y no se toca nada → el front solo desafilia.
 *
 * PRERREQUISITOS: emuladores + backend + frontend (global-setup siembra admin).
 */

const API = process.env.API || "http://localhost:3001/v1";
const PROJECT_ID = process.env.EMU_PROJECT_ID || "ccc-taller-refac";
const ID_WORKSHOP = process.env.ID_WORKSHOP;
if (!ID_WORKSHOP) {
  throw new Error(
    "Falta ID_WORKSHOP: estos gemelos corren contra un taller REAL de refac.\n" +
      'Ejemplo: $env:ID_WORKSHOP="05Pf5VZ7IGCbi6JA8ObU"',
  );
}
const ID_WORKSHOP_B = process.env.ID_WORKSHOP_B || "taller-prueba-b";
const ADMIN_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const ADMIN_PASSWORD = process.env.SEED_PASSWORD || "prueba123";

const suffix = () => `${String(Date.now()).slice(-7)}${Math.floor(Math.random() * 90 + 10)}`;

async function call(request, method, path, body, extraHeaders = {}) {
  const res = await request[method](`${API}${path}`, {
    headers: { ...(await authHeaders()), ...extraHeaders },
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), data: json?.data ?? json, raw: json };
}
const post = (r, p, b, h) => call(r, "post", p, b, h);
const getJson = (r, p) => call(r, "get", p);

const altaWeb = (request, { fullName, email, phone }) =>
  post(request, "/clients/with-account", {
    fullName, email, phone, createdBy: "spec", idWorkshop: ID_WORKSHOP,
  });

const undo = (request, clientId) =>
  post(request, `/clients/${clientId}/undo-alta`, { idWorkshop: ID_WORKSHOP });

/** Qué queda de una persona: expediente, afiliación, cuenta. */
async function rastro(request, email, clientId) {
  const cliente = await getJson(request, `/clients/${clientId}`);
  const porCorreo = await getJson(request, `/clients/email/${encodeURIComponent(email)}`);
  const cuenta = await getJson(request, `/users/email/${encodeURIComponent(email)}`);
  const look = (await getJson(request, `/clients/lookup?email=${encodeURIComponent(email)}&idWorkshop=${ID_WORKSHOP}`)).data;
  return {
    clientDoc: cliente.status === 200,
    clientPorCorreo: porCorreo.status === 200,
    cuenta: cuenta.status === 200,
    afiliado: Boolean(look?.affiliated),
    lookupExists: Boolean(look?.exists),
  };
}

/** Firestore de refac por Admin SDK (para sembrar lo que la API no deja). */
function emuDb() {
  return qaDb();
}

/** oobCode de PASSWORD_RESET — generado con el Admin SDK (no hay buzón falso). */
async function lastResetCode(request, email) {
  return oobCodeFor(email);
}

test.describe("Cancelar entrada — deshacer alta vs. solo desafiliar", () => {
  test("1) API: cliente recién creado → undo-alta borra expediente, afiliación y cuenta; el correo y el teléfono quedan LIBRES", { tag: ["@api"] }, async ({ request }) => {
    const s = suffix();
    const email = `undo.nuevo.${s}@ccc.test`;
    const phone = `61${s.slice(-8)}`;

    const alta = await altaWeb(request, { fullName: `Undo Nuevo ${s}`, email, phone });
    expect(alta.status, JSON.stringify(alta.raw)).toBe(201);
    expect(alta.data.accountCreated).toBe(true);
    const clientId = alta.data.client.id;

    const antes = await rastro(request, email, clientId);
    expect(antes).toEqual({ clientDoc: true, clientPorCorreo: true, cuenta: true, afiliado: true, lookupExists: true });

    const r = await undo(request, clientId);
    expect(r.status, JSON.stringify(r.raw)).toBe(200);
    expect(r.data.undone).toBe(true);
    expect(r.data.deleted).toMatchObject({ clientId, tokens: 1, userDoc: true, authUser: true });

    const despues = await rastro(request, email, clientId);
    expect(despues).toEqual({ clientDoc: false, clientPorCorreo: false, cuenta: false, afiliado: false, lookupExists: false });

    // Sin rastro: la persona puede registrarse desde la app con ESE correo y
    // ESE teléfono (antes chocaba con la cuenta huérfana).
    const signup = await request.post(`${API}/public/signup`, {
      data: { country: "MX", name: "Undo", firstSurname: "Nuevo", secondSurname: "", email, phone, password: "ClaveSegura123!" },
      headers: { "x-forwarded-for": `10.33.${s.slice(0, 2)}.1` },
    });
    expect(signup.status(), await signup.text()).toBe(201);

    // Repetir el undo es idempotente (ya no hay nada).
    const otraVez = await undo(request, clientId);
    expect(otraVez.status).toBe(200);
    expect(otraVez.data.undone).toBe(true);
    expect(otraVez.data.reason).toBe("NO_CLIENT");
  });

  test("2) API: candado HAS_CARS — con un auto ligado el undo NO borra nada", { tag: ["@api"] }, async ({ request }) => {
    const s = suffix();
    const email = `undo.auto.${s}@ccc.test`;
    const alta = await altaWeb(request, { fullName: `Undo Auto ${s}`, email, phone: `62${s.slice(-8)}` });
    expect(alta.status).toBe(201);
    const clientId = alta.data.client.id;

    const car = await post(request, "/cars", {
      clientId, brand: "Nissan", model: "March", year: 2019, color: "Rojo",
      codeCar: `UA${s.slice(-4)}`, vin: `UNDOCAR${s}000000000`.slice(0, 17),
      transmition: "Manual", km: 1000, fuel: "Gasolina", idWorkshop: ID_WORKSHOP,
    });
    expect(car.status, JSON.stringify(car.raw)).toBeLessThan(300);

    const r = await undo(request, clientId);
    expect(r.status).toBe(200);
    expect(r.data.undone).toBe(false);
    expect(r.data.reason).toBe("HAS_CARS");
    const queda = await rastro(request, email, clientId);
    expect(queda).toMatchObject({ clientDoc: true, cuenta: true, afiliado: true });
  });

  test("3) API: candado ACCOUNT_ACTIVE — cuenta ya activada: no se borra; solo procede desafiliar (token)", { tag: ["@api"] }, async ({ request }) => {
    const s = suffix();
    const email = `undo.activa.${s}@ccc.test`;
    const alta = await altaWeb(request, { fullName: `Undo Activa ${s}`, email, phone: `63${s.slice(-8)}` });
    expect(alta.status).toBe(201);
    const clientId = alta.data.client.id;
    const tokenId = alta.data.tokenId;

    // La persona ACTIVA su cuenta (mismo camino que /acciones-cuenta).
    await request.post(`${API}/public/resend-activation`, {
      data: { email }, headers: { "x-forwarded-for": `10.33.${s.slice(0, 2)}.2` },
    });
    const code = await lastResetCode(request, email);
    expect(code, "oobCode PASSWORD_RESET del emulador").toBeTruthy();
    const reset = await request.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=${apiKeyPublica()}`,
      { data: { oobCode: code, newPassword: "MiClave123!" } },
    );
    expect(reset.ok(), await reset.text()).toBe(true);

    const r = await undo(request, clientId);
    expect(r.status).toBe(200);
    expect(r.data.undone).toBe(false);
    expect(r.data.reason).toBe("ACCOUNT_ACTIVE");
    expect(await rastro(request, email, clientId)).toMatchObject({ clientDoc: true, cuenta: true, afiliado: true });

    // Lo que sí procede: quitar la afiliación. El expediente y la cuenta viven.
    const del = await call(request, "delete", `/tokens/${tokenId}`);
    expect(del.status).toBeLessThan(300);
    expect(await rastro(request, email, clientId)).toMatchObject({ clientDoc: true, cuenta: true, afiliado: false });
  });

  test("4) API: cliente que YA existía (sin cuenta, p. ej. de otro taller) → el front solo desafilia; undo ni siquiera aplica", { tag: ["@api"] }, async ({ request }) => {
    const s = suffix();
    const email = `undo.existia.${s}@ccc.test`;
    const phone = `64${s.slice(-8)}`;
    const creado = await post(request, "/clients", { fullName: `Undo Existia ${s}`, email, phone, createdBy: "spec", idWorkshop: ID_WORKSHOP });
    expect(creado.status, JSON.stringify(creado.raw)).toBe(201);
    const clientId = creado.data.id;

    // Lo afilia el taller por el alta (camino que usa la entrada al confirmar).
    const afil = await altaWeb(request, { fullName: `Undo Existia ${s}`, email, phone });
    expect(afil.status).toBe(201);
    expect(afil.data.clientCreated).toBe(false);
    expect(afil.data.client.id).toBe(clientId);

    // Desafiliar = quitar token; el cliente global sobrevive.
    const del = await call(request, "delete", `/tokens/${afil.data.tokenId}`);
    expect(del.status).toBeLessThan(300);
    expect(await rastro(request, email, clientId)).toMatchObject({ clientDoc: true, afiliado: false });
  });

  test("6) API: candado OTHER_WORKSHOPS — un taller NO deshace el alta de un cliente afiliado también a otro taller", { tag: ["@api", "@seguridad"] }, async ({ request }) => {
    const s = suffix();
    const email = `undo.otro.${s}@ccc.test`;
    const alta = await altaWeb(request, { fullName: `Undo Otro ${s}`, email, phone: `66${s.slice(-8)}` });
    expect(alta.status).toBe(201);
    const clientId = alta.data.client.id;

    // Afiliación viva en el taller B, sembrada directo (la API la bloquea por
    // aislamiento — justo lo que un taller A no debería poder saltarse).
    const db = emuDb();
    const tokB = db.collection("tokens").doc();
    await tokB.set({
      token: `B${s}`.slice(0, 6).toUpperCase(),
      idClient: clientId,
      idWorkshop: ID_WORKSHOP_B,
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const r = await undo(request, clientId);
    expect(r.status).toBe(200);
    expect(r.data.undone).toBe(false);
    expect(r.data.reason).toBe("OTHER_WORKSHOPS");
    expect(await rastro(request, email, clientId)).toMatchObject({ clientDoc: true, cuenta: true, afiliado: true });
    expect((await tokB.get()).exists, "la afiliación del taller B sigue intacta").toBe(true);

    // Sin la afiliación ajena, el mismo undo SÍ procede (el candado era el único motivo).
    await tokB.delete();
    const r2 = await undo(request, clientId);
    expect(r2.data.undone).toBe(true);
  });

  test("7) API: candado ACCOUNT_ACTIVE por rol — un `clients` ligado a una cuenta del PERSONAL no borra esa cuenta", { tag: ["@api", "@seguridad"] }, async ({ request }) => {
    const s = suffix();
    const email = `undo.staff.${s}@ccc.test`;
    const db = emuDb();
    const uid = `staff-undo-${s}`;
    const userRef = db.collection("users").doc(uid);
    await userRef.set({
      uid, email, name: "Staff", firstSurname: "Undo", secondSurname: "",
      phone: `67${s.slice(-8)}`, rol: "ADMIN", idWorkshop: ID_WORKSHOP, country: "México",
      photoURL: "", isDeleted: false, createdAt: new Date(), updatedAt: new Date(),
    });
    const clientRef = db.collection("clients").doc();
    await clientRef.set({
      fullName: `Staff Undo ${s}`, email, phone: `67${s.slice(-8)}`, country: "México",
      createdBy: "spec", idUser: uid, isDeleted: false, createdAt: new Date(), updatedAt: new Date(),
    });

    const r = await undo(request, clientRef.id);
    expect(r.status).toBe(200);
    expect(r.data.undone).toBe(false);
    expect(r.data.reason).toBe("ACCOUNT_ACTIVE");
    expect((await userRef.get()).exists, "la cuenta del personal sigue").toBe(true);
    expect((await clientRef.get()).exists).toBe(true);

    await clientRef.delete();
    await userRef.delete();
  });

  test("8) API: candado USER_MISMATCH — un `clients` cuyo idUser apunta a la cuenta de OTRA persona no borra esa cuenta", { tag: ["@api", "@seguridad"] }, async ({ request }) => {
    const s = suffix();
    const db = emuDb();
    // Víctima: cuenta CLIENTE de otra persona (sin Auth: basta el doc).
    const victimUid = `victima-undo-${s}`;
    const victimRef = db.collection("users").doc(victimUid);
    await victimRef.set({
      uid: victimUid, email: `victima.${s}@ccc.test`, name: "Victima", firstSurname: "Undo",
      secondSurname: "", phone: `68${s.slice(-8)}`, rol: "CLIENTE", country: "México",
      photoURL: "", isDeleted: false, createdAt: new Date(), updatedAt: new Date(),
    });
    // Cliente con OTRO correo que apunta (mal) a esa cuenta.
    const clientRef = db.collection("clients").doc();
    await clientRef.set({
      fullName: `Impostor ${s}`, email: `impostor.${s}@ccc.test`, phone: `69${s.slice(-8)}`,
      country: "México", createdBy: "spec", idUser: victimUid, isDeleted: false,
      createdAt: new Date(), updatedAt: new Date(),
    });

    const r = await undo(request, clientRef.id);
    expect(r.status).toBe(200);
    expect(r.data.undone).toBe(false);
    expect(r.data.reason).toBe("USER_MISMATCH");
    expect((await victimRef.get()).exists, "la cuenta ajena sigue").toBe(true);
    expect((await clientRef.get()).exists).toBe(true);

    await clientRef.delete();
    await victimRef.delete();
  });

  test("5) UI: registrar cliente NUEVO + vehículo + hoja y CANCELAR → no queda rastro en clients, users ni afiliación", { tag: ["@ui", "@lento"] }, async ({ page, request }) => {
    test.setTimeout(180_000);
    const s = suffix();
    const email = `undo.ui.${s}@ccc.test`;
    const phone = `65${s.slice(-8)}`;
    const placas = `UN${s.slice(-4)}`;

    await page.goto("/login");
    await page.locator("#email").fill(ADMIN_EMAIL);
    await page.locator("#password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /iniciar sesión/i }).click();
    await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });

    await page.goto("/registro");
    await page.getByRole("button", { name: /nueva entrada/i }).click();
    await page.getByRole("button", { name: /cliente y vehículo nuevo/i }).click();
    await expect(page).toHaveURL(/crear-cliente-vehiculo/);

    // Paso 1 — cliente nuevo.
    await page.locator("#name").fill(`Undo UI ${s}`);
    await page.locator("#phone").fill(phone);
    await page.locator("#email").fill(email);
    await page.getByRole("button", { name: /^siguiente$/i }).click();

    // Paso 2 — vehículo.
    await expect(page.locator("#codeCar")).toBeVisible({ timeout: 15000 });
    const brandInput = page.getByPlaceholder(/escribe o selecciona una marca/i);
    await brandInput.fill("Nissan");
    await page.getByRole("button", { name: /^Nissan$/ }).first().click();
    const modelInput = page.getByPlaceholder(/el modelo|modelo \(libre\)|primero elige/i);
    await modelInput.fill("March");
    await page.getByRole("button", { name: /^March$/ }).first().click();
    await page.locator("#year").fill("2019");
    const colorInput = page.getByPlaceholder(/escribe o selecciona un color/i);
    await colorInput.fill("Rojo");
    await page.getByRole("button", { name: /^Rojo$/ }).first().click();
    await page.locator("#codeCar").fill(placas);
    await page.locator("#vin").fill(`UNDOUI${s}00000`.slice(0, 17));
    await page.locator("#transmition").selectOption("Manual");
    await page.locator("#car-km").fill("21000");
    await page.locator("#car-fuel").selectOption("Gasolina");
    const mecInput = page.locator('input[id^="react-select"][id$="-input"]').first();
    await mecInput.click({ force: true });
    await mecInput.pressSequentially("Mecánico Prueba");
    await page.keyboard.press("Enter");
    await page.locator("#car-issue-desc").fill("Cancelación E2E (undo).");
    await page.getByRole("button", { name: /^siguiente$/i }).click();

    // Paso 3 — hoja y registrar.
    await expect(page.locator("#selectAll")).toBeVisible({ timeout: 15000 });
    await page.locator("#selectAll").check();
    const tank = page.locator('[data-entry-sheet-field="fuel_tank"]');
    if (await tank.count()) {
      await tank.getByText("1/2", { exact: true }).click();
    } else {
      await page.getByRole("button", { name: "1/2" }).first().click();
    }
    await page.getByRole("button", { name: /diagn[oó]stico\/fallas reportadas/i }).click();
    await page
      .locator("label", { has: page.locator('input[type="checkbox"]') })
      .filter({ hasText: /frenos|ruido/i })
      .first()
      .click();
    await page.getByPlaceholder(/describa los aspectos generales/i).fill("Prueba de undo.");
    await page.getByRole("button", { name: /registrar y continuar/i }).click();
    await expect(page.getByRole("button", { name: /finalizar/i })).toBeVisible({ timeout: 30000 });

    // Ya existe todo en el servidor.
    const look = (await getJson(request, `/clients/lookup?email=${encodeURIComponent(email)}&idWorkshop=${ID_WORKSHOP}`)).data;
    expect(look.exists).toBe(true);
    expect(look.affiliated).toBe(true);
    const clientId = look.clientId;
    expect(clientId).toBeTruthy();

    // El paso final ("Finalizar") no muestra Cancelar: el asesor regresa con
    // "Atrás" al paso 3 (entrada ya registrada) y ahí cancela.
    await page.getByRole("button", { name: /^atrás$/i }).click();
    await expect(page.locator("#selectAll")).toBeVisible({ timeout: 15000 });

    // CANCELAR → confirmar.
    await page.getByRole("button", { name: /^cancelar$/i }).click();
    await expect(page.getByText(/cancelar este registro/i)).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: /sí, cancelar y eliminar/i }).click();
    await expect(
      page.locator("[data-sonner-toaster]").getByText(/registro cancelado/i).first(),
    ).toBeVisible({ timeout: 20000 });
    await expect(page).toHaveURL(/elegir-vehiculo/, { timeout: 15000 });

    // Sin rastro: ni expediente, ni afiliación, ni cuenta; ni entrada con esas placas.
    expect(await rastro(request, email, clientId)).toEqual({
      clientDoc: false, clientPorCorreo: false, cuenta: false, afiliado: false, lookupExists: false,
    });
    const entradas = (await getJson(request, `/entries?idWorkshop=${ID_WORKSHOP}&search=${placas}`)).data;
    expect((entradas?.entries ?? []).length).toBe(0);
  });
});
