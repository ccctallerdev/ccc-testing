const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * CORE #39/#40 (Q15) + Obs 8-jul #1:
 *   - El Centro de Producción SOLO muestra autos APROBADOS con cotización
 *     oficial (no entregados). Los "en espera" / sin cotizar no aparecen.
 *   - El cronómetro (backend) se NIEGA a arrancar sin cotización oficial,
 *     aunque se le pegue por API directa.
 *
 * PRERREQUISITOS: emuladores + backend + frontend (el global-setup siembra
 * el usuario). Fixtures propias por API.
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";
const EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const PASSWORD = process.env.SEED_PASSWORD || "prueba123";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function call(request, method, path, body) {
  // Q20: la API blindada exige el token firmado en CADA llamada.
  const res = await request[method](`${API}${path}`, { headers: await authHeaders(), ...(body ? { data: body } : {}) });
  if (!res.ok()) {
    throw new Error(`${method.toUpperCase()} ${path} → ${res.status()}: ${await res.text()}`);
  }
  const json = await res.json().catch(() => null);
  return json?.data ?? json;
}
const post = (r, p, b) => call(r, "post", p, b);
const put = (r, p, b) => call(r, "put", p, b);
const getJson = (r, p) => call(r, "get", p);
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

let seq = 20;
async function createOs(request, tag) {
  const suffix = `${String(Date.now()).slice(-6)}${seq++}`;
  const client = await post(request, "/clients", {
    fullName: `Cliente Q15 ${tag} ${suffix}`,
    email: `q15.${tag}.${suffix}@test.com`,
    phone: `53${suffix}`,
    idWorkshop: ID_WORKSHOP,
    createdBy: MECHANIC_ID,
  });
  const car = await post(request, "/cars", {
    clientId: idOf(client),
    brand: "Honda",
    model: `Civic ${tag}`,
    year: 2022,
    vin: `Q15${tag}${suffix}0000000`.slice(0, 17),
    codeCar: `Q15${tag}${suffix.slice(-4)}`.slice(0, 8),
    color: "Negro",
    fuel: "Gasolina",
    transmition: "Manual",
    km: 30000,
  });
  const entry = await post(request, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId: idOf(client),
    carId: idOf(car),
    assigned_mechanic: MECHANIC_ID,
    status: 1,
    observations: `Q15 fixture ${tag}`,
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  });
  const entryId = idOf(entry);
  await post(request, `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos"],
    checks: ["Servicio de Frenos"],
    isCheckAll: false,
    observations: "Q15",
    km: 30000,
    fuel_tank: "1/2",
  });
  return { entryId, os: entry?.sheet };
}

/** Cotización con precios + selección oficial + aprobar. */
async function approveWithOfficialQuote(request, entryId) {
  await post(request, `/entries/${entryId}/quotes`, {
    diagnostic: "Q15 cotización",
    labor: [{ description: "Mano de obra", count: 1, cost: 500, subtotal: 500 }],
    parts: [],
    status: 2,
    stage: "COTIZACION",
  });
  const quotes = (await getJson(request, `/entries/${entryId}/quotes?limit=10`))?.quotes ?? [];
  const sheets = (await getJson(request, `/entries/${entryId}/service-sheet?limit=10`))?.serviceSheets ?? [];
  await put(request, `/entries/${entryId}/approve-selection`, {
    approvedQuoteId: idOf(quotes[0]),
    approvedServiceSheetId: idOf(sheets[0]),
  });
  await put(request, `/entries/${entryId}`, { approvalState: "APROBADA" });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("Q15: producción solo muestra aprobados con cotización oficial", { tag: ["@ui"] }, async ({
  page,
  request,
}) => {
  // X: en espera, sin cotización → NO debe aparecer.
  const X = await createOs(request, "X");
  // Y: aprobada con cotización oficial → SÍ debe aparecer.
  const Y = await createOs(request, "Y");
  await approveWithOfficialQuote(request, Y.entryId);

  await page.goto("/login");
  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });

  await page.goto("/produccion");
  // La aprobada aparece (su OS es visible en la lista de producción)…
  await expect(page.getByText(`OS ${Y.os}`).first()).toBeVisible({ timeout: 15000 });
  // …y la que está en espera sin cotizar NO.
  await expect(page.getByText(`OS ${X.os}`)).toHaveCount(0);
});

test("Q15: el backend rechaza arrancar el cronómetro sin cotización oficial", { tag: ["@api"] }, async ({
  request,
}) => {
  const X = await createOs(request, "Z");

  // Sin cotización oficial → el start debe fallar con mensaje claro.
  const denied = await request.post(`${API}/entries/${X.entryId}/production/start`, { headers: await authHeaders() });
  expect(denied.ok()).toBe(false);
  expect(await denied.text()).toMatch(/cotizaci[oó]n oficial/i);

  // Con cotización oficial aprobada → arranca.
  await approveWithOfficialQuote(request, X.entryId);
  const allowed = await request.post(`${API}/entries/${X.entryId}/production/start`, { headers: await authHeaders() });
  expect(allowed.ok()).toBe(true);
  const body = await allowed.json();
  expect((body?.data ?? body)?.status).toBe("running");
});
