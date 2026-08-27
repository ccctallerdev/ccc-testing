const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * M5 — Ventana ÚNICA para registrar garantía (PDF #57 / respuesta D5, 14-ago).
 *
 * El cliente vio dos ventanas distintas: la del Expediente (con OS ligada e
 * histórico de refacciones/servicios de la OS) y la del módulo Garantías
 * (que se veía "vacía"). Era el MISMO formulario, pero desde el módulo el
 * aviso de OS ligada y el histórico solo aparecían tras elegir la OS.
 * D5: la ventana del expediente es la única — desde el módulo, al elegir
 * la OS, se muestra exactamente lo mismo.
 *
 * Este spec abre la ventana por LOS DOS caminos sobre la misma OS entregada
 * (que tiene una refacción recibida de un proveedor) y exige lo mismo en ambos:
 *   - aviso "Esta garantía quedará ligada a la OS N"
 *   - histórico con la refacción (descripción · proveedor · costo)
 *   - clic en la fila del histórico prellena proveedor y costo
 * Y registra desde el módulo comprobando que queda ligada a la OS.
 *
 * PRERREQUISITOS: emuladores + backend :3001 + frontend :3000. Cuenta semilla
 * vía #apiToken (prueba@ccc.test / taller-prueba).
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";
const ADMIN_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const ADMIN_PASSWORD = process.env.SEED_PASSWORD || "prueba123";

async function call(request, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: await authHeaders(),
    ...(body ? { data: body } : {}),
  });
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

