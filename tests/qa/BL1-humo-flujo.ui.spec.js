const { test, expect } = require("@playwright/test");
const { modo } = require("../../adminFlex");
const { authHeaders } = require("#apiToken");

/**
 * ─────────────────────────────────────────────────────────────────────────
 * BL-1 — HUMO de UI tras blindar las escrituras  @ui
 *
 * El blindaje de fix/bl1-escrituras-blindadas-api endureció los schemas:
 * una OS solo nace con status 1 y EN ESPERA, y el `status` de cotizaciones
 * y diagnósticos quedó con catálogo cerrado (1..4). Este spec verifica que
 * los CAMINOS LEGÍTIMOS del front siguen enteros:
 *
 *   1. El alta completa por el asistente (cliente y vehículo nuevo, 3
 *      pasos) — el camino de NACIMIENTO que se endureció.
 *   2. La aprobación desde el listado (Select de estatus → Aprobada, con
 *      selección oficial automática) — el PUT con approvedDate.
 *
 * El tercer camino tocado (diagnóstico → costeo → cotización por UI) ya lo
 * cubre OBS-12-13_diagnostico-cruzado.ui.spec.js: correrlo JUNTO con este.
 *
 * Espía de red incluido (patrón del e2e_v2): si algo truena, la salida dice
 * exactamente qué llamada devolvió error — varios hooks tragan errores y un
 * 400 se vería como "no pasó nada".
 *
 * CÓMO CORRE: emuladores + backend local + front local (npm start), o
 * contra QA con las $env de siempre + BASE_URL.
 *   npx playwright test --project=qa tests/qa/BL1-humo-flujo.ui.spec.js
 * ─────────────────────────────────────────────────────────────────────────
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || (modo === "emulador" ? "taller-prueba" : null);
if (!ID_WORKSHOP) throw new Error('Falta ID_WORKSHOP. Ej: $env:ID_WORKSHOP="G85F..."');
const DUENO = {
  correo: process.env.SEED_EMAIL || "prueba@ccc.test",
  password: process.env.SEED_PASSWORD || "prueba123",
};
const MECANICO = process.env.MECANICO_NOMBRE || "Mecánico Prueba";

const S = String(Date.now()).slice(-6);
const CLIENTE = { nombre: `Homero Humo BL1`, telefono: `53${S}88`.slice(0, 10), correo: `bl1.humo.${S}@ccc.test` };
const AUTO = {
  marca: "Nissan", modelo: "Versa", anio: "2021", color: "Blanco",
  placas: `HUM${S}`.slice(0, 8), vin: `3N1CN7AD5HU${S}9`.slice(0, 17),
  transmision: "Automática", km: "35000", combustible: "Gasolina",
  falla: "Humo BL-1: alta legítima tras el blindaje de escrituras.",
};

const literal = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let entryId = null, carIdCreado = null;

async function call(request, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: await authHeaders(),
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json, data: json?.data ?? json };
}
const payloadDe = (r) =>
  r.data?.descripcion && typeof r.data.descripcion === "object" ? r.data.descripcion : r.data;

async function iniciarSesion(page, correo, password) {
  await page.goto("/login");
  await page.locator("#email").fill(correo);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 30000 });
}

/** Combobox "escribe y ELIGE": teclear no basta, hay que clicar la opción. */
async function elegirDeLista(page, placeholderRe, valor) {
  const input = page.getByPlaceholder(placeholderRe);
  await input.fill(valor);
  const opcion = page.getByRole("button", { name: new RegExp(`^${literal(valor)}$`) }).first();
  await opcion.waitFor({ timeout: 10000 });
  await opcion.click();
}

/** Mecánico = CreatableSelect: clic en la opción REAL (nunca Enter). */
async function elegirMecanico(page, nombre) {
  const input = page.locator('input[id^="react-select"][id$="-input"]').first();
  await input.click({ force: true });
  await input.pressSequentially(nombre);
  const opcion = page
    .locator('[id*="-option-"]')
    .filter({ hasText: new RegExp(`^${literal(nombre)}`) })
    .first();
  await expect(opcion, `«${nombre}» no aparece en la lista de mecánicos`).toBeVisible({ timeout: 10000 });
  await opcion.click();
}

function espiarRed(page, red) {
  page.on("response", async (res) => {
    if (res.request().method() === "GET") return;
    if (!/\/(entries|clients|cars|tokens)/.test(res.url())) return;
    if (res.status() < 400) return;
    let cuerpo = "";
    try { cuerpo = (await res.text()).slice(0, 400); } catch {}
    red.push(`${res.request().method()} ${new URL(res.url()).pathname} → ${res.status()} ${cuerpo}`);
  });
  page.on("pageerror", (e) => red.push(`PAGEERROR: ${e.message}`));
}

test.describe.configure({ mode: "serial" });

