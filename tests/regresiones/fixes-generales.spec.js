const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * Fixes generales (rama fix/bugs-fixes-general):
 *   - #3/#10: agenda y entradas registran al asesor (createdBy/createdByName).
 *   - Validación de modales (junta): Nueva Cita abre limpia; al Guardar marca
 *     en rojo el campo exacto y el toast dice QUÉ falta.
 *   - #30/Q16: total visible en grande arriba de la cotización.
 *
 * PRERREQUISITOS:
 *   1) Emuladores:  cd ccc-backend && npm run serve
 *   2) Backend:     cd ccc-backend && npm run backend
 *   3) Frontend:    cd ccc-frontend && npm start        (para los tests de UI)
 *   4) Usuario:     cd ccc-testing && node seed_emulator_user.js
 */

const API = process.env.API || "http://localhost:3001/v1";
const AGENDA_API = process.env.AGENDA_API || "http://localhost:3001/agenda";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";
const EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const PASSWORD = process.env.SEED_PASSWORD || "prueba123";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function post(request, url, body) {
  const res = await request.post(url, { data: body, headers: await authHeaders() });
  if (!res.ok()) {
    throw new Error(`POST ${url} → ${res.status()}: ${await res.text()}`);
  }
  return res.json().catch(() => null);
}

async function getJson(request, url) {
  const res = await request.get(url, { headers: await authHeaders() });
  if (!res.ok()) {
    throw new Error(`GET ${url} → ${res.status()}: ${await res.text()}`);
  }
  return res.json().catch(() => null);
}

const dataOf = (j) => j?.data ?? j;
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

async function login(page) {
  await page.goto("/login");
  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page
    .waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 })
    .catch(() => {});
}

