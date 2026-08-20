const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * Clientes v2 (Q32) — cliente sin cuenta + lookup exacto + signup público:
 *   - POST /clients crea SOLO el cliente (no aparece cuenta en users).
 *   - Duplicado ⇒ 409 enriquecido {code: CLIENT_EXISTS, clientId}.
 *   - /clients/lookup: coincidencia EXACTA enmascarada + afiliación.
 *   - /public/signup: crea SOLO la cuenta (no aparece cliente).
 *   - UI: el alta detecta al existente y ofrece AFILIAR (confirm) sin duplicar.
 *
 * PRERREQUISITOS: emuladores + backend + frontend (global-setup siembra admin).
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const ADMIN_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const ADMIN_PASSWORD = process.env.SEED_PASSWORD || "prueba123";

async function call(request, method, path, body, { allowFail = false } = {}) {
  // Q20: la API blindada exige el token firmado en CADA llamada.
  const res = await request[method](`${API}${path}`, { headers: await authHeaders(), ...(body ? { data: body } : {}) });
  if (!res.ok() && !allowFail) {
    throw new Error(`${method.toUpperCase()} ${path} → ${res.status()}: ${await res.text()}`);
  }
  const json = await res.json().catch(() => null);
  return { status: res.status(), data: json?.data ?? json, raw: json };
}
const post = (r, p, b, o) => call(r, "post", p, b, o);
const getJson = (r, p, o) => call(r, "get", p, undefined, o);

const suffix = () => `${String(Date.now()).slice(-7)}${Math.floor(Math.random() * 90 + 10)}`;

test("Q32 API: POST /clients crea SOLO el cliente (sin cuenta) y el duplicado responde 409 CLIENT_EXISTS", { tag: ["@api"] }, async ({
  request,
}) => {
  const s = suffix();
  const email = `solo.${s}@test.com`;

  const created = await post(request, "/clients", {
    fullName: `Cliente Solo ${s}`,
    email,
    phone: `71${s.slice(-8)}0000000000`.slice(0, 10),
    createdBy: "test",
  });
  expect(created.status).toBe(201);
  expect(created.data.id).toBeTruthy();
  expect(created.data.idUser ?? "").toBe(""); // sin cuenta ligada

  // No se creó NINGUNA cuenta en users.
  const user = await getJson(request, `/users/email/${encodeURIComponent(email)}`, {
    allowFail: true,
  });
  expect(user.status).toBe(404);

  // Duplicado → 409 enriquecido para que la UI ofrezca afiliar.
  const dup = await post(
    request,
    "/clients",
    { fullName: "Otro", email, phone: `72${s.slice(-8)}0000000000`.slice(0, 10), createdBy: "test" },
    { allowFail: true },
  );
  expect(dup.status).toBe(409);
  expect(dup.raw?.data?.code).toBe("CLIENT_EXISTS");
  expect(dup.raw?.data?.clientId).toBe(created.data.id);
});

test("Q32 API: lookup es EXACTO y enmascarado; la afiliación cambia affiliated", { tag: ["@api"] }, async ({
  request,
}) => {
  const s = suffix();
  const email = `look.${s}@test.com`;
  const phone = `73${s.slice(-8)}`;
  const created = await post(request, "/clients", {
    fullName: `Mariana Prueba ${s}`,
    email,
    phone,
    createdBy: "test",
  });

  // Email parcial NO encuentra nada (sin directorio estilo GitHub).
  const partial = (await getJson(request, `/clients/lookup?email=${encodeURIComponent(`look.${s}`)}`)).data;
  expect(partial.exists).toBe(false);

  // Email completo: enmascarado y sin afiliación todavía.
  let found = (await getJson(
    request,
    `/clients/lookup?email=${encodeURIComponent(email)}&idWorkshop=${ID_WORKSHOP}`,
  )).data;
  expect(found.exists).toBe(true);
  expect(found.clientId).toBe(created.data.id);
  expect(found.maskedName).toMatch(/^M\*+ P\*+/);
  expect(found.maskedName).not.toContain("Mariana");
  expect(found.maskedPhone).toBe(`****${phone.slice(-4)}`);
  expect(found.maskedEmail).toBe(`lo***@t***.com`);
  expect(found.maskedEmail).not.toContain(s);
  expect(found.affiliated).toBe(false);

  // También por teléfono completo.
  const byPhone = (await getJson(request, `/clients/lookup?phone=${phone}`)).data;
  expect(byPhone.exists).toBe(true);

  // Afiliación (token del taller) → affiliated true.
  await post(request, "/tokens", { idClient: created.data.id, idWorkshop: ID_WORKSHOP });
  found = (await getJson(
    request,
    `/clients/lookup?email=${encodeURIComponent(email)}&idWorkshop=${ID_WORKSHOP}`,
  )).data;
  expect(found.affiliated).toBe(true);
});

