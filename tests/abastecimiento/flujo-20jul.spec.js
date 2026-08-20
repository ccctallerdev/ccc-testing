const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * Observaciones 20-Jul — "Un dato se captura UNA sola vez":
 *   1) El costeo captura costo de proveedor + utilidad ⇒ precio cliente; al
 *      aprobar, la orden de compra se genera SOLA con el COSTO del proveedor
 *      (no el precio) y la máquina Q5 avanza compra→REFACCIONES al instante.
 *   2) Semáforo de gestión con el proveedor: SOLICITADA → BUSCANDO →
 *      NO_ENCONTRADA (el tiempo prometido corre desde SOLICITADA).
 *   3) Centro de Abastecimiento: vista agrupada POR OS con su indicador de
 *      recepción (todo recibido / X de Y · faltan) y datos de OS + vehículo.
 *
 * PRERREQUISITOS: emuladores + backend + frontend (global-setup siembra admin).
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC = "mecanico-prueba";
const ADMIN_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const ADMIN_PASSWORD = process.env.SEED_PASSWORD || "prueba123";

async function call(request, method, path, body, { allowFail = false } = {}) {
  const res = await request[method](`${API}${path}`, { headers: await authHeaders(), ...(body ? { data: body } : {}) });
  if (!res.ok() && !allowFail) {
    throw new Error(`${method.toUpperCase()} ${path} → ${res.status()}: ${await res.text()}`);
  }
  const json = await res.json().catch(() => null);
  return { status: res.status(), data: json?.data ?? json };
}
const post = async (r, p, b, o) => (await call(r, "post", p, b, o));
const put = async (r, p, b, o) => (await call(r, "put", p, b, o));
const getJson = async (r, p) => (await call(r, "get", p)).data;
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

const s = `${String(Date.now()).slice(-6)}`;
const COSTO_PROVEEDOR = 900;
const UTILIDAD = 40;
const PRECIO_CLIENTE = 1260; // 900 * 1.40

