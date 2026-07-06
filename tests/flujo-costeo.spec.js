const { test, expect } = require("@playwright/test");

/**
 * Flujo E2E: login → entrada → Diagnóstico ✓ → Costeo.
 *
 * PRERREQUISITOS (todo corriendo):
 *   1) Emuladores:  cd ccc-backend && npm run serve
 *   2) Backend:     cd ccc-backend && npm run backend
 *   3) Frontend:    cd ccc-frontend && npm start   (con .env.local → emuladores)
 *   4) Seeds:       cd ccc-testing && node seed_emulator_user.js && node seed_prueba_e2e.js
 *
 * Correr:  npm test   (o  npm run test:headed  para ver la ventana)
 *
 * Nota: la app no tiene data-testid, así que se usan selectores por TEXTO/ROL.
 * Si algún label cambió, ajusta el selector correspondiente.
 */

const EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const PASSWORD = process.env.SEED_PASSWORD || "prueba123";

async function login(page) {
  await page.goto("/login");
  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  // Espera a salir del login (el AuthContext carga userData y redirige).
  await page
    .waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 })
    .catch(() => {}); // si no auto-redirige, seguimos y navegamos directo
}

test("login → entrada → Diagnóstico ✓ → Costeo", async ({ page }) => {
  await login(page);

  // 1) Lista de entradas de vehículos
  await page.goto("/registro");
  await expect(page.getByText(/Nissan Versa/i).first()).toBeVisible({ timeout: 15000 });

  // 2) Indicador "Diagnóstico ✓" (verde) = diagnóstico ya hecho, y entrar a la vista
  const diagBtn = page.getByRole("button", { name: /Diagn[oó]stico/i }).first();
  await expect(diagBtn).toBeVisible();
  await expect(diagBtn).toContainText("✓"); // ✓ = diagnóstico realizado
  await diagBtn.click();

  // 3) Vista de diagnósticos → botón "Costeo"
  await expect(page).toHaveURL(/diagnostico-vista/);
  const costeoBtn = page.getByRole("button", { name: /^\s*Costeo\s*$/ }).first();
  await expect(costeoBtn).toBeVisible();
  await costeoBtn.click();

  // 4) Pantalla de Costeo
  await expect(page).toHaveURL(/\/costeo\//);
  await expect(page.getByRole("heading", { name: /^Costeo$/ })).toBeVisible();
  // Por rol de heading: getByText ambigua (también matchea el párrafo
  // "Marca los trabajos a realizar") y el modo estricto truena con 2 elementos.
  await expect(
    page.getByRole("heading", { name: /Trabajos a realizar/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Refacciones y materiales/i }),
  ).toBeVisible();
});

/**
 * Continuación del flujo (login → … → Reparación con asserts del stock).
 * Se deja como esqueleto porque estos pasos dependen de labels/DOM que conviene
 * verificar en una corrida real (no hay data-testid). Descoméntalo y ajusta
 * selectores tras ver la primera corrida en verde.
 */
test.skip("flujo completo hasta Reparación (esqueleto, ajustar selectores)", async ({ page }) => {
  await login(page);
  await page.goto("/registro");

  // Diagnóstico → Costeo
  await page.getByRole("button", { name: /Diagn[oó]stico/i }).first().click();
  await page.getByRole("button", { name: /^\s*Costeo\s*$/ }).first().click();

  // TODO Costeo: agregar refacción (InventoryPartPicker o texto libre) + cantidad,
  //   marcar/desmarcar hallazgos, y "Guardar costeo".
  // await page.getByPlaceholder(/Filtro de aceite OEM/i).first().fill("Balatas delanteras");
  // await page.getByRole("button", { name: /Guardar costeo/i }).click();

  // TODO Cotización: en la lista, abrir la cotización (badge "Costeo · sin precios"),
  //   "Editar cotización", poner precios/mano de obra, guardar → badge "Cotización".

  // TODO Oficial + Aprobar: botón "Oficial" → seleccionar cotización + hoja → Aprobar.

  // TODO Abastecimiento: en la tarjeta de la OS aparece el botón "Abastecimiento"
  //   (porque hay faltante) → crear pedido → "Recibir".

  // TODO Reparación: cambiar estatus a "EN REPARACION" → verificar en la UI del
  //   emulador (localhost:4000) que el stock bajó (o consultar por API).
});
