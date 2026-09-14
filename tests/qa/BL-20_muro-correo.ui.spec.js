const { test, expect } = require("@playwright/test");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-20 — El muro del correo en la pantalla de suscripción  @ui
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Hermano del spec de API, y NO lo repite: aquel prueba que el backend niegue
 * el checkout; este prueba que la pantalla convierta esa negativa en algo que
 * el dueño pueda resolver. Son dos fallas distintas: el backend puede estar
 * perfecto y la pantalla seguir diciendo "no se pudo, intenta de nuevo", que
 * es exactamente el bug que BL-20 no quiere dejar.
 *
 * ── POR QUÉ INTERCEPTA EN VEZ DE SEMBRAR ──────────────────────────────────
 *
 * Las dos rutas que importan se interceptan con `page.route`, así que el spec
 * NO necesita un taller en un estado particular, ni Stripe, ni esperar a que
 * el backend esté desplegado. Es el mismo patrón de
 * `produccion-mecanico-ui.qa.spec.js`, que finge el 400 del índice ausente.
 * Lo que se mide aquí es la PANTALLA, y la pantalla solo ve respuestas HTTP.
 *
 * Eso tiene una consecuencia honesta: este spec pasa en verde aunque el
 * backend de BL-20 no exista. No es su trabajo — es el del spec de API. Lo
 * que sí garantiza es que el día que el backend responda así, el dueño tenga
 * salida.
 *
 * ── LO QUE SE EXIGE ───────────────────────────────────────────────────────
 *
 *   1  el 409 se convierte en un panel con las DOS salidas, no en "intenta de
 *      nuevo" (repetir el pago fallaría igual: no es un problema del pago)
 *   2  el panel muestra EL CORREO QUE EL BACKEND DICE, no el de la sesión:
 *      si hubo un dedazo, ver el correo equivocado es medio arreglo por sí solo
 *   3  reenviar pega a la ruta correcta
 *   4  cambiar el correo pega a la ruta correcta y avisa que el actual sigue
 *      vigente (o el dueño creería que acaba de perder el acceso)
 *   5  durante la prueba sale un aviso suave, no un muro: el acceso NO se
 *      corta por esto
 *
 * ── ⚠️ CONTRA QUÉ FRONT (esto costó una corrida el 14-sep) ────────────────
 *
 * `ccc-frontend-qa.vercel.app` sirve **qa-front**, no tu rama. Si BL-20 vive
 * solo en `feat/bl20-...-front`, ahí el 409 cae en el manejo VIEJO y el panel
 * no existe: el caso 1 falla diciendo "no encontré el alert" y parece un bug
 * del spec. Es la trampa del deploy-desde-rama, del lado del front.
 *
 * Para probar LA RAMA:
 *   terminal 1 (ccc-frontend):  npm start
 *   terminal 2:                 $env:BASE_URL="http://localhost:3000"
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   $env:BASE_URL="http://localhost:3000"    ← la rama (ver el aviso de arriba)
 *   $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"
 *   $env:AUTH_REAL="1"; $env:SKIP_SEED="1"
 *   $env:SEED_EMAIL='rsv_gpa@outlook.com'; $env:SEED_PASSWORD='admin123'
 *   npx playwright test --project=qa tests/qa/BL-20_muro-correo.ui.spec.js
 * ═══════════════════════════════════════════════════════════════════════════
 */

const DUENO = {
  correo: process.env.SEED_EMAIL || "rsv_gpa@outlook.com",
  password: process.env.SEED_PASSWORD || "admin123",
};
const CORREO_MAL_TECLEADO = "duenio+dedazo@outlok.com"; // "outlok", el dedazo típico

if (/vercel\.app/i.test(process.env.BASE_URL || "")) {
  console.log(
    "\n   \u26a0\ufe0f  BASE_URL apunta a Vercel, que sirve `qa-front`. Si BL-20 solo vive en tu\n" +
      "      rama, el panel no existe ahi y el caso 1 fallara por eso, no por un bug.\n" +
      "      Para probar la rama: npm start en ccc-frontend y BASE_URL=http://localhost:3000\n",
  );
}

async function entrarComo(page, { correo, password }) {
  await page.goto("/login");
  await page.locator("#email").fill(correo);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });
}

/** El 409 tal como lo responde `billing.router.js` (JSON crudo, no `errorResponse`). */
const negarCheckout = (page) =>
  page.route(/\/billing\/checkout-session/, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        status: 409,
        descripcion: "Error al crear la sesión de checkout",
        errors: [{ message: "Confirma tu correo antes de registrar tu tarjeta." }],
        code: "EMAIL_NOT_VERIFIED",
        email: CORREO_MAL_TECLEADO,
        canResend: true,
      }),
    }),
  );