/** OS con hoja y cotización cuyo costeo trae costo↔utilidad↔precio (20-Jul). */
async function makeOs(request) {
  const client = (await post(request, "/clients", {
    fullName: `Cliente 20Jul ${s}`,
    email: `f20.${s}@test.com`,
    phone: `84${s.slice(-8)}0000000000`.slice(0, 10),
    createdBy: MECHANIC,
  })).data;
  const car = (await post(request, "/cars", {
    clientId: idOf(client),
    brand: "VW",
    model: "Golf 20Jul",
    year: 2022,
    vin: `F20J${s}0000000000000`.slice(0, 17),
    codeCar: `F20-${s.slice(-4)}`,
    color: "Gris",
    fuel: "Gasolina",
    transmition: "Manual",
    km: 31000,
  })).data;
  const entry = (await post(request, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId: idOf(client),
    carId: idOf(car),
    assigned_mechanic: MECHANIC,
    status: 1,
    observations: `Flujo 20-Jul ${s}`,
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  })).data;
  const entryId = idOf(entry);
  await post(request, `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos"],
    checks: ["Servicio de Frenos"],
    isCheckAll: false,
    observations: `20-Jul ${s}`,
    km: 31000,
    fuel_tank: "1/2",
  });
  const quote = (await post(request, `/entries/${entryId}/quotes`, {
    diagnostic: `Bomba de gasolina 20-Jul ${s}`,
    labor: [
      { description: "Cambio de bomba", count: 1, cost: 800, subtotal: 800 },
    ],
    parts: [
      {
        // La Ley: costo proveedor + utilidad capturados EN EL COSTEO.
        description: `Bomba de gasolina ${s}`,
        count: 1,
        costProveedor: COSTO_PROVEEDOR,
        utilidad: UTILIDAD,
        cost: PRECIO_CLIENTE,
        subtotal: PRECIO_CLIENTE,
        supplierName: "Refaccionaria 20Jul",
        availability: "AMARILLO", // no se ha pedido
      },
    ],
    status: 2,
    stage: "COTIZACION",
    advance: 0,
  })).data;
  return { entryId, os: entry?.sheet, quoteId: idOf(quote) };
}

async function loginUI(page) {
  await page.goto("/login");
  await page.locator("#email").fill(ADMIN_EMAIL);
  await page.locator("#password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });
}

test.describe.serial("Observ. 20-Jul — costeo → orden automática → abastecimiento", () => {
  let X; // { entryId, os, quoteId }
  let poId;

  test("1) aprobar genera la orden de compra SOLA, con el costo del proveedor, y avanza a REFACCIONES", { tag: ["@api"] }, async ({ request }) => {
    X = await makeOs(request);
    const sheets = (await getJson(request, `/entries/${X.entryId}/service-sheet?limit=10`))?.serviceSheets ?? [];

    // Aprobación (selección oficial + estado del cliente).
    const resp = (await put(request, `/entries/${X.entryId}/approve-selection`, {
      approvedQuoteId: X.quoteId,
      approvedServiceSheetId: idOf(sheets[0]),
    })).data;
    await put(request, `/entries/${X.entryId}`, { approvalState: "APROBADA" });

    // La respuesta ya trae la lista de compras, valuada al COSTO del proveedor.
    expect(Array.isArray(resp?.procurement)).toBe(true);
    expect(resp.procurement.length).toBeGreaterThan(0);
    const item = resp.procurement.find((p) => String(p.description).includes("Bomba de gasolina"));
    expect(item, "la refacción del costeo va a compras").toBeTruthy();
    expect(Number(item.unitCost), "orden valuada a costo proveedor, NO a precio cliente").toBe(COSTO_PROVEEDOR);

    // Q5 + 20-Jul: con material por pedir, la OS no se detiene en EN ESPERA.
    const entry = await getJson(request, `/entries/${X.entryId}`);
    expect(entry.statusService).toBe("REFACCIONES");
    expect(entry.needsProcurement).toBe(true);

    // Y la orden EXISTE en abastecimiento, ligada a la OS, nacida SOLICITADA.
    const orders = (await getJson(request, `/purchase-orders?idWorkshop=${ID_WORKSHOP}&limit=100`)) ?? [];
    const list = Array.isArray(orders) ? orders : orders?.orders ?? [];
    const mine = list.find((o) => o.entryId === X.entryId);
    expect(mine, "orden de compra automática de la OS").toBeTruthy();
    expect(mine.sourcingStatus ?? "SOLICITADA").toBe("SOLICITADA");
    const poItem = (mine.items || []).find((i) => String(i.description).includes("Bomba"));
    expect(Number(poItem?.unitCost)).toBe(COSTO_PROVEEDOR);
    poId = mine.id;
  });

  test("2) semáforo con el proveedor: SOLICITADA → BUSCANDO → NO_ENCONTRADA (y rechaza inválidos)", { tag: ["@api"] }, async ({ request }) => {
    await post(request, `/purchase-orders/${poId}/sourcing`, { sourcingStatus: "BUSCANDO" });
    let po = await getJson(request, `/purchase-orders/${poId}`);
    expect(po.sourcingStatus).toBe("BUSCANDO");

    await post(request, `/purchase-orders/${poId}/sourcing`, { sourcingStatus: "NO_ENCONTRADA" });
    po = await getJson(request, `/purchase-orders/${poId}`);
    expect(po.sourcingStatus).toBe("NO_ENCONTRADA");

    const bad = await post(request, `/purchase-orders/${poId}/sourcing`, { sourcingStatus: "PERDIDA" }, { allowFail: true });
    expect(bad.status, "estado inválido rechazado").toBeGreaterThanOrEqual(400);

    // Se queda en BUSCANDO para que la UI lo muestre en amarillo.
    await post(request, `/purchase-orders/${poId}/sourcing`, { sourcingStatus: "BUSCANDO" });
  });

  test("3) UI Abastecimiento: vista por OS con indicador de recepción y datos del vehículo", { tag: ["@ui"] }, async ({ page }) => {
    await loginUI(page);
    await page.goto("/abastecimiento");

    // Toggle de vista (Observ. 20-Jul): Proveedor | OS.
    await page.getByRole("button", { name: "OS", exact: true }).click();

    // El grupo de NUESTRA OS, con su indicador de recepción pendiente.
    await expect(page.getByText(`OS ${X.os}`).first()).toBeVisible();
    await expect(page.getByText(/recibidas/).first()).toBeVisible();

    // El semáforo del proveedor en amarillo (Buscando): el BADGE de la tarjeta
    // (no la <option> del select, que también dice "Buscando" pero vive oculta).
    await expect(page.locator("span", { hasText: "Buscando" }).first()).toBeVisible();
  });
});