/** OS mínima con una cotización con precios (para el total en grande). */
async function createOsWithQuote(request) {
  const suffix = `${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
  const client = dataOf(
    await post(request, `${API}/clients`, {
      fullName: `Cliente FG ${suffix}`,
      email: `fg.${suffix}@test.com`,
      phone: `58${suffix}`,
      idWorkshop: ID_WORKSHOP,
      createdBy: MECHANIC_ID,
    }),
  );
  const car = dataOf(
    await post(request, `${API}/cars`, {
      clientId: idOf(client),
      brand: "Mazda",
      model: "3",
      year: 2022,
      vin: `FGVIN${suffix}00000000`.slice(0, 17),
      codeCar: `FG-${suffix.slice(-5)}`,
      color: "Azul",
      fuel: "Gasolina",
      transmition: "Manual",
      km: 20000,
    }),
  );
  const entry = dataOf(
    await post(request, `${API}/entries`, {
      idWorkshop: ID_WORKSHOP,
      clientId: idOf(client),
      carId: idOf(car),
      assigned_mechanic: MECHANIC_ID,
      status: 1,
      observations: "Fixture fixes generales",
      registerDate: Date.now(),
      approvalState: "EN ESPERA",
      createdBy: "asesor-prueba",
      createdByName: "Asesor Prueba",
    }),
  );
  const entryId = idOf(entry);
  const quote = dataOf(
    await post(request, `${API}/entries/${entryId}/quotes`, {
      diagnostic: "Cotización para total en grande",
      labor: [
        { description: "Mano de obra", count: 2, cost: 450, subtotal: 900 },
      ],
      parts: [
        { description: "Refacción", count: 1, cost: 350, subtotal: 350 },
      ],
      status: 2,
      stage: "COTIZACION",
    }),
  );
  return { entryId, quoteId: idOf(quote), total: 1250 };
}

// ── #3/#10: el asesor queda registrado ───────────────────────────────────────

test("#10: la entrada persiste createdBy/createdByName del asesor", { tag: ["@api"] }, async ({
  request,
}) => {
  const { entryId } = await createOsWithQuote(request);
  const entry = dataOf(await getJson(request, `${API}/entries/${entryId}`));
  expect(entry?.createdBy).toBe("asesor-prueba");
  expect(entry?.createdByName).toBe("Asesor Prueba");
});

test("#3: la cita de agenda persiste createdBy/createdByName del asesor", { tag: ["@api"] }, async ({
  request,
}) => {
  const marker = `Cita Q3-10 ${Date.now()}`;
  await post(request, `${AGENDA_API}/addevent`, {
    idWorkshop: ID_WORKSHOP,
    title: marker,
    description: "test",
    phone: "5512345678",
    start: new Date(Date.now() + 86400000), // mañana
    end: new Date(Date.now() + 86400000),
    allDay: false,
    createdBy: "asesor-prueba",
    createdByName: "Asesor Prueba",
  });

  const events = await getJson(
    request,
    `${AGENDA_API}/getevents?idw=${ID_WORKSHOP}`,
  );
  const created = (Array.isArray(events) ? events : []).find(
    (e) => e.title === marker,
  );
  expect(created).toBeTruthy();
  expect(created.createdBy).toBe("asesor-prueba");
  expect(created.createdByName).toBe("Asesor Prueba");
});

// ── Validación de modales (junta) ────────────────────────────────────────────

test("Agenda: Nueva Cita abre limpia y al Guardar señala qué falta (hora en rojo)", { tag: ["@ui"] }, async ({
  page,
}) => {
  await login(page);
  await page.goto("/agenda");

  // Abrir el modal de nueva cita.
  await page.getByRole("button", { name: /nueva cita|agendar/i }).first().click();
  await expect(page.getByText(/Nueva Cita/i)).toBeVisible();

  const phone = page.locator("#phone");
  const time = page.locator("#time");

  // Al abrir: SIN rojos (la validación no corre hasta Guardar).
  await expect(phone).not.toHaveClass(/border-red-300/);
  await expect(time).not.toHaveClass(/border-red-300/);

  // Llenar todo excepto la hora.
  await page.locator("#name").fill("Prueba Sa de Cv");
  await phone.fill("4235654765");
  // (la fecha viene precargada al abrir desde el calendario; si no, se llena)
  const dateVal = await page.locator("#date").inputValue();
  if (!dateVal) await page.locator("#date").fill("2027-01-15");

  await page.getByRole("button", { name: /guardar/i }).click();

  // Toast específico + campo hora en rojo.
  await expect(page.getByText(/Falta: hora\./i)).toBeVisible({ timeout: 10000 });
  await expect(time).toHaveClass(/border-red-300/);
  // Los campos llenos NO se marcan.
  await expect(phone).not.toHaveClass(/border-red-300/);
});

test("Agenda: no permite agendar en el pasado", { tag: ["@ui"] }, async ({ page }) => {
  await login(page);
  await page.goto("/agenda");

  await page.getByRole("button", { name: /nueva cita|agendar/i }).first().click();
  await page.locator("#name").fill("Prueba Pasado");
  await page.locator("#phone").fill("4235654765");
  await page.locator("#date").fill("2020-01-01");
  await page.locator("#time").fill("10:00");
  await page.getByRole("button", { name: /guardar/i }).click();

  await expect(
    page.getByText(/ya pasaron|horario futuro/i),
  ).toBeVisible({ timeout: 10000 });
});

// ── #30/Q16: total en grande arriba de la cotización ─────────────────────────

test("#30: la cotización muestra el Total en grande arriba", { tag: ["@ui"] }, async ({
  page,
  request,
}) => {
  const { entryId, quoteId } = await createOsWithQuote(request);

  await login(page);
  await page.goto(`/cotizacion-vista/${entryId}?quoteId=${quoteId}`);

  // El bloque del total (aparece antes que el diagnóstico técnico).
  const totalBlock = page
    .locator("div", { hasText: /^Total/ })
    .filter({ hasText: /\$\s?1,250/ })
    .first();
  await expect(totalBlock).toBeVisible({ timeout: 15000 });
});