test.describe("BL-1 · humo: los caminos legítimos siguen enteros tras el blindaje @ui", () => {
  test("1) el alta completa por el asistente registra la OS (el nacimiento blindado)", async ({ page }) => {
    const red = [];
    espiarRed(page, red);

    await iniciarSesion(page, DUENO.correo, DUENO.password);
    await page.goto("/registro");
    await page.getByRole("button", { name: /nueva entrada/i }).click();
    await page.getByRole("button", { name: /cliente y veh[ií]culo nuevo/i }).click();
    await expect(page).toHaveURL(/crear-cliente-vehiculo/, { timeout: 20000 });

    // Paso 1 — cliente
    await page.locator("#name").fill(CLIENTE.nombre);
    await page.locator("#phone").fill(CLIENTE.telefono);
    await page.locator("#email").fill(CLIENTE.correo);
    await page.getByRole("button", { name: /^siguiente$/i }).click();
    const confirmar = page.getByRole("button", { name: /afiliar|s[ií], continuar|confirmar/i }).first();
    if (await confirmar.isVisible({ timeout: 4000 }).catch(() => false)) await confirmar.click();

    // Paso 2 — vehículo
    await expect(page.locator("#codeCar")).toBeVisible({ timeout: 20000 });
    await elegirDeLista(page, /escribe o selecciona una marca/i, AUTO.marca);
    await elegirDeLista(page, /el modelo|modelo \(libre\)|primero elige/i, AUTO.modelo);
    await page.locator("#year").fill(AUTO.anio);
    await elegirDeLista(page, /escribe o selecciona un color/i, AUTO.color);
    await page.locator("#codeCar").fill(AUTO.placas);
    await page.locator("#vin").fill(AUTO.vin);
    await page.locator("#transmition").selectOption(AUTO.transmision);
    await page.locator("#car-km").fill(AUTO.km);
    await page.locator("#car-fuel").selectOption(AUTO.combustible);
    await elegirMecanico(page, MECANICO);
    await page.locator("#car-issue-desc").fill(AUTO.falla);
    await page.getByRole("button", { name: /^siguiente$/i }).click();

    // Paso 3 — hoja de servicio y registro
    await expect(page.locator("#selectAll")).toBeVisible({ timeout: 20000 });
    await page.locator("#selectAll").check();
    const tanque = page.locator('[data-entry-sheet-field="fuel_tank"]');
    if (await tanque.count()) await tanque.getByText("1/2", { exact: true }).click();
    else await page.getByRole("button", { name: "1/2" }).first().click();
    await page.getByRole("button", { name: /diagn[oó]stico\/fallas reportadas/i }).click();
    await page
      .locator("label", { has: page.locator('input[type="checkbox"]') })
      .first()
      .click();
    await page
      .getByPlaceholder(/describa los aspectos generales/i)
      .fill("Humo BL-1: sin daños visibles.");

    await page.getByRole("button", { name: /registrar y continuar/i }).click();

    // Camino FELIZ: aparece "Finalizar" (la pantalla de éxito del wizard).
    await expect(
      page.getByRole("button", { name: /finalizar/i }),
      `el alta legítima debió completarse. Red con error:\n${red.join("\n") || "(sin errores de red)"}`,
    ).toBeVisible({ timeout: 30000 });
    await page.getByRole("button", { name: /finalizar/i }).click();

    // Y la OS existe: se localiza por API para los casos siguientes.
    await expect
      .poll(async () => {
        const r = await call(page.request, "get", `/entries?idWorkshop=${ID_WORKSHOP}&status=1&search=${encodeURIComponent(AUTO.placas)}`);
        const filas = payloadDe(r)?.entries || [];
        const mia = filas.find((e) => String(e.codeCar || "").toUpperCase() === AUTO.placas.toUpperCase());
        if (mia) { entryId = mia.id; carIdCreado = mia.carId; }
        return Boolean(mia);
      }, { timeout: 15000, message: "la OS del alta debe existir en el API" })
      .toBe(true);
  });

  test("2) la aprobación desde el listado sigue funcionando (selección oficial automática)", async ({ page, request }) => {
    expect(entryId, "requiere la OS del caso 1").toBeTruthy();
    // Cotización legítima con precios (por API, como la captura el Asesor).
    const cot = await call(request, "post", `/entries/${entryId}/quotes`, {
      diagnostic: "Humo BL-1",
      labor: [{ description: "Afinación", count: 1, unitPrice: 500, cost: 500, subtotal: 500, state: true }],
      parts: [],
      status: 2,
      clientBringsParts: false,
      stage: "COTIZACION",
    });
    expect(cot.status, JSON.stringify(cot.body)).toBeLessThan(300);

    const red = [];
    espiarRed(page, red);
    await iniciarSesion(page, DUENO.correo, DUENO.password);
    await page.goto("/registro");
    await expect(page.getByText(AUTO.placas).first()).toBeVisible({ timeout: 20000 });

    // La tarjeta VISIBLE del auto. OJO (aprendido en el spec de entregados):
    // Entrada pinta tarjetas (visibles) Y una tabla de escritorio con
    // className "hidden" que también trae .ant-select — hay que exigir
    // visibilidad o el clic muere en la copia invisible.
    const tarjeta = page
      .locator("div.rounded-xl")
      .filter({ hasText: AUTO.placas })
      .filter({ has: page.locator(".ant-select") })
      .first();
    await tarjeta.locator(".ant-select:visible").first().click();
    await page.locator(".ant-select-item-option").filter({ hasText: /^\s*Aprobada\s*$/i }).first().click();

    // El flujo: selección oficial automática (1 cotización + 1 hoja) + PUT
    // de aprobación con approvedDate. La aserción fuerte es el DATO:
    await expect
      .poll(async () => {
        const r = await call(page.request, "get", `/entries/${entryId}`);
        return payloadDe(r)?.approvalState;
      }, { timeout: 20000, message: `la OS debió quedar APROBADA. Red con error:\n${red.join("\n") || "(sin errores de red)"}` })
      .toBe("APROBADA");
  });

  test.afterAll("limpieza: baja lógica de lo creado, pase lo que pase", async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    if (entryId) await ctx.delete(`${API}/entries/${entryId}`, { headers: await authHeaders() }).catch(() => {});
    if (carIdCreado) await ctx.delete(`${API}/cars/${carIdCreado}`, { headers: await authHeaders() }).catch(() => {});
    await ctx.dispose();
  });
});
