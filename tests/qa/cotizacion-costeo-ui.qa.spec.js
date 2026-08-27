const { test, expect } = require("@playwright/test");
// adminFlex decide solo: API en localhost -> EMULADORES; otra cosa -> refac.
const { db: qaDb, auth: qaAuth, modo } = require("../../adminFlex");
const { authHeaders } = require("#apiToken");

/**
 * ─────────────────────────────────────────────────────────────────────────
 * COSTEO -> COTIZACION — PANTALLAS  @ui
 *
 * La contraparte de UI de `cotizacion-costeo.qa.spec.js` (regla del 26-ago:
 * API amplia + UI angosta). Solo el camino feliz de las DOS pantallas que
 * toca el arreglo del punto 15 / obs 19-20:
 *
 *   1. El Dueño costea: captura costo de proveedor, utilidad y precio cliente.
 *   2. El Asesor abre la cotización que nació de ese costeo y el
 *      "Precio unitario" YA VIENE lleno (antes llegaba vacío y no dejaba
 *      guardar), completa la mano de obra y guarda.
 *
 * Lo que este spec NO prueba, a propósito: que el costo de proveedor
 * sobreviva al guardado del Asesor. Eso NO se puede ver por pantalla —
 * `PartsList` de la cotización no muestra `costProveedor`, y la pantalla de
 * Costeo **no recarga un costeo existente** (`useCosteo.load` solo trae la
 * entrada, el diagnóstico, los seguimientos y los proveedores: las partidas
 * siempre arrancan en blanco; ver backlog). Esa supervivencia la prueba el
 * spec de API `cotizacion-costeo.qa.spec.js`, hasta el `procurement` de la OS.
 *
 * Precondición por API (INFRAESTRUCTURA, no el flujo que se prueba): la OS
 * con su hoja de servicio y su diagnóstico. El recorrido completo de esos
 * pasos POR UI ya vive en `tests/e2e_v2/recorrido-ui-completo.spec.js`
 * (pasos 3 y 4); repetirlo aquí solo alargaría la corrida sin cubrir nada
 * nuevo. Lo que este spec prueba —Costeo y Cotización— va 100 % por clics.
 *
 * CÓMO CORRE:
 *   EMULADORES: emuladores + backend local + frontend + `node seed_emulator_user.js`
 *     npx playwright test --project=qa tests/qa/cotizacion-costeo-ui.qa.spec.js
 *   REFAC: $env:AUTH_REAL="1"; ID_WORKSHOP, SEED_EMAIL, SEED_PASSWORD y
 *   BASE_URL del entorno a probar; MECANICO_NOMBRE si aplica.
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
const ASESOR = { correo: `asesor.costeoui.${S}@ccc.test`, password: "Prueba1234!" };

const COSTO_PROVEEDOR = "600";
const PRECIO_CLIENTE = "850";
const REFACCION = "Juego de balatas delanteras";

const creados = { uids: [] };
let entryId;

// ── Precondición por API (infraestructura) ──────────────────────────────────
async function post(request, path, body) {
  const res = await request.post(`${API}${path}`, { data: body, headers: await authHeaders() });
  if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()}: ${await res.text()}`);
  const json = await res.json().catch(() => null);
  return json?.data ?? json;
}
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

// ── Helpers de UI (mismos selectores que e2e_v2) ────────────────────────────
async function entrarComo(page, { correo, password }) {
  await page.goto("/login");
  await page.locator("#email").fill(correo);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });
}

/** Entra al Costeo por CLIC (el botón agrega ?diagnosticId=; sin él la pantalla se queja). */
async function abrirCosteo(page) {
  await page.goto(`/diagnostico-vista/${entryId}`);
  await page.getByRole("button", { name: /^costeo$/i }).first().click();
  await expect(page.getByRole("heading", { name: /^Costeo$/ })).toBeVisible({ timeout: 20000 });
}

/** Renglón de refacción del Costeo/Cotización (se ancla por su placeholder). */
const filaRefaccion = (page, cual = "last") =>
  page
    .locator("div.grid")
    .filter({ has: page.getByPlaceholder(/Ej\. Filtro de aceite OEM/i) })[cual]();

test.describe.configure({ mode: "serial" });

