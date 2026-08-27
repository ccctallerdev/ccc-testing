const { test, expect } = require("@playwright/test");
const { db: qaDb, auth: qaAuth, modo } = require("../../adminFlex");
const { authHeaders } = require("#apiToken");

/**
 * ─────────────────────────────────────────────────────────────────────────
 * EL COSTEO: PUERTA DESDE LA TARJETA Y REAPERTURA — PANTALLAS  @ui
 *
 * Contraparte de UI de `costeo-reabrir.qa.spec.js` (regla del 26-ago: API
 * amplia + UI angosta). Puntos n17 y n18 del BACKLOG_TECNICO:
 *
 *   1. El Dueño ve el chip "Costeo" en la tarjeta de la OS y entra por ahí.
 *      Antes el Costeo estaba dos niveles adentro (dentro de la tarjeta de
 *      cada diagnóstico) y nada en esta pantalla insinuaba que existiera; el
 *      chip de Cotización llevaba al formulario en blanco y la orden nacía
 *      sin costo de proveedor.
 *   2. Al guardar, el chip pasa de gris a azul con su palomita.
 *   3. Al Asesor NO se le pinta el chip: `/costeo` exige
 *      CAN_VIEW_COST_VS_PRICE y antes lo botaba al dashboard sin avisar
 *      (punto n13 del backlog).
 *   4. Volver a entrar muestra lo que ya capturó y avisa que está
 *      CORRIGIENDO, no creando otro costeo.
 *
 * Nota: el chip entra a `/costeo/:id` SIN `?diagnosticId=` — la tarjeta no
 * conoce ese id. La pantalla ahora resuelve sola el diagnóstico más reciente;
 * antes se quedaba en "Falta el diagnóstico de origen".
 *
 * Precondición por API (infraestructura, no el flujo que se prueba): la OS
 * con su hoja y su diagnóstico. El recorrido de esos pasos por UI ya vive en
 * `tests/e2e_v2/recorrido-ui-completo.spec.js`.
 *
 * CÓMO CORRE:
 *   EMULADORES: emuladores + backend + frontend + `node seed_emulator_user.js`
 *     npx playwright test --project=qa tests/qa/costeo-reabrir-ui.qa.spec.js
 *   REFAC: $env:AUTH_REAL="1"; ID_WORKSHOP, SEED_EMAIL, SEED_PASSWORD, BASE_URL.
 * ─────────────────────────────────────────────────────────────────────────
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || (modo === "emulador" ? "taller-prueba" : null);
if (!ID_WORKSHOP) {
  throw new Error('Falta ID_WORKSHOP (taller real de refac). Ej: $env:ID_WORKSHOP="05Pf..."');
}
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";
const DUENO = {
  correo: process.env.SEED_EMAIL || "prueba@ccc.test",
  password: process.env.SEED_PASSWORD || "prueba123",
};

const S = String(Date.now()).slice(-6);
const ASESOR = { correo: `asesor.costeochip.${S}@ccc.test`, password: "Prueba1234!" };
const PLACAS = `CST${S}`.slice(0, 8);
const REFACCION = "Juego de balatas delanteras";
const COSTO_PROVEEDOR = "600";
const PRECIO_CLIENTE = "850";

const creados = { uids: [] };
let entryId;

async function post(request, path, body) {
  const res = await request.post(`${API}${path}`, { data: body, headers: await authHeaders() });
  if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()}: ${await res.text()}`);
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

/**
 * La tarjeta de la OS en /registro. `:visible` importa: la lista se pinta DOS
 * veces (CardsSmall visible + CardsLarge con `hidden`) y sin el filtro se
 * engancha la copia invisible.
 */
async function tarjetaDeLaOS(page) {
  await page.goto("/registro");
  const buscador = page.getByRole("textbox", { name: /buscar por no\. de os/i });
  if (await buscador.count()) {
    await buscador.fill(PLACAS);
    await page.getByRole("button", { name: /^buscar$/i }).click();
  }
  const tarjeta = page.locator("div.rounded-xl:visible", { hasText: PLACAS }).first();
  await expect(tarjeta, `no encuentro la OS de placas ${PLACAS} en /registro`)
    .toBeVisible({ timeout: 20000 });
  return tarjeta;
}

const filaRefaccion = (page) =>
  page
    .locator("div.grid")
    .filter({ has: page.getByPlaceholder(/Ej\. Filtro de aceite OEM/i) })
    .first();

test.describe.configure({ mode: "serial" });

