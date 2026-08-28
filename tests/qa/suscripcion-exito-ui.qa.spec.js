const { test, expect } = require("@playwright/test");

/**
 * ─────────────────────────────────────────────────────────────────────────
 * AUTO-LOGIN DESPUÉS DE PAGAR — la pantalla dice POR QUÉ  @ui
 *
 * Contraparte de UI del punto n10. El backend ya no quema el enlace cuando
 * falla un paso posterior (eso lo cubre
 * `ccc-backend/functions/tests/billing-session-login.unit.test.js`, 19 casos).
 * Lo que se prueba aquí es la otra mitad del bug: **que el motivo llegue a la
 * pantalla**.
 *
 * Antes, el fallo se tragaba en DOS capas: `billingClient` convertía cualquier
 * error HTTP en un `{ error }` genérico perdiendo el código, y la página
 * atrapaba el fallo de `signInWithCustomToken` en un `console.error` y caía al
 * fallback sin distinguir causa. El taller que acababa de pagar veía "inicia
 * sesión" y ya; soporte no tenía nada que mirar y en QA no había forma de
 * saber si era el enlace usado, el expirado o un 500.
 *
 * Cómo se prueba sin Stripe: se INTERCEPTA `POST /billing/session-login` con
 * `page.route` y se responde cada caso. Es determinista y no necesita un pago
 * de prueba (que además no es automatizable aquí).
 *
 * La página es PÚBLICA: no hace falta sesión ni sembrar nada.
 *
 * CÓMO CORRE:
 *   npx playwright test --project=qa tests/qa/suscripcion-exito-ui.qa.spec.js
 *   (BASE_URL apunta al front; por defecto http://localhost:3000)
 * ─────────────────────────────────────────────────────────────────────────
 */

const RUTA = "/suscripcion/exito?session_id=cs_test_123";

/** Responde el POST de auto-login con el caso que se quiere probar. */
async function responderAutoLogin(page, { status, code, message }) {
  await page.route(/\/billing\/session-login/, (route) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify({
        status,
        descripcion: "Error al validar el acceso",
        errors: [{ message }],
        ...(code ? { code } : {}),
      }),
    }),
  );
}

test.describe("Auto-login post-pago: el fallback explica @ui", () => {
  test("enlace ya usado: lo dice, muestra el código y NO ofrece reintentar", async ({ page }) => {
    await responderAutoLogin(page, {
      status: 410,
      code: "SESSION_LOGIN_USED",
      message: "Este enlace de acceso ya fue utilizado. Inicia sesión con tu correo y contraseña.",
    });
    await page.goto(RUTA);

    await expect(
      page.getByRole("alert"),
      "punto n10: el fallback no decía por qué",
    ).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/ya fue utilizado/i)).toBeVisible();
    await expect(page.getByText(/SESSION_LOGIN_USED/)).toBeVisible();
    // Un enlace gastado no se arregla reintentando: no se ofrece.
    await expect(
      page.getByTestId("btn-reintentar-autologin"),
      "un enlace ya usado no debe ofrecer reintento",
    ).toHaveCount(0);
    // OJO: el navbar público también tiene un "Iniciar Sesión"; por eso el
    // testid y no el rol (por nombre resolvía a 2 elementos).
    await expect(page.getByTestId("btn-login-fallback")).toBeVisible();
  });

  test("enlace expirado: mismo trato, sin reintento", async ({ page }) => {
    await responderAutoLogin(page, {
      status: 410,
      code: "SESSION_LOGIN_EXPIRED",
      message: "El enlace de acceso expiró. Inicia sesión con tu correo y contraseña.",
    });
    await page.goto(RUTA);

    await expect(page.getByText(/expir[oó]/i)).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/SESSION_LOGIN_EXPIRED/)).toBeVisible();
    await expect(page.getByTestId("btn-reintentar-autologin")).toHaveCount(0);
  });

  test("fallo transitorio: SÍ ofrece reintentar, y el reintento vuelve a llamar", async ({ page }) => {
    // Primer intento: revienta con algo que sí puede ser pasajero.
    let llamadas = 0;
    await page.route(/\/billing\/session-login/, (route) => {
      llamadas += 1;
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          status: 409,
          descripcion: "Error al validar el acceso",
          errors: [{ message: "No se encontró el administrador del taller." }],
          code: "WORKSHOP_ADMIN_NOT_FOUND",
        }),
      });
    });
    await page.goto(RUTA);

    await expect(page.getByText(/no se encontr[oó] el administrador/i)).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/WORKSHOP_ADMIN_NOT_FOUND/)).toBeVisible();

    const reintentar = page.getByTestId("btn-reintentar-autologin");
    await expect(
      reintentar,
      "esto ya NO quema el enlace en el backend, así que reintentar tiene sentido",
    ).toBeVisible();

    const antes = llamadas;
    await reintentar.click();
    await expect
      .poll(() => llamadas, { timeout: 15000 })
      .toBeGreaterThan(antes);
  });

  test("sin session_id no intenta nada y ofrece el acceso manual", async ({ page }) => {
    await page.goto("/suscripcion/exito");
    await expect(page.getByTestId("btn-login-fallback")).toBeVisible({ timeout: 20000 });
    // No hubo intento, así que no hay motivo que mostrar.
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