test("Q32 API: /public/signup crea SOLO la cuenta (sin cliente) y valida contraseña", { tag: ["@api"] }, async ({
  request,
}) => {
  const s = suffix();
  const email = `cuenta.${s}@test.com`;

  // Contraseña corta → 422.
  const weak = await post(
    request,
    "/public/signup",
    { name: "Cuenta", email, phone: `74${s.slice(-8)}0000000000`.slice(0, 10), password: "corta" },
    { allowFail: true },
  );
  expect(weak.status).toBe(422);

  const ok = await post(request, "/public/signup", {
    name: "Cuenta",
    firstSurname: "App",
    email,
    phone: `74${s.slice(-8)}0000000000`.slice(0, 10),
    password: "Segura_12345",
  });
  expect(ok.status).toBe(201);
  expect(ok.data.uid).toBeTruthy();

  // La cuenta existe…
  const user = await getJson(request, `/users/email/${encodeURIComponent(email)}`);
  expect(user.status).toBe(200);
  // …pero NO se creó ningún cliente.
  const look = (await getJson(request, `/clients/lookup?email=${encodeURIComponent(email)}`)).data;
  expect(look.exists).toBe(false);

  // Email repetido → rechazado.
  const dup = await post(
    request,
    "/public/signup",
    { name: "Cuenta", email, phone: `75${s.slice(-8)}0000000000`.slice(0, 10), password: "Segura_12345" },
    { allowFail: true },
  );
  expect(dup.status).toBeGreaterThanOrEqual(400);
});

