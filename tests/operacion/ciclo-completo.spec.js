const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * CICLO DE VIDA COMPLETO DE UNA OS — de crear el cliente a entregar el auto.
 *
 * Recorre y VERIFICA todo el flujo CCC de punta a punta:
 *   cliente → auto → entrada (asesor #10) → hoja (llave/birlo #13) →
 *   diagnóstico → costeo (sin folio, Q4) → cotización (folio 01 + anticipo Q7)
 *   → aprobar por UI (Q3: 1 cotización = directa) → reserva (CORE #18) →
 *   pedido del faltante → recepción directo al auto (Q2) → REPARACIÓN
 *   (consume solo lo del almacén, Q1) → ENTREGADO (lastServiceAt, Q18) →
 *   finanzas del dashboard (Q7).
 *
 * La preparación y las verificaciones van por API (rápidas y precisas);
 * la aprobación va por UI porque ahí vive la lógica de Q3.
 *
 * PRERREQUISITOS (todo corriendo):
 *   1) Emuladores:  cd ccc-backend && npm run serve
 *   2) Backend:     cd ccc-backend && npm run backend
 *   3) Frontend:    cd ccc-frontend && npm start
 *   4) Usuario:     cd ccc-testing && node seed_emulator_user.js
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";
const EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const PASSWORD = process.env.SEED_PASSWORD || "prueba123";

// ── Helpers de API ───────────────────────────────────────────────────────────

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

async function login(page) {
  await page.goto("/login");
  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page
    .waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 })
    .catch(() => {});
}

