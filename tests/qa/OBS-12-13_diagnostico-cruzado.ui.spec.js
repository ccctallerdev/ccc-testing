const { test, expect } = require("@playwright/test");
const { modo } = require("../../adminFlex");
const { authHeaders } = require("#apiToken");

/**
 * ─────────────────────────────────────────────────────────────────────────
 * OBS-12 / OBS-13 — El "Diagnóstico técnico" trae el texto equivocado  @ui
 * SPEC DE REPRODUCCIÓN (nuevo): primero demuestra el bug, luego valida el fix.
 *
 * Lo que reportó Roberto (y definió en D20, respondida el 31-ago):
 *   - Los hallazgos son "el corazón del diagnóstico": en la cotización, el
 *     Diagnóstico técnico debe traer su TRADUCCIÓN COMERCIAL — los renglones
 *     del semáforo (rojo por omisión; amarillo/verde seleccionables).
 *   - Hoy pasa al revés: las OBSERVACIONES GENERALES del mecánico se van al
 *     Diagnóstico técnico (useCosteo.save: diagnostic = generalObservations)
 *     y los HALLAZGOS crudos aterrizan como renglones de "Mano de obra"
 *     (labor = included.map(...)).
 *
 * CONTRA EL CÓDIGO DE HOY se espera: caso 1 VERDE (el guardado funciona) y
 * casos 2 y 3 ROJOS (texto cruzado) = bug reproducido. Tras el fix, todo verde.
 *
 * CÓMO CORRE (REFAC): $env:AUTH_REAL="1"; SKIP_SEED="1"; API, ID_WORKSHOP,
 *   SEED_EMAIL, SEED_PASSWORD (Dueño) y BASE_URL del front de QA.
 *   npx playwright test --project=qa tests/qa/OBS-12-13_diagnostico-cruzado.ui.spec.js
 * ─────────────────────────────────────────────────────────────────────────
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || (modo === "emulador" ? "taller-prueba" : null);
if (!ID_WORKSHOP) throw new Error('Falta ID_WORKSHOP. Ej: $env:ID_WORKSHOP="G85F..."');
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";
const DUENO = {
  correo: process.env.SEED_EMAIL || "prueba@ccc.test",
  password: process.env.SEED_PASSWORD || "prueba123",
};
const S = String(Date.now()).slice(-6);

// Textos DISTINTIVOS para poder afirmar sin ambigüedad quién acabó dónde.
const OBSERVACIONES_GENERALES = `Rayones previos en el cofre y tapón de gasolina flojo [obs-${S}]`;
const HALLAZGO_TECNICO = "Contacto metal-metal, espesor por debajo del mínimo";
const TRADUCCION_COMERCIAL = `Sus balatas están al límite: frenar ya daña el disco y alarga la distancia de frenado [com-${S}]`;

let entryId;

async function post(request, path, body) {
  const res = await request.post(`${API}${path}`, { data: body, headers: await authHeaders() });
  if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()}: ${await res.text()}`);
  const json = await res.json().catch(() => null);
  return json?.data ?? json;
}
async function get(request, path) {
  const res = await request.get(`${API}${path}`, { headers: await authHeaders() });
  const json = await res.json().catch(() => null);
  return json?.data ?? json;
}
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

async function entrarComo(page, { correo, password }) {
  await page.goto("/login");
  await page.locator("#email").fill(correo);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });
}

async function abrirCosteo(page) {
  await page.goto(`/diagnostico-vista/${entryId}`);
  await page.getByRole("button", { name: /^costeo$/i }).first().click();
  await expect(page.getByRole("heading", { name: /^Costeo$/ })).toBeVisible({ timeout: 20000 });
}

/** La cotización/costeo que nació del guardado (la más reciente de la OS). */
async function costeoGuardado(request) {
  const r = await get(request, `/entries/${entryId}/quotes?limit=10`);
  const bloque = r?.descripcion && typeof r.descripcion === "object" ? r.descripcion : r;
  const quotes = (bloque?.quotes || []).filter((q) => !q.isDeleted);
  expect(quotes.length, "el guardado del Costeo debió crear una cotización").toBeGreaterThan(0);
  return quotes.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
}

test.describe.configure({ mode: "serial" });

