const { test, expect } = require("@playwright/test");
const { authHeaders } = require("../apiToken");
const fs = require("fs");

/**
 * CORE impresión — PDF real con jsPDF (ya no captura de pantalla):
 *   - "Imprimir" en cotización descarga cotizacion-<folio>.pdf
 *   - "Imprimir" en hoja de servicio descarga hoja-servicio-OS<os>.pdf
 *   - Ambos son PDFs válidos (magic %PDF) y no triviales de tamaño.
 *
 * PRERREQUISITOS: emuladores + backend + frontend (global-setup siembra admin).
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC = "mecanico-prueba";
const ADMIN_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const ADMIN_PASSWORD = process.env.SEED_PASSWORD || "prueba123";

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

async function makeApprovedOs(request) {
  const s = `${String(Date.now()).slice(-6)}77`;
  const client = await post(request, "/clients", {
    fullName: `Cliente PDF ${s}`,
    email: `pdf.${s}@test.com`,
    phone: `61${s}`,
    idWorkshop: ID_WORKSHOP,
    createdBy: MECHANIC,
  });
  const car = await post(request, "/cars", {
    clientId: idOf(client),
    brand: "Honda",
    model: "CR-V",
    year: 2024,
    vin: `PDF${s}0000000000`.slice(0, 17),
    codeCar: `PD${s.slice(-4)}`,
    color: "Plata",
    fuel: "Gasolina",
    transmition: "Automática",
    km: 12000,
  });
  const entry = await post(request, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId: idOf(client),
    carId: idOf(car),
    assigned_mechanic: MECHANIC,
    status: 1,
    observations: "PDF real",
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  });
  const entryId = idOf(entry);
  await post(request, `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos", "Llave", "Gato"],
    checks: ["Servicio de Frenos", "Cambio de aceite"],
    isCheckAll: false,
    observations: "Rayón leve en defensa trasera; interiores limpios.",
    km: 12000,
    fuel_tank: "3/4",
  });
  await post(request, `/entries/${entryId}/quotes`, {
    diagnostic: "Balatas al 20% y aceite degradado; se recomienda servicio mayor.",
    labor: [{ description: "Servicio mayor", count: 1, cost: 1800, subtotal: 1800 }],
    parts: [{ description: "Balatas delanteras", count: 2, cost: 850, subtotal: 1700 }],
    status: 2,
    stage: "COTIZACION",
    advance: 500,
  });
  const quotes = (await getJson(request, `/entries/${entryId}/quotes?limit=10`))?.quotes ?? [];
  const sheets = (await getJson(request, `/entries/${entryId}/service-sheet?limit=10`))?.serviceSheets ?? [];
  await put(request, `/entries/${entryId}/approve-selection`, {
    approvedQuoteId: idOf(quotes[0]),
    approvedServiceSheetId: idOf(sheets[0]),
  });
  await put(request, `/entries/${entryId}`, { approvalState: "APROBADA" });
  return {
    entryId,
    os: entry?.sheet,
    quoteId: idOf(quotes[0]),
    sheetId: idOf(sheets[0]),
  };
}

async function login(page) {
  await page.goto("/login");
  await page.locator("#email").fill(ADMIN_EMAIL);
  await page.locator("#password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });
}

async function expectValidPdf(download) {
  const path = await download.path();
  const buf = fs.readFileSync(path);
  expect(buf.subarray(0, 5).toString("latin1"), "magic del archivo").toBe("%PDF-");
  expect(buf.byteLength, "tamaño razonable").toBeGreaterThan(2000);
}

test("PDF real: Imprimir cotización descarga un PDF válido con folio en el nombre", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const { entryId, os, quoteId } = await makeApprovedOs(request);

  await login(page);
  await page.goto(`/cotizacion-vista/${entryId}?quoteId=${quoteId}`);

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }),
    page.getByRole("button", { name: /imprimir/i }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`cotizacion-OS${os}-01.pdf`);
  await expectValidPdf(download);
});

test("PDF real: Imprimir hoja de servicio descarga un PDF válido", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const { entryId, os, sheetId } = await makeApprovedOs(request);

  await login(page);
  // Con sheetId, como navega la app (sin él, la vista cae al modo lista
  // y el botón Imprimir no existe).
  await page.goto(`/hoja-servicio-vista/${entryId}?sheetId=${sheetId}`);

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }),
    page.getByRole("button", { name: /imprimir/i }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`hoja-servicio-OS${os}.pdf`);
  await expectValidPdf(download);
});