/** OS aprobada, con diagnóstico, con una OC de proveedor RECIBIDA, y ENTREGADA. */
async function makeDeliveredOsWithReceivedPart(request) {
  const s = `${String(Date.now()).slice(-6)}`;
  const partName = `Amortiguador M5 ${s}`;
  const supplierName = `Refaccionaria M5 ${s}`;

  const supplier = await post(request, "/suppliers", {
    idWorkshop: ID_WORKSHOP,
    name: supplierName,
    contactName: "M5",
    phone: `54${s}0000000000`.slice(0, 10),
    email: `m5.${s}@prov.test`,
  });
  const client = await post(request, "/clients", {
    fullName: `Cliente M5 ${s}`,
    email: `m5.${s}@test.com`,
    phone: `53${s}0000000000`.slice(0, 10),
    idWorkshop: ID_WORKSHOP,
    createdBy: MECHANIC_ID,
  });
  const car = await post(request, "/cars", {
    clientId: idOf(client),
    brand: "Mazda",
    model: "CX-5 M5",
    year: 2021,
    vin: `M5${s}0000000000000`.slice(0, 17),
    codeCar: `M5${s.slice(-5)}`,
    color: "Negro",
    fuel: "Gasolina",
    transmition: "Automática",
    km: 61000,
  });
  const entry = await post(request, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId: idOf(client),
    carId: idOf(car),
    assigned_mechanic: MECHANIC_ID,
    status: 1,
    observations: `M5 ${s}: ventana única de garantía`,
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  });
  const entryId = idOf(entry);
  await post(request, `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos"],
    checks: ["Suspensión"],
    isCheckAll: false,
    observations: `M5 ${s}`,
    km: 61000,
    fuel_tank: "1/2",
  });
  await post(request, `/entries/${entryId}/diagnostics`, {
    idMechanic: MECHANIC_ID,
    generalObservations: "Amortiguador delantero con fuga.",
    findings: [
      {
        id: "m5-rojo",
        system: "Suspensión",
        component: "Amortiguador",
        finding: "Fuga de aceite.",
        severity: "ROJO",
        recommendation: "Reemplazo.",
        commercialDescription: "Amortiguador dañado.",
        consequence: "Pérdida de control.",
      },
    ],
  });
  await post(request, `/entries/${entryId}/quotes`, {
    diagnostic: "Cambio de amortiguador",
    labor: [{ description: "Cambio de amortiguador", count: 1, cost: 700, subtotal: 700 }],
    parts: [{ description: partName, count: 1, cost: 1450, subtotal: 1450 }],
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

  // OC al proveedor ligada a la OS y RECIBIDA → alimenta el histórico.
  const po = await post(request, "/purchase-orders", {
    idWorkshop: ID_WORKSHOP,
    entryId,
    supplierId: idOf(supplier),
    items: [{ description: partName, qty: 1, unitCost: 980 }],
  });
  await post(request, `/purchase-orders/${idOf(po)}/receive`, {
    items: [{ index: 0, received: 1 }],
  });

  await put(request, `/entries/${entryId}`, { statusService: "ENTREGADO" });
  return { entryId, os: entry?.sheet, partName, supplierName };
}

async function login(page) {
  await page.goto("/login");
  await page.locator("#email").fill(ADMIN_EMAIL);
  await page.locator("#password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });
}

/** Lo que la ventana debe mostrar SIEMPRE que haya una OS (venga de donde venga). */
async function expectFullWarrantyWindow(modal, { os, partName, supplierName }) {
  await expect(
    modal.getByText(new RegExp(`ligada a la\\s+OS\\s+${os}`, "i")),
    "aviso de OS ligada",
  ).toBeVisible({ timeout: 15000 });
  await expect(
    modal.getByText(/histórico de refacciones y servicios de esta os/i),
    "sección de histórico",
  ).toBeVisible();
  const row = modal.getByRole("button", { name: new RegExp(partName, "i") }).first();
  await expect(row, "fila del histórico con la refacción recibida").toBeVisible({ timeout: 15000 });
  await expect(row).toContainText(new RegExp(supplierName, "i"));
  await expect(row).toContainText(/980/);
  return row;
}

test(
  "M5 / D5: la ventana de garantía es la MISMA desde el expediente y desde el módulo (aviso de OS + histórico + prellenado)",
  { tag: ["@ui", "@lento"] },
  async ({ page, request }) => {
    test.setTimeout(240_000);
    const data = await makeDeliveredOsWithReceivedPart(request);
    const { entryId, os, partName, supplierName } = data;

    await login(page);

    // ── Camino 1: desde el EXPEDIENTE (OS ligada por URL) ─────────────────────
    await page.goto(`/expediente/${entryId}`);
    await expect(page.getByText(/expediente cerrado/i)).toBeVisible({ timeout: 20000 });
    await page.getByRole("button", { name: /levantar garantía/i }).click();
    await page.waitForURL(/\/garantias\?entryId=/, { timeout: 15000 });
    const modalA = page.locator(".ant-modal").filter({ hasText: /registrar garantía/i }).last();
    await expect(modalA).toBeVisible({ timeout: 15000 });
    await expect(modalA.getByText(new RegExp(`Registrar garantía — OS ${os}`, "i"))).toBeVisible();
    // Desde el expediente NO hay que elegir OS.
    await expect(modalA.getByLabel(/orden de servicio de origen/i)).toHaveCount(0);
    await expectFullWarrantyWindow(modalA, data);
    await modalA.getByRole("button", { name: /^cancelar$/i }).click();
    await expect(modalA).toBeHidden({ timeout: 10000 });

    // ── Camino 2: desde el MÓDULO Garantías (se elige la OS en el select) ────
    await page.goto("/garantias");
    // El modal del camino 1 ya se cerró: el único botón "Registrar garantía" es el del encabezado.
    await expect(page.getByRole("heading", { level: 1, name: /garantías/i })).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: /^registrar garantía$/i }).click();
    const modalB = page.locator(".ant-modal").filter({ hasText: /registrar garantía/i }).last();
    await expect(modalB).toBeVisible({ timeout: 15000 });

    // Antes de elegir OS: hay select, aún no hay aviso, y el texto guía lo dice.
    const osSelect = modalB.getByLabel(/orden de servicio de origen/i);
    await expect(osSelect).toBeVisible();
    await expect(modalB.getByText(/ligada a la\s+OS/i)).toHaveCount(0);
    await expect(modalB.getByText(/al elegirla verás su histórico/i)).toBeVisible();

    // Elegir ESTA OS → la ventana se completa igual que desde el expediente.
    await osSelect.selectOption({ value: entryId });
    const row = await expectFullWarrantyWindow(modalB, data);

    // Clic en la fila del histórico → prellena proveedor y costo.
    await row.click();
    const supplierSelect = modalB.locator("select").filter({ hasText: /ninguno/i }).first();
    await expect(supplierSelect.locator("option:checked")).toHaveText(new RegExp(supplierName, "i"));
    await expect(modalB.getByPlaceholder(/^0$/)).toHaveValue("980");
    await expect(modalB.locator('input[value*="' + partName.slice(0, 12) + '"]').first()).toBeVisible();

    // Registrar → queda ligada a la OS (chip "OS N" en la tarjeta).
    const desc = `M5 falla ${Date.now()}`;
    await modalB.getByPlaceholder(/qué falló y en qué condiciones/i).fill(desc);
    await modalB.getByRole("button", { name: /registrar garantía/i }).click();
    await expect(
      page.locator("[data-sonner-toaster]").getByText(/garantía registrada/i).first(),
    ).toBeVisible({ timeout: 15000 });
    const card = page.locator("div.rounded-xl.border", { hasText: desc }).first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card.getByRole("button", { name: `OS ${os}` })).toBeVisible();

    // API: la garantía trae el entryId y el proveedor prellenado.
    const list = await getJson(request, `/warranties?idWorkshop=${ID_WORKSHOP}`);
    const rows = list?.warranties ?? list ?? [];
    const w = rows.find((x) => x?.description === desc);
    expect(w, "garantía creada desde el módulo").toBeTruthy();
    expect(w.entryId).toBe(entryId);
    expect(Number(w.cost)).toBe(980);
  },
);
