const { test, expect } = require("@playwright/test");
const { modo } = require("../../adminFlex");
const { authHeaders } = require("#apiToken");

/**
 * ─────────────────────────────────────────────────────────────────────────
 * OBS31-02 / OBS31-11 — No hay forma de ENTREGAR un auto NO APROBADO  @ui
 * SPEC DE REPRODUCCIÓN (nuevo): primero demuestra el hueco, luego valida
 * los botones nuevos y la pantalla de entregados.
 *
 * Lo que reportó Roberto (31-ago): los "no aprobados" nunca se entregan
 * formalmente → nunca salen del conteo del CC (26 vs 20, OBS31-02). Y pidió
 * (OBS31-11): botón de ENTREGA debajo de "NO APROBADO", botón de ANTICIPO
 * también ahí (se cobra el diagnóstico), y la pantalla de Vehículos
 * entregados con No. de OS, orden por fecha de entrega y separación
 * "aceptaron / no aceptaron".
 *
 * CONTRA EL CÓDIGO DE HOY se espera:
 *   caso 1 VERDE  = el no aprobado sí se lista en su pestaña
 *   caso 2 ROJO   = no existe el botón Anticipo en No Aprobados
 *   caso 3 ROJO   = no existe el botón Entregar (el hueco de OBS31-02)
 *   caso 4 (tras el 3) = entregados con No. de OS y filtro no aceptaron
 * Tras el fix, todo verde.
 *
 * CONTRATO DE UI QUE FIRMA (los nombres accesibles del fix):
 *   - Renglón de No Aprobados: botones "Anticipo" y "Entregar".
 *   - Confirmación de entrega: diálogo con botón "Confirmar entrega".
 *   - Vehículos entregados: filtro con botones "No aceptaron" / "Aceptaron"
 *     y control "Ordenar por fecha de entrega"; cada renglón muestra la OS.
 *
 * CÓMO CORRE: contra emuladores (terminal limpia, npm run serve + backend +
 * front local) o contra QA con AUTH_REAL/SKIP_SEED/API/ID_WORKSHOP/
 * SEED_EMAIL/SEED_PASSWORD (Dueño) y BASE_URL del front.
 *   npx playwright test --project=qa tests/qa/OBS31-02-11_entrega-no-aprobados.ui.spec.js
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
const CODE_CAR = `NA-${S}`.slice(0, 8);

let entryId, osSheet;

async function post(request, path, body) {
  const res = await request.post(`${API}${path}`, { data: body, headers: await authHeaders() });
  if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()}: ${await res.text()}`);
  const json = await res.json().catch(() => null);
  return json?.data ?? json;
}
async function put(request, path, body) {
  const res = await request.put(`${API}${path}`, { data: body, headers: await authHeaders() });
  if (!res.ok()) throw new Error(`PUT ${path} -> ${res.status()}: ${await res.text()}`);
  const json = await res.json().catch(() => null);
  return json?.data ?? json;
}
async function get(request, path) {
  const res = await request.get(`${API}${path}`, { headers: await authHeaders() });
  const json = await res.json().catch(() => null);
  return json?.data ?? json;
}
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;
const payloadDe = (r) => (r?.descripcion && typeof r.descripcion === "object" ? r.descripcion : r);

async function entrarComo(page, { correo, password }) {
  await page.goto("/login");
  await page.locator("#email").fill(correo);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });
}

/** La tarjeta del auto del spec en la pestaña No Aprobados.
 * OJO (corregido tras un falso rojo): debe ser el elemento más interno que
 * contiene las placas Y botones — el div de puro texto de las placas también
 * hace match de hasText y no trae ninguna acción dentro. */
function filaDelAuto(page) {
  return page
    .locator("div")
    .filter({ hasText: CODE_CAR })
    .filter({ has: page.getByRole("button") })
    .last();
}

test.describe.configure({ mode: "serial" });

