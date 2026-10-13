const { test, expect } = require("@playwright/test");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-67 — Volver a contratar NO regala días gratis @ui
 * (ramas fix/bl67-recontratar-sin-prueba-api / -front) — escrito NUEVO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   Decisión (Enrique, 12-oct): los días gratis son SOLO para usuarios nuevos.
 *   Antes el checkout pedía siempre 7 días y la pantalla de planes le decía
 *   "Sin cobro hoy" a quien canceló y volvía (se vio en la manual de BL-27).
 *
 *   El back manda `diasGratisAlContratar` en /billing/status; aquí se simula
 *   (como BL-27 / OBS21-10) y se revisa lo que dice la pantalla con los 6 roles.
 *
 * ── CÓMO CORRERLO ─────────────────────────────────────────────────────────
 *   Front LOCAL con fix/bl67-…-front y back con fix/bl67-…-api.
 *   Mismas variables que BL-27 (BASE_URL, SKIP_SEED, ROL_*_EMAIL/PASS).
 *   npx playwright test --project=qa tests/qa/BL-67_recontratar-sin-prueba.ui.spec.js
 *
 * ── ROJO ESPERADO sin el fix ──────────────────────────────────────────────
 *   Caso 1: el pie de los planes dice "Sin cobro hoy · Cancela cuando quieras".
 *   Caso 3: la página de éxito dice "no se te cobró nada hoy" aunque hubo cargo.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const DAY = 24 * 60 * 60 * 1000;
const fechaCorta = (ms) => new Date(ms).toLocaleDateString("es-MX", { day: "numeric", month: "long" });

const ROLES = [
  { nombre: "Dueño",         clave: "DUENO",
    email: process.env.ROL_DUENO_EMAIL || process.env.SEED_EMAIL || "rsv_gpa@outlook.com",
    pass: process.env.ROL_DUENO_PASS || process.env.SEED_PASSWORD || "admin123" },
  { nombre: "Administrador", clave: "ADMINISTRADOR" },
  { nombre: "Asesor",        clave: "ASESOR" },
  { nombre: "Compras",       clave: "COMPRAS" },
  { nombre: "Mecánico",      clave: "MECANICO" },
  { nombre: "Recepción",     clave: "RECEPCION" },
].map((r) => ({ ...r, email: r.email || process.env[`ROL_${r.clave}_EMAIL`], pass: r.pass || process.env[`ROL_${r.clave}_PASS`] }));

async function statusConDatos(page, parche) {
  await page.route(/\/billing\/status\//, async (route) => {
    const res = await route.fetch();
    const json = await res.json().catch(() => null);
    if (!json?.data) return route.fulfill({ response: res });
    Object.assign(json.data, parche);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
  });
}

async function entrar(page, rol) {
  await page.goto("/login");
  await page.locator("#email").fill(rol.email);
  await page.locator("#password").fill(rol.pass);
  await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });
}

const EX_CLIENTE = {
  hasAccess: false, status: 3, trialType: "card", stripeStatus: "canceled",
  nextStep: "subscribe", trialDaysLeft: null, externalSubscriptionId: "sub_simulada", diasGratisAlContratar: 0,
};

test.describe.configure({ mode: "default" });

test.describe("BL-67 · caso 1 — canceló y vuelve: los planes NO dicen 'Sin cobro hoy' @ui", () => {
  for (const rol of ROLES) {
    test(`BL-67 caso 1 — ${rol.nombre}`, async ({ page }, testInfo) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);
      await statusConDatos(page, EX_CLIENTE);
      await entrar(page, rol);
      await expect(page).toHaveURL(/\/suscripcion/, { timeout: 30000 });
      await expect(page.getByText("El cargo se hace hoy · Cancela cuando quieras").first()).toBeVisible({ timeout: 20000 });
      await expect(page.getByText(/Sin cobro hoy/), "ROJO hoy: le promete no cobrar").toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`c1-${rol.clave}.png`), fullPage: true });
    });
  }
});

test.describe("BL-67 · caso 2 — guarda: si el back dice que sí hay días, se anuncian con fecha @ui", () => {
  for (const rol of ROLES) {
    test(`BL-67 caso 2 — ${rol.nombre}`, async ({ page }) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);
      await statusConDatos(page, { ...EX_CLIENTE, diasGratisAlContratar: 7 });
      await entrar(page, rol);
      await expect(page).toHaveURL(/\/suscripcion/, { timeout: 30000 });
      await expect(page.getByText(`Sin cobro hoy · Primer cargo el ${fechaCorta(Date.now() + 7 * DAY)}`).first())
        .toBeVisible({ timeout: 20000 });
    });
  }
});

test.describe("BL-67 · caso 3 — página de éxito según lo que pasó en el checkout @ui", () => {
  test("BL-67 caso 3a — hubo cargo hoy: 'suscripción activa', sin 'no se te cobró nada'", async ({ page }, testInfo) => {
    await page.goto("/");
    await page.evaluate(() => sessionStorage.setItem("ccc:diasGratisCheckout", "0"));
    await page.goto("/suscripcion/exito");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("¡Listo, tu suscripción está activa!");
    await expect(page.getByTestId("texto-exito-tarjeta")).toContainText("ya se hizo el cargo de tu plan");
    await expect(page.locator("body"), "ROJO hoy").not.toContainText(/no se te cobró nada/);
    await page.screenshot({ path: testInfo.outputPath("c3a.png") });
  });

  test("BL-67 caso 3b — con días gratis: no se cobró y da la fecha", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => sessionStorage.setItem("ccc:diasGratisCheckout", "7"));
    await page.goto("/suscripcion/exito");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("¡Listo, tu tarjeta quedó registrada!");
    await expect(page.getByTestId("texto-exito-tarjeta")).toContainText("no se te cobró nada hoy");
    await expect(page.getByTestId("texto-exito-tarjeta")).toContainText(fechaCorta(Date.now() + 7 * DAY));
  });

  test("BL-67 caso 3c — el dato es de un solo uso: al recargar queda el texto neutro", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => sessionStorage.setItem("ccc:diasGratisCheckout", "0"));
    await page.goto("/suscripcion/exito");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("¡Listo, tu suscripción está activa!");
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("¡Listo, tu tarjeta quedó registrada!");
    await expect(page.getByTestId("texto-exito-tarjeta")).not.toContainText(/no se te cobró nada|ya se hizo el cargo/);
  });
});
