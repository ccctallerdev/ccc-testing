const { test, expect } = require("@playwright/test");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-35 — /suscripcion con suscripción vigente: SUBIR de plan, no "Contratar" @ui
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El hueco (backlog punto 35): con suscripción viva, las tarjetas de "Elige
 * tu plan" decían "Contratar este plan" y el backend rechazaba con "Este
 * taller ya tiene una suscripción activa". Además las tarjetas no decían
 * cuántas órdenes/mes da cada plan — no sabías qué comprabas al subir.
 *
 * Lo que este spec exige (primera versión: SOLO SUBIR, decidido 17-sep):
 *   · la tarjeta del plan actual se marca "Tu plan actual" (botón inerte);
 *   · los planes MAYORES ofrecen "Cambiar a este plan" → POST
 *     /billing/change-plan (nada de checkout);
 *   · los MENORES no ofrecen contratar (bajar no está soportado);
 *   · cada tarjeta muestra sus órdenes de servicio al mes (30/70/150).
 *
 * Todo va por intercepción (status, planes y change-plan): no toca Stripe ni
 * el estado real del taller.
 *
 * Escrito EN ROJO antes del arreglo (regla del equipo).
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   ⚠️ Requiere front local Y backend local (.env.local apunta a :3001).
 *   $env:BASE_URL="http://localhost:3000"; $env:SKIP_SEED="1"
 *   $env:SEED_EMAIL="rsv_gpa@outlook.com"; $env:SEED_PASSWORD="admin123"
 *   npx playwright test --project=qa tests/qa/BL-35_subir-plan.ui.spec.js
 * ═══════════════════════════════════════════════════════════════════════════
 */

const DUENO = {
  correo: process.env.SEED_EMAIL || "rsv_gpa@outlook.com",
  password: process.env.SEED_PASSWORD || "admin123",
};

const ok = (data) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ status: 200, descripcion: "ok", data }),
});

/** Suscripción viva en BÁSICO, con pasarela real detrás (externalSubscriptionId). */
const STATUS_BASICO = {
  idReference: "taller-bl35",
  plan_name: "basico",
  max_orders: 30,
  billing_cycle: 0,
  status: 2,
  hasAccess: true,
  isTrial: false,
  trialType: "card",
  nextStep: "none",
  externalSubscriptionId: "sub_bl35_test",
  cancelAtPeriodEnd: false,
  accessUntil: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
};

const PLANES = [
  { key: "basico", name: "Básico", max_orders: 30, monthly: 499, annual: 4990 },
  { key: "premium", name: "Premium", max_orders: 70, monthly: 999, annual: 9990 },
  { key: "master", name: "Master", max_orders: 150, monthly: 1999, annual: 19990 },
];

test.describe("BL-35 — subir de plan desde /suscripcion @ui", () => {
  test("plan actual marcado, mayores con 'Cambiar', órdenes/mes visibles y cambio exitoso", async ({ page }) => {
    let cambioPedido = null;

    await page.route(/\/billing\/status\//, (route) => route.fulfill(ok(STATUS_BASICO)));
    await page.route(/\/plans(\?|$)/, (route) => route.fulfill(ok(PLANES)));
    await page.route(/\/billing\/change-plan/, (route) => {
      cambioPedido = route.request().postDataJSON();
      route.fulfill(
        ok({ planKey: cambioPedido.planKey, max_orders: 70, prorrateado: true }),
      );
    });

    await page.goto("/login");
    await page.locator("#email").fill(DUENO.correo);
    await page.locator("#password").fill(DUENO.password);
    await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });

    await page.goto("/suscripcion");

    const cardBasico = page.getByTestId("plan-card-basico");
    const cardPremium = page.getByTestId("plan-card-premium");
    const cardMaster = page.getByTestId("plan-card-master");

    // 1. El plan contratado se reconoce a sí mismo.
    await expect(
      cardBasico.getByRole("button", { name: /tu plan actual/i }),
      "la tarjeta del plan vigente debe decir 'Tu plan actual', no 'Contratar'",
    ).toBeVisible({ timeout: 15000 });
    await expect(cardBasico.getByRole("button", { name: /tu plan actual/i })).toBeDisabled();

    // 2. Los planes mayores ofrecen CAMBIAR, no contratar.
    await expect(cardPremium.getByRole("button", { name: /cambiar a este plan/i })).toBeVisible();
    await expect(cardMaster.getByRole("button", { name: /cambiar a este plan/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /contratar este plan/i })).toHaveCount(0);

    // 3. Cada tarjeta dice cuántas órdenes/mes incluye (lo que compras al subir).
    await expect(cardBasico.getByText(/30\s+órdenes/i)).toBeVisible();
    await expect(cardPremium.getByText(/70\s+órdenes/i)).toBeVisible();
    await expect(cardMaster.getByText(/150\s+órdenes/i)).toBeVisible();

    // 4. Subir a Premium: pega al endpoint nuevo con el plan destino y avisa.
    await cardPremium.getByRole("button", { name: /cambiar a este plan/i }).click();
    await expect(
      page.locator("[data-sonner-toaster]").getByText(/plan/i).first(),
      "el cambio exitoso debe avisarse con un toast",
    ).toBeVisible({ timeout: 15000 });
    expect(cambioPedido, "debe llamar a /billing/change-plan (no al checkout)").not.toBeNull();
    expect(cambioPedido.planKey).toBe("premium");
  });
});
