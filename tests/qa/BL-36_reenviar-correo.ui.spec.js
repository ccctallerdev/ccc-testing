const { test, expect } = require("@playwright/test");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-36 — el aviso de correo sin confirmar debe ofrecer REENVIAR el enlace @ui
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El hueco (hallado en el humo de QA del 17-sep): el banner "Te falta
 * confirmar tu correo" (AvisoCorreoSinConfirmar, en Mi suscripción) solo
 * informa. Si el correo nunca llegó, el dueño no tiene salida desde ahí — el
 * reenvío de BL-20 solo aparece cuando el muro del checkout lo rebota.
 *
 * Lo que este spec exige: un botón "Reenviar correo" en el banner que pegue a
 * POST /public/resend-verification (la ruta no-oráculo que ya existe) y avise
 * con el mismo copy del muro ("Te lo mandamos de nuevo").
 *
 * Escrito EN ROJO antes del arreglo (regla del equipo).
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   ⚠️ Requiere front local Y backend local (.env.local apunta a :3001).
 *   $env:BASE_URL="http://localhost:3000"; $env:SKIP_SEED="1"
 *   $env:SEED_EMAIL="rsv_gpa@outlook.com"; $env:SEED_PASSWORD="admin123"
 *   npx playwright test --project=qa tests/qa/BL-36_reenviar-correo.ui.spec.js
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

test.describe("BL-36 — reenviar el correo de verificación desde el aviso @ui", () => {
  test("el banner ofrece 'Reenviar correo' y pega a la ruta no-oráculo", async ({ page }) => {
    let reenvioPedido = null;

    // Status con el aviso encendido (los campos que BL-20 agrega al status de
    // la pantalla de Mi suscripción).
    await page.route(/\/billing\/status\//, (route) =>
      route.fulfill(
        ok({
          idReference: "taller-bl36",
          plan_name: "premium",
          max_orders: 70,
          status: 1,
          hasAccess: true,
          isTrial: true,
          trialType: "cardless",
          nextStep: "register_card",
          cardTrialDays: 7,
          emailVerificationPending: true,
          adminEmail: "dueno-bl36@pruebas-ccc.mx",
        }),
      ),
    );
    await page.route(/\/public\/resend-verification/, (route) => {
      reenvioPedido = route.request().postDataJSON();
      route.fulfill(ok({ sent: true }));
    });

    await page.goto("/login");
    await page.locator("#email").fill(DUENO.correo);
    await page.locator("#password").fill(DUENO.password);
    await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });

    // Mi suscripción vive en Configuración.
    await page.goto("/configuracion");

    const aviso = page.getByRole("status").filter({ hasText: /te falta confirmar tu correo/i });
    await expect(aviso).toBeVisible({ timeout: 15000 });

    // El bug: el aviso informa pero no ofrece salida.
    const boton = aviso.getByRole("button", { name: /reenviar/i });
    await expect(
      boton,
      "el aviso debe ofrecer reenviar el enlace, no solo informar",
    ).toBeVisible();

    await boton.click();

    // Mismo copy no-oráculo del muro: no promete que llegó, dice qué hacer.
    await expect(
      page.locator("[data-sonner-toaster]").getByText(/te lo mandamos de nuevo/i).first(),
    ).toBeVisible({ timeout: 15000 });
    expect(reenvioPedido, "debe pegar a /public/resend-verification").not.toBeNull();
    expect(reenvioPedido.email).toBe("dueno-bl36@pruebas-ccc.mx");
  });
});
