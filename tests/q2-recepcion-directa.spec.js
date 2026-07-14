const { test, expect } = require("@playwright/test");
const { authHeaders } = require("../apiToken");

/**
 * Q2 (Documento Unificado — "no somos refaccionaria"):
 * Las refacciones compradas PARA UNA OS van directo al auto, NO al inventario
 * general. Solo las compras generales (sin OS) suman stock.
 *
 * Estas pruebas son de API (usan `request` de Playwright, sin navegador):
 * ejercitan el ciclo completo del backend contra los emuladores:
 *   aprobar (reserva + faltante) → orden de compra → recepción → reparación.
 *
 * PRERREQUISITOS:
 *   1) Emuladores:  cd ccc-backend && npm run serve
 *   2) Backend:     cd ccc-backend && npm run backend
 *   (no necesita frontend ni semillas)
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";

// ── Helpers de API ───────────────────────────────────────────────────────────

async function post(request, path, body) {
  const res = await request.post(`${API}${path}`, { data: body, headers: await authHeaders() });
  if (!res.ok()) {
    throw new Error(`POST ${path} → ${res.status()}: ${await res.text()}`);
  }
  const json = await res.json().catch(() => null);
  return json?.data ?? json;
}

async function put(request, path, body) {
  const res = await request.put(`${API}${path}`, { data: body, headers: await authHeaders() });
  if (!res.ok()) {
    throw new Error(`PUT ${path} → ${res.status()}: ${await res.text()}`);
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

/** Artículo de inventario con stock inicial controlado. */
async function createInventoryItem(request, name, stock) {
  const suffix = `${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
  const item = await post(request, "/inventory", {
    idWorkshop: ID_WORKSHOP,
    name: `${name} ${suffix}`,
    sku: `Q2-${suffix}`,
    category: "Pruebas",
    brand: "OEM",
    unit: "pieza",
    cost: 100,
    price: 150,
    stock,
    minStock: 0,
  });
  return idOf(item);
}

/**
 * OS aprobada con cotización oficial que pide `count` unidades del artículo.
 * Devuelve ids de entrada, cotización y hoja.
 */
async function createApprovedOs(request, inventoryId, count) {
  const suffix = `${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;

  const client = await post(request, "/clients", {
    fullName: `Cliente Q2 ${suffix}`,
    email: `q2.${suffix}@test.com`,
    phone: `56${suffix}`,
    idWorkshop: ID_WORKSHOP,
    createdBy: MECHANIC_ID,
  });
  const clientId = idOf(client);

  const car = await post(request, "/cars", {
    clientId,
    brand: "Chevrolet",
    model: "Aveo",
    year: 2020,
    vin: `Q2VIN${suffix}00000000`.slice(0, 17),
    codeCar: `Q2-${suffix.slice(-5)}`,
    color: "Blanco",
    fuel: "Gasolina",
    transmition: "Manual",
    km: 45000,
  });
  const carId = idOf(car);

  const entry = await post(request, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId,
    carId,
    assigned_mechanic: MECHANIC_ID,
    status: 1,
    observations: "Fixture Q2 (recepción directa)",
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  });
  const entryId = idOf(entry);

  await post(request, `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos"],
    checks: ["Servicio de Frenos"],
    isCheckAll: false,
    observations: "Fixture Q2",
    km: 45000,
    fuel_tank: "1/2",
  });

  await post(request, `/entries/${entryId}/quotes`, {
    diagnostic: "Cotización Q2 con refacción de inventario",
    labor: [{ description: "Instalación", count: 1, cost: 500, subtotal: 500 }],
    parts: [
      {
        description: "Refacción de prueba Q2",
        count,
        cost: 150,
        subtotal: 150 * count,
        inventoryId,
      },
    ],
    status: 2,
    stage: "COTIZACION",
  });

  // Ids reales de cotización y hoja (los toma de las listas de la entrada).
  const quotesPage = await getJson(request, `/entries/${entryId}/quotes?limit=10`);
  const quoteId = idOf((quotesPage?.quotes ?? [])[0]);
  const sheetsPage = await getJson(request, `/entries/${entryId}/service-sheet?limit=10`);
  const sheetId = idOf((sheetsPage?.serviceSheets ?? [])[0]);

  // Selección oficial → dispara la reserva (committed) y calcula faltantes.
  await put(request, `/entries/${entryId}/approve-selection`, {
    approvedQuoteId: quoteId,
    approvedServiceSheetId: sheetId,
  });
  await put(request, `/entries/${entryId}`, { approvalState: "APROBADA" });

  return { entryId, quoteId, sheetId };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("Q2: recepción de compra ligada a OS va directo al auto (no suma stock) y la reparación no descuenta de más", async ({
  request,
}) => {
  // Almacén: 1 pieza. La OS necesita 2 → faltante de 1 que se compra por OS.
  const inventoryId = await createInventoryItem(request, "Balatas Q2", 1);
  const { entryId } = await createApprovedOs(request, inventoryId, 2);

  // Tras aprobar: comprometido 2, stock intacto (modelo CORE #18).
  let inv = await getJson(request, `/inventory/${inventoryId}`);
  expect(Number(inv.stock)).toBe(1);
  expect(Number(inv.committed)).toBe(2);

  // Orden de compra LIGADA a la OS por el faltante (1 pieza).
  const po = await post(request, "/purchase-orders", {
    idWorkshop: ID_WORKSHOP,
    entryId,
    items: [
      { description: "Balatas Q2 (faltante)", qty: 1, unitCost: 100, inventoryId },
    ],
  });

  // Recepción: NO debe sumar al inventario general (va directo al auto).
  await post(request, `/purchase-orders/${idOf(po)}/receive`, {
    items: [{ index: 0, received: 1 }],
  });

  inv = await getJson(request, `/inventory/${inventoryId}`);
  expect(Number(inv.stock)).toBe(1); // ← antes de Q2 aquí habría 2

  // Y quedó registrado en la entrada lo que llegó directo.
  const entry = await getJson(request, `/entries/${entryId}`);
  expect(Number(entry?.directReceived?.[inventoryId])).toBe(1);

  // Mandar a REPARACIÓN: consume del almacén SOLO lo que salió de él
  // (2 requeridas − 1 directa = 1) y libera todo lo comprometido.
  await put(request, `/entries/${entryId}`, { statusService: "EN REPARACION" });

  inv = await getJson(request, `/inventory/${inventoryId}`);
  expect(Number(inv.stock)).toBe(0); // 1 − 1
  expect(Number(inv.committed)).toBe(0); // 2 − 2

  const after = await getJson(request, `/entries/${entryId}`);
  expect(after?.stockConsumed).toBe(true);
});

test("Q2 (control): compra general SIN OS sí suma al inventario", async ({
  request,
}) => {
  const inventoryId = await createInventoryItem(request, "Filtros Q2", 0);

  const po = await post(request, "/purchase-orders", {
    idWorkshop: ID_WORKSHOP,
    // sin entryId → compra general para el almacén
    items: [
      { description: "Filtros Q2 (almacén)", qty: 3, unitCost: 100, inventoryId },
    ],
  });

  await post(request, `/purchase-orders/${idOf(po)}/receive`, {
    items: [{ index: 0, received: 3 }],
  });

  const inv = await getJson(request, `/inventory/${inventoryId}`);
  expect(Number(inv.stock)).toBe(3); // la compra general SÍ entra al almacén
});