test.describe("El Costeo: puerta desde la tarjeta y reapertura @ui", () => {
  test.beforeAll(async ({ playwright }) => {
    const user = await qaAuth().createUser({ email: ASESOR.correo, password: ASESOR.password });
    await qaAuth().setCustomUserClaims(user.uid, { role: "ASESOR", idWorkshop: ID_WORKSHOP });
    creados.uids.push(user.uid);
    // La app WEB carga `userData` de `users/{uid}`: sin este documento el login
    // "funciona" y te regresa a /login sin decir nada.
    const ahora = Date.now();
    await qaDb().collection("users").doc(user.uid).set({
      uid: user.uid, name: "Asesor", firstSurname: "Chip", secondSurname: "",
      email: ASESOR.correo, rol: "ASESOR", idWorkshop: ID_WORKSHOP,
      isActive: true, isDeleted: false, createdAt: ahora, updatedAt: ahora,
    }, { merge: true });

    const request = await playwright.request.newContext();
    const cliente = await post(request, "/clients", {
      fullName: `Cliente chip ${S}`, email: `chip.${S}@test.com`,
      phone: `55${S}1111`.slice(0, 10), idWorkshop: ID_WORKSHOP, createdBy: MECHANIC_ID,
    });
    const auto = await post(request, "/cars", {
      clientId: idOf(cliente), brand: "Nissan", model: "Versa", year: 2021,
      vin: `CHVIN${S}00000000`.slice(0, 17), codeCar: PLACAS,
      color: "Blanco", fuel: "Gasolina", transmition: "Automática", km: 40000,
    });
    const os = await post(request, "/entries", {
      idWorkshop: ID_WORKSHOP, clientId: idOf(cliente), carId: idOf(auto),
      assigned_mechanic: MECHANIC_ID, status: 1,
      observations: "spec costeo-reabrir-ui (backlog n17/n18)",
      registerDate: Date.now(), approvalState: "EN ESPERA",
    });
    entryId = idOf(os);
    await post(request, `/entries/${entryId}/service-sheet`, {
      car_items: ["Documentos", "Llave"], checks: ["Servicio de Frenos"],
      isCheckAll: false, observations: "spec UI", km: 40000, fuel_tank: "1/2",
    });
    await post(request, `/entries/${entryId}/diagnostics`, {
      generalObservations: "Ruido metálico al frenar.",
      findings: [{
        system: "Frenos", component: "Balatas delanteras",
        finding: "Contacto metal-metal, espesor por debajo del mínimo",
        severity: "ROJO", recommendation: "Reemplazo del juego delantero",
      }],
      idMechanic: MECHANIC_ID,
    });
    await request.dispose();
  });

  test.afterAll(async () => {
    for (const uid of creados.uids) {
      await qaDb().collection("users").doc(uid).delete().catch(() => {});
      await qaAuth().deleteUser(uid).catch(() => {});
    }
  });

  test("el Dueño llega al Costeo desde la tarjeta de la OS, sin escribir la URL", async ({ page }) => {
    await entrarComo(page, DUENO);
    const tarjeta = await tarjetaDeLaOS(page);

    const chip = tarjeta.getByRole("button", { name: /^costeo$/i });
    await expect(chip, "punto n17: la tarjeta de la OS no tenía puerta al Costeo")
      .toBeVisible({ timeout: 15000 });
    await chip.click();

    // El chip entra SIN ?diagnosticId=: la pantalla resuelve el diagnóstico sola.
    await expect(page).toHaveURL(/\/costeo\//, { timeout: 20000 });
    await expect(page.getByRole("heading", { name: /^Costeo$/ })).toBeVisible({ timeout: 20000 });
    await expect(
      page.getByText(/falta el diagn[oó]stico de origen/i),
      "entrar sin ?diagnosticId= dejaba la pantalla muerta",
    ).toHaveCount(0);

    const fila = filaRefaccion(page);
    await fila.getByPlaceholder(/Ej\. Filtro de aceite OEM/i).fill(REFACCION);
    const campos = fila.locator("input");
    await campos.nth(1).fill("2");
    await campos.nth(2).fill(COSTO_PROVEEDOR);
    await campos.nth(4).fill(PRECIO_CLIENTE);

    const guardar = page.getByRole("button", { name: /guardar costeo/i });
    await expect(guardar).toBeEnabled({ timeout: 10000 });
    await guardar.click();
    await expect(page).toHaveURL(/\/cotizacion-vista\//, { timeout: 20000 });
  });

  test("ya costeada, el chip se pinta como etapa hecha", async ({ page }) => {
    await entrarComo(page, DUENO);
    const tarjeta = await tarjetaDeLaOS(page);
    await expect(
      tarjeta.getByRole("button", { name: /costeo\s*✓/i }),
      "el chip debe pasar de gris a azul con palomita, como los otros",
    ).toBeVisible({ timeout: 15000 });
  });

  test("al Asesor NO se le pinta el chip de Costeo", async ({ page }) => {
    await entrarComo(page, ASESOR);
    const tarjeta = await tarjetaDeLaOS(page);
    // Punto n13: antes el botón se le mostraba y lo botaba al dashboard sin
    // explicación. `/costeo` exige CAN_VIEW_COST_VS_PRICE (Dueño y Admin).
    await expect(
      tarjeta.getByRole("button", { name: /costeo/i }),
      "el Asesor no puede entrar al Costeo: no debe verse el chip",
    ).toHaveCount(0);
  });

  test("volver a entrar muestra lo capturado y avisa que está corrigiendo", async ({ page }) => {
    await entrarComo(page, DUENO);
    const tarjeta = await tarjetaDeLaOS(page);
    await tarjeta.getByRole("button", { name: /costeo/i }).click();
    await expect(page.getByRole("heading", { name: /^Costeo$/ })).toBeVisible({ timeout: 20000 });

    await expect(
      page.getByText(/est[aá]s\s+corrigiendo el costeo/i),
      "punto n18: reabrir arrancaba en blanco y guardar creaba otra cotización",
    ).toBeVisible({ timeout: 15000 });

    const fila = filaRefaccion(page);
    await expect(fila.getByPlaceholder(/Ej\. Filtro de aceite OEM/i)).toHaveValue(
      new RegExp(REFACCION.slice(0, 12), "i"),
      { timeout: 15000 },
    );
    await expect(fila.locator("input").nth(2)).toHaveValue(new RegExp(COSTO_PROVEEDOR));
  });
});
