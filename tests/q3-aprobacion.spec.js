const { test, expect } = require("@playwright/test");
const { authHeaders } = require("../apiToken");

/**
 * Q3 (Documento Unificado): flujo de aprobación de cotización.
 *   - 1 cotización real  → "Aprobada" aprueba directo (selección oficial automática).
 *   - 2+ cotizaciones    → redirige a /entrada-seleccion/:id.
 *   - Solo costeo        → aviso: falta cotización con precios; no aprueba.
 *
 * PRERREQUISITOS (igual que flujo-costeo.spec.js):
 *   1) Emuladores:  cd ccc-backend && npm run serve
 *   2) Backend:     cd ccc-backend && npm run backend
 *   3) Frontend:    cd ccc-frontend && npm start
 *   4) Usuario:     cd ccc-testing && node seed_emulator_user.js
 *
 * Cada test crea su PROPIA OS por API (cliente + auto + entrada + hoja +
 * cotizaciones), así que no depende de seed_prueba_e2e.js ni del estado previo.
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";
const EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const PASSWORD = process.env.SEED_PASSWORD || "prueba123";

// ── Helpers de API ───────────────────────────────────────────────────────────

async function post(request, path, body) {
  const res = await request.post(`${API}${path}`, { data: body, headers: await authHeaders() });
  if (!res.ok()) {
    throw new Error(`POST ${path} → ${res.status()}: ${await res.text()}`);
  }
  const json = await res.json().catch(() => null);
  return json?.data ?? json;
}

async function getJson(request, path) {
  const res = await request.get(`${API}${path}`, { headers: await authHeaders() });
  if (!res.ok()) {
    throw new Error(`GET ${path} → ${res.status()}: ${await res.text()}`);
  }
  const json = await res.json().catch(() => null);
  return json?.data ?? json;
}

const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

/** Cotización real (con precios) — stage COTIZACION, como las de la app. */
function pricedQuote(n) {
  return {
    diagnostic: `Cotización de prueba #${n}`,
    labor: [
      { description: `Mano de obra ${n}`, count: 1, cost: 800, subtotal: 800 },
    ],
    parts: [],
    status: 2,
    stage: "COTIZACION",
  };
}

/** Borrador de Costeo (sin precios) — CORE #18; no debe poder aprobarse. */
function costeoQuote() {
  return {
    diagnostic: "Costeo de prueba (sin precios)",
    labor: [
      { description: "Trabajo por cotizar", count: 1, cost: "", subtotal: 0 },
    ],
    parts: [],
    status: 2,
    stage: "COSTEO",
  };
}

/**
 * Crea una OS lista para aprobar: cliente + auto + entrada + hoja de servicio
 * + las cotizaciones indicadas. Devuelve { entryId, os }.
 */
async function createOsFixture(request, quotes) {
  const suffix = `${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;

  const client = await post(request, "/clients", {
    fullName: `Cliente Q3 ${suffix}`,
    email: `q3.${suffix}@test.com`,
    phone: `55${suffix}`,
    idWorkshop: ID_WORKSHOP,
    createdBy: MECHANIC_ID,
  });
  const clientId = idOf(client);

  const car = await post(request, "/cars", {
    clientId,
    brand: "Nissan",
    model: "March",
    year: 2019,
    vin: `Q3VIN${suffix}00000000`.slice(0, 17),
    codeCar: `Q3-${suffix.slice(-5)}`,
    color: "Rojo",
    fuel: "Gasolina",
    transmition: "Manual",
    km: 60000,
  });
  const carId = idOf(car);

  const entry = await post(request, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId,
    carId,
    assigned_mechanic: MECHANIC_ID,
    status: 1,
    observations: `Fixture Q3 (${quotes.length} cotización(es))`,
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  });
  const entryId = idOf(entry);
  const os = entry?.sheet;

  await post(request, `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos", "Llave"],
    checks: ["Servicio de Frenos"],
    isCheckAll: false,
    observations: "Fixture Q3",
    km: 60000,
    fuel_tank: "1/2",
  });

  for (const q of quotes) {
    await post(request, `/entries/${entryId}/quotes`, q);
  }

  return { entryId, os };
}

// ── Helpers de UI ────────────────────────────────────────────────────────────

async function login(page) {
  await page.goto("/login");
  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page
    .waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 })
    .catch(() => {});
}

/** Tarjeta de la OS en /registro (vista de cards). */
function cardForOs(page, os) {
  return page
    .locator("div.rounded-xl.border", { hasText: `OS: ${os}` })
    .first();
}

/** Abre el select de Aprobación de la tarjeta y elige "Aprobada". */
async function chooseAprobada(page, card) {
  await card.locator(".ant-select").first().click();
  await page
    .locator(
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="Aprobada"]',
    )
    .click();
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("Q3: OS con 1 cotización → Aprobada aprueba directo (selección automática)", async ({
  page,
  request,
}) => {
  const { entryId, os } = await createOsFixture(request, [pricedQuote(1)]);

  await login(page);
  await page.goto("/registro");

  const card = cardForOs(page, os);
  await expect(card).toBeVisible({ timeout: 15000 });
  await chooseAprobada(page, card);

  // Éxito directo: sin redirección a selección y con toast de estatus.
  await expect(page.getByText(/Estatus actualizado/i)).toBeVisible({
    timeout: 15000,
  });
  await expect(page).toHaveURL(/\/registro/);

  // Verificación de fondo por API: quedó APROBADA y con selección oficial.
  await expect
    .poll(
      async () => {
        const e = await getJson(request, `/entries/${entryId}`);
        return {
          approvalState: e?.approvalState,
          quoteId: e?.approvedSelection?.quoteId ?? null,
          sheetId: e?.approvedSelection?.serviceSheetId ?? null,
        };
      },
      { timeout: 15000 },
    )
    .toEqual(
      expect.objectContaining({
        approvalState: "APROBADA",
        quoteId: expect.any(String),
        sheetId: expect.any(String),
      }),
    );
});

test("Q3: OS con 2 cotizaciones → redirige a la selección oficial", async ({
  page,
  request,
}) => {
  const { entryId, os } = await createOsFixture(request, [
    pricedQuote(1),
    pricedQuote(2),
  ]);

  await login(page);
  await page.goto("/registro");

  const card = cardForOs(page, os);
  await expect(card).toBeVisible({ timeout: 15000 });
  await chooseAprobada(page, card);

  // Redirección a la pantalla de selección de esta entrada.
  await expect(page).toHaveURL(new RegExp(`/entrada-seleccion/${entryId}`), {
    timeout: 15000,
  });
  await expect(
    page.getByRole("heading", { name: /Selección oficial/i }),
  ).toBeVisible();

  // No se aprobó nada todavía.
  const e = await getJson(request, `/entries/${entryId}`);
  expect(e?.approvalState).toBe("EN ESPERA");
});

test("Q3: OS solo con costeo (sin precios) → avisa y no aprueba", async ({
  page,
  request,
}) => {
  const { entryId, os } = await createOsFixture(request, [costeoQuote()]);

  await login(page);
  await page.goto("/registro");

  const card = cardForOs(page, os);
  await expect(card).toBeVisible({ timeout: 15000 });
  await chooseAprobada(page, card);

  // Aviso de que falta la cotización con precios; sin redirección.
  await expect(
    page.getByText(/no tiene una cotización con precios/i),
  ).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveURL(/\/registro/);

  const e = await getJson(request, `/entries/${entryId}`);
  expect(e?.approvalState).toBe("EN ESPERA");
});