test.describe("OBS-12/13 · el Diagnóstico técnico deja de traer el texto cruzado @ui", () => {
  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const cliente = await post(request, "/clients", {
      fullName: `Cliente obs12-13 ${S}`,
      email: `obs1213.${S}@test.com`,
      phone: `58${S}00`.slice(0, 10),
      idWorkshop: ID_WORKSHOP,
      createdBy: MECHANIC_ID,
    });
    const auto = await post(request, "/cars", {
      clientId: idOf(cliente), brand: "Mazda", model: "3", year: 2020,
      vin: `DXVIN${S}000000000`.slice(0, 17), codeCar: `DX-${S}`.slice(0, 8),
      color: "Azul", fuel: "Gasolina", transmition: "Manual", km: 52000,
    });
    const os = await post(request, "/entries", {
      idWorkshop: ID_WORKSHOP, clientId: idOf(cliente), carId: idOf(auto),
      assigned_mechanic: MECHANIC_ID, status: 1,
      observations: "spec OBS-12/13 (diagnóstico cruzado)",
      registerDate: Date.now(), approvalState: "EN ESPERA",
    });
    entryId = idOf(os);
    await post(request, `/entries/${entryId}/service-sheet`, {
      car_items: ["Documentos"], checks: ["Servicio de Frenos"],
      isCheckAll: false, observations: "spec OBS-12/13", km: 52000, fuel_tank: "1/2",
    });
    // El diagnóstico del mecánico: hallazgo ROJO con su lente comercial +
    // observaciones generales claramente distintas.
    await post(request, `/entries/${entryId}/diagnostics`, {
      generalObservations: OBSERVACIONES_GENERALES,
      findings: [{
        system: "Frenos", component: "Balatas delanteras",
        finding: HALLAZGO_TECNICO,
        severity: "ROJO",
        recommendation: "Reemplazo inmediato del juego delantero",
        commercialDescription: TRADUCCION_COMERCIAL,
        consequence: "Riesgo de no frenar a tiempo",
      }],
      idMechanic: MECHANIC_ID,
    });
    await request.dispose();
  });

  test("1) el Dueño guarda el Costeo desde el diagnóstico (flujo intacto)", async ({ page }) => {
    await entrarComo(page, DUENO);
    await abrirCosteo(page);

    // Una refacción para que el costeo tenga sustancia (mismo patrón que
    // cotizacion-costeo-ui). El hallazgo ROJO viene incluido por omisión.
    const fila = page
      .locator("div.grid")
      .filter({ has: page.getByPlaceholder(/Ej\. Filtro de aceite OEM/i) })
      .last();
    await fila.getByPlaceholder(/Ej\. Filtro de aceite OEM/i).fill(`Juego de balatas ${S}`);
    const campos = fila.locator("input");
    await campos.nth(1).fill("2");   // cantidad
    await campos.nth(2).fill("600"); // costo proveedor
    await campos.nth(4).fill("850"); // precio cliente

    const guardar = page.getByRole("button", { name: /guardar costeo/i });
    await expect(guardar).toBeEnabled({ timeout: 10000 });
    await guardar.click();
    // Guardar el costeo CREA la cotización y lleva a la lista — la señal
    // inequívoca de que el POST ocurrió (mismo criterio que cotizacion-costeo-ui).
    await expect(page).toHaveURL(/\/cotizacion-vista\//, { timeout: 20000 });
  });

  test("2) OBS-12: el Diagnóstico técnico trae la traducción comercial, NO las observaciones generales", async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const q = await costeoGuardado(request);
    const texto = String(q.diagnostic || "");

    expect(
      texto.includes(TRADUCCION_COMERCIAL),
      `quote.diagnostic debe traer la traducción comercial del hallazgo ROJO.\nHoy trae: "${texto}"`,
    ).toBe(true);
    expect(
      texto.includes(`[obs-${S}]`),
      `quote.diagnostic NO debe ser las observaciones generales del mecánico.\nHoy trae: "${texto}"`,
    ).toBe(false);
  });

  test("3) OBS-13: los hallazgos NO aterrizan como renglones de Mano de obra", async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const q = await costeoGuardado(request);
    const laborConHallazgo = (q.labor || []).filter((l) =>
      String(l.description || "").includes(HALLAZGO_TECNICO),
    );
    expect(
      laborConHallazgo.length,
      `la Mano de obra no debe cargar el hallazgo crudo; renglones hoy: ${JSON.stringify((q.labor || []).map((l) => l.description))}`,
    ).toBe(0);
  });
});