test.describe("Costeo -> Cotización por pantalla @ui", () => {
  test.beforeAll(async ({ playwright }) => {
    const user = await qaAuth().createUser({ email: ASESOR.correo, password: ASESOR.password });
    await qaAuth().setCustomUserClaims(user.uid, { role: "ASESOR", idWorkshop: ID_WORKSHOP });
    creados.uids.push(user.uid);
    // OJO: el claim firmado le basta a la API, pero la app WEB carga `userData`
    // de `users/{uid}` en Firestore. Sin ese documento el login "funciona" y la
    // app te regresa a /login sin decir nada (costo una corrida el 27-ago).
    const ahora = Date.now();
    await qaDb().collection("users").doc(user.uid).set({
      uid: user.uid,
      name: "Asesor",
      firstSurname: "Prueba",
      secondSurname: "",
      email: ASESOR.correo,
      rol: "ASESOR",
      idWorkshop: ID_WORKSHOP,
      isActive: true,
      isDeleted: false,
      createdAt: ahora,
      updatedAt: ahora,
    }, { merge: true });

    // OS + hoja + diagnóstico: precondición, no lo que se prueba.
    const request = await playwright.request.newContext();
    const cliente = await post(request, "/clients", {
      fullName: `Cliente costeo UI ${S}`,
      email: `costeo.ui.${S}@test.com`,
      phone: `55${S}0000`.slice(0, 10),
      idWorkshop: ID_WORKSHOP,
      createdBy: MECHANIC_ID,
    });
    const auto = await post(request, "/cars", {
      clientId: idOf(cliente), brand: "Nissan", model: "March", year: 2019,
      vin: `UIVIN${S}000000000`.slice(0, 17), codeCar: `UI-${S}`.slice(0, 8),
      color: "Rojo", fuel: "Gasolina", transmition: "Manual", km: 60000,
    });
    const os = await post(request, "/entries", {
      idWorkshop: ID_WORKSHOP, clientId: idOf(cliente), carId: idOf(auto),
      assigned_mechanic: MECHANIC_ID, status: 1,
      observations: "spec cotizacion-costeo-ui (backlog 15 / obs 19-20)",
      registerDate: Date.now(), approvalState: "EN ESPERA",
    });
    entryId = idOf(os);
    await post(request, `/entries/${entryId}/service-sheet`, {
      car_items: ["Documentos", "Llave"], checks: ["Servicio de Frenos"],
      isCheckAll: false, observations: "spec UI", km: 60000, fuel_tank: "1/2",
    });
    await post(request, `/entries/${entryId}/diagnostics`, {
      generalObservations: "Ruido metálico al frenar.",
      findings: [{
        system: "Frenos", component: "Balatas delanteras",
        finding: "Contacto metal-metal, espesor por debajo del mínimo",
        severity: "ROJO", recommendation: "Reemplazo inmediato del juego delantero",
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

  test("el Dueño costea con costo de proveedor y precio al cliente", async ({ page }) => {
    await entrarComo(page, DUENO);
    await abrirCosteo(page);

    const fila = filaRefaccion(page);
    await fila.getByPlaceholder(/Ej\. Filtro de aceite OEM/i).fill(REFACCION);
    // Columnas: 0 Descripción · 1 Cantidad · 2 Costo proveedor · 3 Utilidad % ·
    // 4 Precio cliente · 5 Subtotal (el Proveedor es un <select>).
    const campos = fila.locator("input");
    await campos.nth(1).fill("2");
    await campos.nth(2).fill(COSTO_PROVEEDOR);
    await campos.nth(4).fill(PRECIO_CLIENTE);

    const guardar = page.getByRole("button", { name: /guardar costeo/i });
    await expect(guardar).toBeEnabled({ timeout: 10000 });
    await guardar.click();
    // Guardar el costeo CREA la cotización y lleva a la lista.
    await expect(page).toHaveURL(/\/cotizacion-vista\//, { timeout: 20000 });
  });

  test("al Asesor le llega el precio ya capturado y puede guardar sin recapturarlo", async ({ page }) => {
    // Cada test de Playwright trae su propio contexto: no hay sesion previa
    // que cerrar, se entra directo con el rol que toca.
    await entrarComo(page, ASESOR);

    await page.goto(`/cotizacion-vista/${entryId}`);
    const renglon = page.getByRole("button", { name: /ver detalle/i }).first();
    await expect(renglon, "no hay cotización listada: ¿se guardó el costeo?").toBeVisible({ timeout: 20000 });
    await renglon.click();
    await page.getByRole("button", { name: /editar cotizaci[oó]n/i }).first().click();
    await expect(page).toHaveURL(/\/cotizacion-editar\//, { timeout: 20000 });

    // ⭐ El corazón del punto 15: antes esta casilla llegaba VACÍA porque el
    // sanitizador borraba `cost` creyendo que era costo de proveedor.
    await expect(
      filaRefaccion(page).locator("input").nth(2),
      "punto 15: el Asesor debe recibir el precio al cliente que capturó el Dueño",
    ).toHaveValue(new RegExp(PRECIO_CLIENTE), { timeout: 15000 });

    // Completa lo suyo: promesa de entrega y precio de la mano de obra.
    const manana = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const dd = (n) => String(n).padStart(2, "0");
    await page.locator('input[type="datetime-local"]').first()
      .fill(`${manana.getFullYear()}-${dd(manana.getMonth() + 1)}-${dd(manana.getDate())}T17:00`);

    const filaManoObra = page
      .locator("div.grid")
      .filter({ has: page.getByPlaceholder(/Ej\. Cambio de aceite/i) })
      .last();
    await filaManoObra.locator("input").nth(1).fill("2");
    await filaManoObra.locator("input").nth(2).fill("450");

    await page.getByRole("button", { name: /^guardar$/i }).first().click();
    // Si no se mueve, casi siempre es el toast "Información incompleta o
    // valores invalidos" — que NO contiene la palabra "error".
    await expect(
      page,
      "la cotización no se guardó (¿salió «Información incompleta»?)",
    ).toHaveURL(/\/cotizacion-vista\//, { timeout: 20000 });
  });
});