test("Q32 UI: cancelar la afiliación NO guarda nada y permite corregir el cliente sin perder la captura", { tag: ["@ui"] }, async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const s = suffix();
  const email = `cancelar.${s}@test.com`;
  const phone = `77${s.slice(-8)}`;
  const placas = `CN${s.slice(-4)}`;
  // Cliente ya registrado (de otro taller / la app).
  const created = await post(request, "/clients", {
    fullName: `Cancelable ${s}`,
    email,
    phone,
    createdBy: "test",
  });

  await page.goto("/login");
  await page.locator("#email").fill(ADMIN_EMAIL);
  await page.locator("#password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });

  await page.goto("/registro");
  await page.getByRole("button", { name: /nueva entrada/i }).click();
  await page.getByRole("button", { name: /cliente y vehículo nuevo/i }).click();
  await expect(page).toHaveURL(/crear-cliente-vehiculo/);

  // Paso 1 con los datos del cliente EXISTENTE.
  await page.locator("#name").fill(`Cancelable ${s}`);
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
  await page.locator("#vin").fill(`CANCEL${s}00000`.slice(0, 17));
  await page.locator("#transmition").selectOption("Manual");
  await page.locator("#car-km").fill("21000");
  await page.locator("#car-fuel").selectOption("Gasolina");
  const mecInput = page.locator('input[id^="react-select"][id$="-input"]').first();
  await mecInput.click({ force: true });
  await mecInput.pressSequentially("Mecánico Prueba");
  await page.keyboard.press("Enter");
  await page.locator("#car-issue-desc").fill("Cancelación E2E.");
  await page.getByRole("button", { name: /^siguiente$/i }).click();

  // Paso 3 — hoja y "Registrar y continuar" → modal → CANCELAR.
  await expect(page.locator("#selectAll")).toBeVisible({ timeout: 15000 });
  await page.locator("#selectAll").check();
  const tank = page.locator('[data-entry-sheet-field="fuel_tank"]');
  if (await tank.count()) {
    await tank.getByText("1/2", { exact: true }).click();
  } else {
    await page.getByRole("button", { name: "1/2" }).first().click();
  }
  await page
    .getByRole("button", { name: /diagn[oó]stico\/fallas reportadas/i })
    .click();
  await page
    .locator("label", { has: page.locator('input[type="checkbox"]') })
    .filter({ hasText: /frenos|ruido/i })
    .first()
    .click();
  await page
    .getByPlaceholder(/describa los aspectos generales/i)
    .fill("Prueba de cancelación.");
  await page.getByRole("button", { name: /registrar y continuar/i }).click();

  const confirmModal = page.locator(".ant-modal-confirm");
  await expect(confirmModal.getByText(/ya está registrado/i)).toBeVisible({
    timeout: 15000,
  });
  await confirmModal.getByRole("button", { name: /cancelar/i }).click();

  // Aviso de que nada se guardó, y seguimos en el wizard (no hay Finalizar).
  await expect(
    page.locator("[data-sonner-toaster]").getByText(/no se guardó nada/i).first(),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByRole("button", { name: /registrar y continuar/i }),
  ).toBeVisible();

  // Verificación de fondo: NI afiliación NI OS creada.
  const look = (await getJson(
    request,
    `/clients/lookup?email=${encodeURIComponent(email)}&idWorkshop=${ID_WORKSHOP}`,
  )).data;
  expect(look.affiliated).toBe(false);
  const entradas = (await getJson(
    request,
    `/entries?idWorkshop=${ID_WORKSHOP}&search=${placas}`,
  )).data;
  expect((entradas?.entries ?? []).length).toBe(0);

  // Regresar al paso 1 (Atrás x2), corregir el email y terminar como nuevo.
  await page.getByRole("button", { name: /^atrás$/i }).click();
  await expect(page.locator("#codeCar")).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: /^atrás$/i }).click();
  await expect(page.locator("#email")).toBeVisible({ timeout: 15000 });
  const emailNuevo = `cancelar.nuevo.${s}@test.com`;
  const phoneNuevo = `78${s.slice(-8)}`;
  await page.locator("#email").fill(emailNuevo);
  await page.locator("#phone").fill(phoneNuevo);
  await page.getByRole("button", { name: /^siguiente$/i }).click();
  await expect(page.locator("#codeCar")).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: /^siguiente$/i }).click();
  await expect(page.locator("#selectAll")).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: /registrar y continuar/i }).click();

  // Con email y teléfono nuevos ya no hay coincidencia: registro directo.
  await expect(page.getByRole("button", { name: /finalizar/i })).toBeVisible({
    timeout: 30000,
  });

  // El nuevo cliente quedó creado y afiliado; el existente sigue SIN afiliar.
  const nuevo = (await getJson(
    request,
    `/clients/lookup?email=${encodeURIComponent(emailNuevo)}&idWorkshop=${ID_WORKSHOP}`,
  )).data;
  expect(nuevo.exists).toBe(true);
  expect(nuevo.affiliated).toBe(true);
  const original = (await getJson(
    request,
    `/clients/lookup?email=${encodeURIComponent(email)}&idWorkshop=${ID_WORKSHOP}`,
  )).data;
  expect(original.affiliated).toBe(false);
  expect(created.data.id).toBeTruthy();
});