test.describe.configure({ mode: "serial" });

test.describe("BL-20 — la pantalla da salida cuando el correo no está confirmado @ui", () => {
  test("1) el 409 abre el panel con las dos salidas, no un 'intenta de nuevo'", async ({ page }) => {
    await entrarComo(page, DUENO);
    await negarCheckout(page);
    await page.goto("/suscripcion");

    // El primer plan que ofrezca la pantalla; da igual cuál.
    await page.getByRole("button", { name: /contratar|registrar tarjeta|elegir/i }).first().click();

    const panel = page.getByRole("alert");
    await expect(panel).toBeVisible({ timeout: 15000 });
    await expect(panel).toContainText(/confirma tu correo/i);

    // Caso 2: el correo que se muestra es el del BACKEND, con su dedazo. Ver
    // "outlok.com" escrito es lo que hace que el dueño entienda qué pasó.
    await expect(panel, "sin ver el correo equivocado, el dueño no sabe qué corregir")
      .toContainText(CORREO_MAL_TECLEADO);

    // Y NO el mensaje de pago fallido: reintentar el pago no arregla esto.
    await expect(page.getByText(/intenta de nuevo/i)).toHaveCount(0);

    // Las dos salidas, visibles y operables.
    await expect(page.getByRole("button", { name: /reenviarme el correo/i })).toBeVisible();
    await expect(page.getByLabel(/usa otro/i)).toBeVisible();
  });

  test("2) reenviar pega a /public/resend-verification con ese correo", async ({ page }) => {
    await entrarComo(page, DUENO);
    await negarCheckout(page);

    let pedido = null;
    await page.route(/\/public\/resend-verification/, (route) => {
      pedido = JSON.parse(route.request().postData() || "{}");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: 200, descripcion: "ok", data: { ok: true } }),
      });
    });

    await page.goto("/suscripcion");
    await page.getByRole("button", { name: /contratar|registrar tarjeta|elegir/i }).first().click();
    await page.getByRole("button", { name: /reenviarme el correo/i }).click();

    await expect.poll(() => pedido?.email, { timeout: 10000 }).toBe(CORREO_MAL_TECLEADO);
  });

  test("3) cambiar el correo lo pide al backend y avisa que el actual sigue vigente", async ({ page }) => {
    await entrarComo(page, DUENO);
    await negarCheckout(page);

    const CORREO_BUENO = "duenio.bueno@outlook.com";
    let pedido = null;
    await page.route(/\/users\/me\/email-change/, (route) => {
      pedido = JSON.parse(route.request().postData() || "{}");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: 200,
          descripcion: "ok",
          data: { pendingEmail: CORREO_BUENO, currentEmail: CORREO_MAL_TECLEADO },
        }),
      });
    });

    await page.goto("/suscripcion");
    await page.getByRole("button", { name: /contratar|registrar tarjeta|elegir/i }).first().click();
    await page.getByLabel(/usa otro/i).fill(CORREO_BUENO);
    await page.getByRole("button", { name: /mandar enlace/i }).click();

    await expect.poll(() => pedido?.email, { timeout: 10000 }).toBe(CORREO_BUENO);

    // Lo que el dueño necesita leer para no entrar en pánico: que NO acaba de
    // perder el acceso con su correo de siempre.
    await expect(page.getByRole("alert")).toContainText(/sigue vigente tu correo actual/i);
  });

  test("4) durante la prueba es un AVISO, no un muro", async ({ page }) => {
    // El acceso no se corta por esto (decisión de Enrique, 2-sep): la pantalla
    // informa y deja seguir. Si esto se volviera un `role="alert"` bloqueante,
    // seríamos otro producto.
    await page.route(/\/billing\/status\//, async (route) => {
      const res = await route.fetch();
      const json = await res.json().catch(() => null);
      if (!json?.data) return route.fulfill({ response: res });
      json.data.emailVerificationPending = true;
      json.data.adminEmail = CORREO_MAL_TECLEADO;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(json),
      });
    });

    await entrarComo(page, DUENO);
    await page.goto("/suscripcion");

    const aviso = page.getByRole("status");
    await expect(aviso).toBeVisible({ timeout: 15000 });
    await expect(aviso).toContainText(/te falta confirmar tu correo/i);
    await expect(aviso, "durante la prueba se puede seguir usando la app").toContainText(
      /puedes seguir usando la app/i,
    );
    // Y los planes siguen ahí: no se bloquea la pantalla.
    await expect(
      page.getByRole("button", { name: /contratar|registrar tarjeta|elegir/i }).first(),
    ).toBeVisible();
  });
});
