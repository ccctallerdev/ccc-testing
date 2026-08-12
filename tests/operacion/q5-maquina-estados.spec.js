const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * CORE Q5 — Máquina de estados automática del servicio:
 *   aprobación        → EN ESPERA
 *   orden de compra   → REFACCIONES
 *   iniciar producción→ EN REPARACION
 *   terminar producción → CONTROL DE CALIDAD (paso nuevo)
 *   ✓ calidad (manual) → LAVADO
 * Regla de oro: lo automático SOLO avanza; nunca regresa un auto de etapa.
 *
 * PRERREQUISITOS: emuladores + backend + frontend (global-setup siembra admin).
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC = "mecanico-prueba";
const ADMIN_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const ADMIN_PASSWORD = process.env.SEED_PASSWORD || "prueba123";

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

let seq = 70;
/** OS con cotización oficial seleccionada, SIN aprobar aún. */
async function osReadyToApprove(request, tag) {
  const s = `${String(Date.now()).slice(-6)}${seq++}`;
  const client = await post(request, "/clients", {
    fullName: `Cliente Q5 ${tag} ${s}`,
    email: `q5.${tag}.${s}@test.com`,
    phone: `56${s}`,
    idWorkshop: ID_WORKSHOP,
    createdBy: MECHANIC,
  });
  const car = await post(request, "/cars", {
    clientId: idOf(client),
    brand: "Mazda",
    model: `CX-5 ${tag}`,
    year: 2022,
    vin: `Q5${tag}${s}000000000`.slice(0, 17),
    codeCar: `Q5${tag}${s.slice(-4)}`.slice(0, 8),
    color: "Rojo",
    fuel: "Gasolina",
    transmition: "Automática",
    km: 30000,
  });
  const entry = await post(request, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId: idOf(client),
    carId: idOf(car),
    assigned_mechanic: MECHANIC,
    status: 1,
    observations: `Q5 ${tag}`,
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  });
  const entryId = idOf(entry);
  await post(request, `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos"],
    checks: ["Servicio de Frenos"],
    isCheckAll: false,
    observations: `Q5 ${tag}`,
    km: 30000,
    fuel_tank: "1/2",
  });
  await post(request, `/entries/${entryId}/quotes`, {
    diagnostic: `Q5 ${tag}`,
    labor: [{ description: "Mano de obra", count: 1, cost: 800, subtotal: 800 }],
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
  return { entryId, os: entry?.sheet };
}

const statusOf = async (request, entryId) =>
  (await getJson(request, `/entries/${entryId}`))?.statusService;

// ── API: el ciclo completo avanza solo y nunca retrocede ─────────────────────

test("Q5 API: aprobación→espera, compra→refacciones, producción→reparación, fin→control de calidad; sin retrocesos", { tag: ["@api"] }, async ({
  request,
}) => {
  test.setTimeout(90_000);
  const { entryId } = await osReadyToApprove(request, "A");

  // 1. Aprobar la cotización mete el auto a la cola.
  await put(request, `/entries/${entryId}`, { approvalState: "APROBADA" });
  expect(await statusOf(request, entryId)).toBe("EN ESPERA");

  // 2. Una orden de compra ligada a la OS = abastecimiento.
  await post(request, "/purchase-orders", {
    idWorkshop: ID_WORKSHOP,
    entryId,
    items: [{ description: "Balatas delanteras", qty: 1, unitCost: 450 }],
  });
  expect(await statusOf(request, entryId)).toBe("REFACCIONES");

  // Validador de recepción (Obs 29-jul #5/#6): con orden de compra activa hay que
  // marcar el abastecimiento listo antes de arrancar reparación; si no,
  // production/start lo rechaza (PROCUREMENT_NOT_READY).
  await put(request, `/entries/${entryId}`, { repairReadiness: "COMPLETO" });

  // 3. Arrancar el cronómetro = el auto está en reparación.
  await post(request, `/entries/${entryId}/production/start`);
  expect(await statusOf(request, entryId)).toBe("EN REPARACION");

  // 4. Terminar producción = pasa a revisión de calidad (paso nuevo).
  await post(request, `/entries/${entryId}/production/finish`);
  expect(await statusOf(request, entryId)).toBe("CONTROL DE CALIDAD");

  // 5. Solo hacia adelante: otra orden de compra NO lo regresa a REFACCIONES.
  await post(request, "/purchase-orders", {
    idWorkshop: ID_WORKSHOP,
    entryId,
    items: [{ description: "Tornillería", qty: 2, unitCost: 30 }],
  });
  expect(await statusOf(request, entryId)).toBe("CONTROL DE CALIDAD");

  // 6. El ✓ de calidad es manual: el encargado lo manda a LAVADO.
  await put(request, `/entries/${entryId}`, { statusService: "LAVADO" });
  expect(await statusOf(request, entryId)).toBe("LAVADO");
});

// ── UI: iniciar/terminar desde el Centro de Producción avisa el cambio ───────

test("Q5 UI: Iniciar y Terminar en producción muestran el avance de etapa", { tag: ["@ui"] }, async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const { entryId, os } = await osReadyToApprove(request, "B");
  await put(request, `/entries/${entryId}`, { approvalState: "APROBADA" });

  await page.goto("/login");
  await page.locator("#email").fill(ADMIN_EMAIL);
  await page.locator("#password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });

  await page.goto("/produccion");
  await page.getByText(`OS ${os}`).first().click();

  const toaster = page.locator("[data-sonner-toaster]");

  // "Iniciar" exacto: los cards de la lista dicen "Sin iniciar" y el regex
  // laxo agarraba los 10 botones (strict mode violation).
  await page.getByRole("button", { name: "Iniciar", exact: true }).click();
  await expect(toaster.getByText(/en reparación/i).first()).toBeVisible({ timeout: 10000 });
  await expect
    .poll(() => statusOf(request, entryId), { timeout: 10000 })
    .toBe("EN REPARACION");

  await page.getByRole("button", { name: "Terminar", exact: true }).click();
  await expect(toaster.getByText(/control de calidad/i).first()).toBeVisible({ timeout: 10000 });
  await expect
    .poll(() => statusOf(request, entryId), { timeout: 10000 })
    .toBe("CONTROL DE CALIDAD");
});