test("Q32 UI: el alta detecta al cliente existente y lo AFILIA (confirm) sin duplicar", { tag: ["@ui"] }, async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const s = suffix();
  const email = `afiliar.${s}@test.com`;
  const phone = `76${s.slice(-8)}`;
  // Cliente ya registrado en el sistema (p. ej. por otro taller o la app).
  const created = await post(request, "/clients", {
    fullName: `Afiliable ${s}`,
    email,
    phone,
    createdBy: "test",
  });

  await page.goto("/login");
  await page.locator("#email").fill(ADMIN_EMAIL);
  await page.locator("#password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });

  await page.goto("/registro");
  await page.getByRole("button", { name: /nueva entrada/i }).click();
  await page.getByRole("button", { name: /cliente y vehículo nuevo/i }).click();
  await expect(page).toHaveURL(/crear-cliente-vehiculo/);

  // Paso 1 — cliente (mismos datos del existente).
  await page.locator("#name").fill(`Afiliable ${s}`);
  await page.locator("#phone").fill(phone);
  await page.locator("#email").fill(email);
  await page.getByRole("button", { name: /^siguiente$/i }).click();

  // Paso 2 — vehículo (selectores calcados de jornada-ui).
  await expect(page.locator("#codeCar")).toBeVisible({ timeout: 15000 });
  const brandInput = page.getByPlaceholder(/escribe o selecciona una marca/i);
  await brandInput.fill("Nissan");
  await page.getByRole("button", { name: /^Nissan$/ }).first().click();
  const modelInput = page.getByPlaceholder(/el modelo|modelo \(libre\)|primero elige/i);
  await modelInput.fill("March");
  await page.getByRole("button", { name: /^March$/ }).first().click();
  await page.locator("#year").fill("2020");
  const colorInput = page.getByPlaceholder(/escribe o selecciona un color/i);
  await colorInput.fill("Gris");
  await page.getByRole("button", { name: /^Gris$/ }).first().click();
  await page.locator("#codeCar").fill(`AF${s.slice(-4)}`);
  await page.locator("#vin").fill(`AFILIA${s}00000`.slice(0, 17));
  await page.locator("#transmition").selectOption("Manual");
  await page.locator("#car-km").fill("30000");
  await page.locator("#car-fuel").selectOption("Gasolina");
  const mecInput = page.locator('input[id^="react-select"][id$="-input"]').first();
  await mecInput.click({ force: true });
  await mecInput.pressSequentially("Mecánico Prueba");
  await page.keyboard.press("Enter");
  await page.locator("#car-issue-desc").fill("Afiliación E2E: cliente existente.");
  await page.getByRole("button", { name: /^siguiente$/i }).click();

  // Paso 3 — hoja de servicio; "Registrar y continuar" dispara el lookup+confirm.
  await expect(page.locator("#selectAll")).toBeVisible({ timeout: 15000 });
  await page.locator("#selectAll").check();
  const tank = page.locator('[data-entry-sheet-field="fuel_tank"]');
  if (await tank.count()) {
    await tank.getByText("1/2", { exact: true }).click();
  } else {
    await page.getByRole("button", { name: "1/2" }).first().click();
  }
  await page
    .getByRole("button", { name: /diagn[oó]stico\/fallas reportadas/i })
    .click();
  await page
    .locator("label", { has: page.locator('input[type="checkbox"]') })
    .filter({ hasText: /frenos|ruido/i })
    .first()
    .click();
  await page
    .getByPlaceholder(/describa los aspectos generales/i)
    .fill("Buen estado general.");
  await page.getByRole("button", { name: /registrar y continuar/i }).click();

  // Modal de afiliación (antd, ya no window.confirm): datos enmascarados.
  const confirmModal = page.locator(".ant-modal-confirm");
  await expect(
    confirmModal.getByText(/ya está registrado/i),
  ).toBeVisible({ timeout: 15000 });
  await expect(confirmModal.getByText(/\*\*\*/).first()).toBeVisible();
  await confirmModal
    .getByRole("button", { name: /afiliar y continuar/i })
    .click();

  // Termina el registro = afiliación aceptada y SIN duplicado.
  await expect(page.getByRole("button", { name: /finalizar/i })).toBeVisible({
    timeout: 30000,
  });

  // El cliente quedó AFILIADO al taller (token) y sigue siendo único.
  const found = (await getJson(
    request,
    `/clients/lookup?email=${encodeURIComponent(email)}&idWorkshop=${ID_WORKSHOP}`,
  )).data;
  expect(found.exists).toBe(true);
  expect(found.clientId).toBe(created.data.id);
  expect(found.affiliated).toBe(true);
});