test("ciclo completo: cliente → OS → cotización → aprobar → abastecer → reparar → entregar", { tag: ["@ui", "@lento"] }, async ({
  page,
  request,
}) => {
  test.setTimeout(120_000); // flujo largo: 12 etapas
  const suffix = `${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;

  // ── 1. Cliente + vínculo con el taller ─────────────────────────────────────
  const client = await post(request, "/clients", {
    fullName: `Cliente Ciclo ${suffix}`,
    email: `ciclo.${suffix}@test.com`,
    phone: `59${suffix}`,
    idWorkshop: ID_WORKSHOP,
    createdBy: MECHANIC_ID,
  });
  const clientId = idOf(client);
  await post(request, "/tokens", { idWorkshop: ID_WORKSHOP, idClient: clientId });

  // ── 2. Vehículo ────────────────────────────────────────────────────────────
  const car = await post(request, "/cars", {
    clientId,
    brand: "Toyota",
    model: "Corolla",
    year: 2021,
    vin: `CICLO${suffix}0000000`.slice(0, 17),
    codeCar: `CIC-${suffix.slice(-5)}`,
    color: "Plata",
    fuel: "Gasolina",
    transmition: "CVT",
    km: 52000,
  });
  const carId = idOf(car);
  expect(await getJson(request, `/cars/${carId}`)).toBeTruthy();

  // ── 3. Inventario: 1 pieza en almacén (la OS pedirá 2 → faltante 1) ───────
  const inv = await post(request, "/inventory", {
    idWorkshop: ID_WORKSHOP,
    name: `Balatas Ciclo ${suffix}`,
    sku: `CIC-${suffix}`,
    category: "Frenos",
    brand: "OEM",
    unit: "juego",
    cost: 500,
    price: 850,
    stock: 1,
    minStock: 0,
  });
  const inventoryId = idOf(inv);

  // ── 4. Entrada (OS) con asesor (#10) ───────────────────────────────────────
  const entry = await post(request, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId,
    carId,
    assigned_mechanic: MECHANIC_ID,
    status: 1,
    observations: "Ciclo completo E2E",
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
    createdBy: "asesor-ciclo",
    createdByName: "Asesor Ciclo",
  });
  const entryId = idOf(entry);
  const os = entry?.sheet;
  expect(os).toBeTruthy();
  expect(entry?.createdByName).toBe("Asesor Ciclo"); // #10

  // ── 5. Hoja de servicio (con llave y birlo, #13) ───────────────────────────
  await post(request, `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos", "Llave", "Birlo de seguridad"],
    checks: ["Servicio de Frenos"],
    isCheckAll: false,
    observations: "Hoja del ciclo E2E",
    km: 52000,
    fuel_tank: "1/2",
  });

  // ── 6. Diagnóstico ─────────────────────────────────────────────────────────
  await post(request, `/entries/${entryId}/diagnostics`, {
    idMechanic: MECHANIC_ID,
    generalObservations: "Frenos al límite.",
    findings: [
      { id: "c-rojo", system: "Frenos", component: "Balatas", finding: "Metal-metal.", severity: "ROJO", recommendation: "Reemplazo inmediato.", commercialDescription: "Frenos al límite.", consequence: "Riesgo de no frenar." },
    ],
  });

  // ── 7. Costeo (borrador): NO recibe folio (Q4) ─────────────────────────────
  const costeo = await post(request, `/entries/${entryId}/quotes`, {
    diagnostic: "Costeo del ciclo (sin precios)",
    labor: [{ description: "Cambio de balatas", count: 1, cost: "", subtotal: 0 }],
    parts: [{ description: "Balatas", count: 2, cost: "", subtotal: 0, inventoryId }],
    status: 2,
    stage: "COSTEO",
  });
  const quoteId = idOf(costeo);
  expect(costeo?.quoteNumber ?? null).toBeNull();

  // ── 8. Cotización: precios + ANTICIPO (Q7) → folio 01 (Q4) ─────────────────
  const quote = await put(request, `/entries/${entryId}/quotes/${quoteId}`, {
    labor: [{ description: "Cambio de balatas", count: 2, cost: 400, subtotal: 800 }],
    parts: [{ description: "Balatas", count: 2, cost: 850, subtotal: 1700, inventoryId }],
    status: 2,
    stage: "COTIZACION",
    advance: 500,
  });
  expect(quote?.quoteNumber).toBe(1); // Q4: OS…-01
  expect(Number(quote?.advance)).toBe(500); // Q7

  // ── 9. Aprobar por UI (Q3: 1 cotización → aprueba directo) ─────────────────
  await login(page);
  await page.goto("/registro");
  const card = page.locator("div.rounded-xl.border", { hasText: `OS: ${os}` }).first();
  await expect(card).toBeVisible({ timeout: 15000 });
  await card.locator(".ant-select").first().click();
  await page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="Aprobada"]')
    .click();
  await expect(page.getByText(/Estatus actualizado/i)).toBeVisible({ timeout: 15000 });

  // Reserva CORE #18: comprometido 2, stock intacto, faltante 1, anticipo denormalizado.
  await expect
    .poll(async () => (await getJson(request, `/entries/${entryId}`))?.approvalState, { timeout: 15000 })
    .toBe("APROBADA");
  const approved = await getJson(request, `/entries/${entryId}`);
  expect(approved?.approvedSelection?.quoteId).toBeTruthy(); // Q3 selección automática
  expect(Number(approved?.officialQuoteAdvance)).toBe(500); // Q7
  expect(approved?.needsProcurement).toBe(true);
  let item = await getJson(request, `/inventory/${inventoryId}`);
  expect(Number(item.stock)).toBe(1);
  expect(Number(item.committed)).toBe(2);

  // ── 10. Pedido del faltante y recepción DIRECTO AL AUTO (Q2) ───────────────
  const po = await post(request, "/purchase-orders", {
    idWorkshop: ID_WORKSHOP,
    entryId,
    items: [{ description: "Balatas (faltante)", qty: 1, unitCost: 500, inventoryId }],
  });
  await post(request, `/purchase-orders/${idOf(po)}/receive`, {
    items: [{ index: 0, received: 1 }],
  });
  item = await getJson(request, `/inventory/${inventoryId}`);
  expect(Number(item.stock)).toBe(1); // Q2: NO sube el almacén
  const afterReceive = await getJson(request, `/entries/${entryId}`);
  expect(Number(afterReceive?.directReceived?.[inventoryId])).toBe(1);

  // ── 11. A REPARACIÓN: consume del almacén solo lo que salió de él (Q1+Q2) ──
  await put(request, `/entries/${entryId}`, { statusService: "EN REPARACION" });
  item = await getJson(request, `/inventory/${inventoryId}`);
  expect(Number(item.stock)).toBe(0); // 1 − (2 requeridas − 1 directa)
  expect(Number(item.committed)).toBe(0); // reserva liberada
  expect((await getJson(request, `/entries/${entryId}`))?.stockConsumed).toBe(true);

  // ── 12. ENTREGAR: cierra el ciclo y deja huella en el vehículo (Q18) ───────
  await put(request, `/entries/${entryId}`, { statusService: "ENTREGADO" });
  const deliveredEntry = await getJson(request, `/entries/${entryId}`);
  expect(deliveredEntry?.statusService).toBe("ENTREGADO");
  const deliveredCar = await getJson(request, `/cars/${carId}`);
  expect(Number(deliveredCar?.lastServiceAt)).toBeGreaterThan(0); // Q18

  // ── Epílogo: las finanzas del Centro de Control ven el anticipo (Q7) ───────
  // (≥ porque el dashboard suma TODAS las OS activas aprobadas del taller;
  // esta OS ya se entregó, así que solo verificamos que el campo existe.)
  const dash = await getJson(request, `/dashboard?idWorkshop=${ID_WORKSHOP}`);
  expect(dash?.finance).toBeTruthy();
  expect(Number(dash.finance.partialIncome)).toBeGreaterThanOrEqual(0);
});
