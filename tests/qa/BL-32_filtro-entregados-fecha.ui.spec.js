const { test, expect } = require("@playwright/test");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-32 — el filtro de Vehículos entregados debe filtrar por fecha de ENTREGA @ui
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El bug (backlog punto 32): los botones Hoy/Semana/Quincena/Mes acotan por la
 * fecha en que el auto ENTRÓ al taller, no por la de entrega. La cadena de
 * fallbacks de `FinishedServices.jsx` empieza en `deliveredDate` — un campo
 * que NO existe en el proyecto— y termina cayendo siempre en `registerDate`.
 * Lo traicionero: la columna y el orden de esa misma pantalla SÍ usan la fecha
 * de entrega (`deliveredAt`), así que la pantalla se ve coherente mientras el
 * filtro va por otro criterio. No hay error visible: solo sobran y faltan
 * renglones.
 *
 * ── LA PAREJA QUE LO DELATA ───────────────────────────────────────────────
 * Se simulan dos entregados (el listado se intercepta, no se siembra):
 *   · ENTREGA-HOY  — entró hace 60 días, se entregó HOY.   "Hoy" DEBE mostrarlo.
 *   · ENTRADA-HOY  — entró hoy, se entregó hace 40 días.   "Hoy" NO debe mostrarlo.
 * Con el bug, el filtro hace exactamente lo contrario.
 *
 * Escrito EN ROJO antes del arreglo (regla del equipo).
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   ⚠️ Requiere front local Y backend local (.env.local apunta a :3001).
 *   $env:BASE_URL="http://localhost:3000"; $env:SKIP_SEED="1"
 *   $env:SEED_EMAIL="rsv_gpa@outlook.com"; $env:SEED_PASSWORD="admin123"
 *   npx playwright test --project=qa tests/qa/BL-32_filtro-entregados-fecha.ui.spec.js
 * ═══════════════════════════════════════════════════════════════════════════
 */

const DUENO = {
  correo: process.env.SEED_EMAIL || "rsv_gpa@outlook.com",
  password: process.env.SEED_PASSWORD || "admin123",
};

const DIA = 24 * 60 * 60 * 1000;
const AHORA = Date.now();

const base = {
  statusService: "ENTREGADO",
  approvalState: "APROBADA",
  isDeleted: false,
  clientName: "Cliente De Prueba",
  carName: "Tsuru E2E",
  codeCar: "BL32-000",
};

const ENTREGA_HOY = {
  ...base,
  id: "bl32-entrega-hoy",
  sheet: "OS-ENTREGA-HOY",
  registerDate: AHORA - 60 * DIA, // entró hace dos meses…
  deliveredAt: AHORA,             // …pero se entregó HOY
};
const ENTRADA_HOY = {
  ...base,
  id: "bl32-entrada-hoy",
  sheet: "OS-ENTRADA-HOY",
  registerDate: AHORA,            // entró hoy…
  deliveredAt: AHORA - 40 * DIA,  // …pero se entregó hace más de un mes
};

async function entrarComo(page, { correo, password }) {
  await page.goto("/login");
  await page.locator("#email").fill(correo);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });
}

test.describe("BL-32 — filtro de entregados por fecha de ENTREGA @ui", () => {
  test("'Hoy' muestra lo entregado hoy, no lo que ENTRÓ hoy", async ({ page }) => {
    await page.route(/\/entries\?[^"]*statusService=ENTREGADO/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: 200,
          descripcion: "ok",
          data: { entries: [ENTREGA_HOY, ENTRADA_HOY], total: 2 },
        }),
      }),
    );

    await entrarComo(page, DUENO);
    await page.goto("/servicios-entregados");

    // Con "Todos" (default) las dos OS están: la intercepción funcionó.
    // (exact:true porque la tarjeta también pinta "OS <folio>" y sin él el
    // selector resuelve a 2 elementos → strict mode violation)
    await expect(page.getByText("OS-ENTREGA-HOY", { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("OS-ENTRADA-HOY", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /^hoy$/i }).click();

    // La entregada HOY tiene que estar — con el bug desaparece, porque su
    // fecha de ENTRADA es de hace dos meses.
    await expect(
      page.getByText("OS-ENTREGA-HOY", { exact: true }),
      "un auto entregado HOY debe salir en 'Hoy' aunque haya entrado hace meses",
    ).toBeVisible();

    // Y la que solo ENTRÓ hoy no debe estar — con el bug aparece, porque el
    // filtro mira la fecha de entrada.
    await expect(
      page.getByText("OS-ENTRADA-HOY", { exact: true }),
      "un auto entregado hace 40 días NO debe salir en 'Hoy' solo porque entró hoy",
    ).toHaveCount(0);
  });
});