test.describe("OBS31-02/11 · entregar desde No Aprobados y pantalla de entregados @ui", () => {
  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const cliente = await post(request, "/clients", {
      fullName: `Cliente obs3111 ${S}`,
      email: `obs3111.${S}@test.com`,
      phone: `57${S}00`.slice(0, 10),
      idWorkshop: ID_WORKSHOP,
      createdBy: MECHANIC_ID,
    });
    const auto = await post(request, "/cars", {
      clientId: idOf(cliente), brand: "Kia", model: "Rio", year: 2021,
      vin: `NAVIN${S}000000000`.slice(0, 17), codeCar: CODE_CAR,
      color: "Negro", fuel: "Gasolina", transmition: "Manual", km: 33000,
    });
    const os = await post(request, "/entries", {
      idWorkshop: ID_WORKSHOP, clientId: idOf(cliente), carId: idOf(auto),
      assigned_mechanic: MECHANIC_ID, status: 1,
      observations: "spec OBS31-02/11 UI (entrega desde No Aprobados)",
      registerDate: Date.now(), approvalState: "EN ESPERA",
    });
    entryId = idOf(os);
    await post(request, `/entries/${entryId}/service-sheet`, {
      car_items: ["Documentos"], checks: ["Diagnóstico general"],
      isCheckAll: false, observations: "spec OBS31-02/11 UI", km: 33000, fuel_tank: "1/2",
    });
    await post(request, `/entries/${entryId}/diagnostics`, {
      generalObservations: "spec OBS31-02/11 UI",
      findings: [{
        system: "Suspensión", component: "Amortiguadores",
        finding: `Fuga de aceite en amortiguador ${S}`, severity: "AMARILLO",
        recommendation: "Reemplazo del par trasero",
        commercialDescription: "Sus amortiguadores traseros ya gotean",
        consequence: "El auto rebota y frena peor",
      }],
      idMechanic: MECHANIC_ID,
    });
    await post(request, `/entries/${entryId}/quotes`, {
      diagnostic: "AMARILLO · Sus amortiguadores traseros ya gotean",
      labor: [{ description: "Cambio de amortiguadores", count: 1, unitPrice: 900, cost: 900, subtotal: 900, state: true }],
      parts: [],
      status: 2,
      clientBringsParts: false,
      stage: "COTIZACION",
    });
    // El cliente dice que NO: la OS queda NO APROBADA.
    await put(request, `/entries/${entryId}`, { approvalState: "NO APROBADA" });
    const e = payloadDe(await get(request, `/entries/${entryId}`));
    osSheet = String(e?.sheet ?? "");
    await request.dispose();
  });

  test.afterAll("limpieza: baja lógica de la OS del spec, pase lo que pase", async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    if (entryId) {
      await ctx.delete(`${API}/entries/${entryId}`, { headers: await authHeaders() }).catch(() => {});
    }
    await ctx.dispose();
  });

  test("1) el no aprobado se lista en su pestaña (flujo intacto)", async ({ page }) => {
    await entrarComo(page, DUENO);
    await page.goto("/registro?tab=no-aprobados");
    await expect(page.getByText(CODE_CAR).first()).toBeVisible({ timeout: 20000 });
  });

  test("2) ROJO esperado hoy: el renglón ofrece ANTICIPO (ahí se cobra el diagnóstico)", async ({ page }) => {
    await entrarComo(page, DUENO);
    await page.goto("/registro?tab=no-aprobados");
    await expect(page.getByText(CODE_CAR).first()).toBeVisible({ timeout: 20000 });
    await expect(
      filaDelAuto(page).getByRole("button", { name: /anticipo/i }).first(),
      "OBS31-11: en No Aprobados debe haber botón de Anticipo (cobro del diagnóstico)",
    ).toBeVisible();
  });

  test("3) ROJO esperado hoy: el renglón ofrece ENTREGAR y la entrega lo saca de la pestaña", async ({ page }) => {
    await entrarComo(page, DUENO);
    await page.goto("/registro?tab=no-aprobados");
    await expect(page.getByText(CODE_CAR).first()).toBeVisible({ timeout: 20000 });

    const btn = filaDelAuto(page).getByRole("button", { name: /entregar/i }).first();
    await expect(btn, "OBS31-02: el hueco exacto — no hay forma de entregar un no aprobado").toBeVisible();
    await btn.click();

    // La entrega cierra el expediente: debe pedir confirmación explícita.
    await page.getByRole("button", { name: /confirmar entrega/i }).click();

    // El auto sale de No Aprobados (y con eso, del conteo del CC).
    await expect(page.getByText(CODE_CAR)).toHaveCount(0, { timeout: 20000 });
  });

  test("4) Vehículos entregados: No. de OS visible y el filtro 'No aceptaron' lo encuentra", async ({ page }) => {
    await entrarComo(page, DUENO);
    await page.goto("/servicios-entregados");
    await expect(page.getByRole("heading", { name: /veh[ií]culos entregados/i })).toBeVisible({ timeout: 20000 });

    // Separación pedida por Roberto: aceptaron / no aceptaron.
    // OJO: la pantalla pinta tarjetas móviles (lg:hidden, ocultas en este
    // viewport) Y la tabla de escritorio con los mismos datos; se aserta
    // sobre la ÚLTIMA aparición (la tabla), no la primera (oculta).
    await page.getByRole("button", { name: /no aceptaron/i }).click();
    await expect(page.getByText(CODE_CAR).last()).toBeVisible({ timeout: 20000 });
    if (osSheet) {
      await expect(
        page.getByText(new RegExp(`${osSheet}`)).last(),
        "cada renglón debe mostrar el No. de OS",
      ).toBeVisible();
    }

    // En "Aceptaron" NO debe aparecer (se entregó sin autorización).
    await page.getByRole("button", { name: /^aceptaron/i }).click();
    await expect(page.getByText(CODE_CAR)).toHaveCount(0, { timeout: 20000 });

    // Y existe el control de orden por fecha de entrega (OBS31-11).
    await expect(page.getByLabel(/ordenar por fecha de entrega/i)).toBeVisible();
  });
});
