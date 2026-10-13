const { test, expect } = require("@playwright/test");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OBS21-10 — Los mensajes del periodo de prueba cuentan UNA sola historia @ui
 * (rama fix/obs21-10-textos-prueba-front) — escrito NUEVO, en ROJO antes del fix
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   Síntoma (Roberto, 21-sep, puntos 11 y 12): se registró y al día siguiente
 *   puso su tarjeta. La app le dijo, en este orden:
 *     · /suscripcion  "Continúa 7 días más, gratis — tus días de prueba sin
 *                      tarjeta terminaron"   ← no habían terminado
 *     · al volver de Stripe "¡Tu prueba de 14 días comenzó! primer cargo el día 15"
 *     · banner        "Prueba con tarjeta: 20 días sin costo"
 *     · Mi suscripción "20 días de prueba restantes"
 *   "dice 20 días, pero es prueba verdad, solo son 7 días extra".
 *
 *   Regla (D33, opción a — confirmada por Roberto): 14 días sin tarjeta; al
 *   registrarla se SUMAN 7 a lo que le quede. 13 + 7 = 20 es correcto: lo que
 *   se arregla es el texto, no la regla.
 *
 * Los estados de la prueba se SIMULAN interceptando /billing/status (misma
 * técnica que BL-50): no hay que registrar tarjetas en Stripe ni esperar días.
 * El banner y /suscripcion los ven los 6 roles; "Mi suscripción" solo el Dueño.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   ⚠️ Front LOCAL con la rama (QA corre el código viejo).
 *     1) ccc-backend/functions → npm run dev      (localhost:3001)
 *     2) ccc-frontend          → npm start        (localhost:3000)
 *   $env:BASE_URL="http://localhost:3000"; $env:SKIP_SEED="1"
 *   $env:ROL_DUENO_EMAIL="rsv_gpa@outlook.com";              $env:ROL_DUENO_PASS="admin123"
 *   $env:ROL_ADMINISTRADOR_EMAIL="rsv_gpa+admin1@outlook.com"; $env:ROL_ADMINISTRADOR_PASS="Prueba_123!"
 *   $env:ROL_ASESOR_EMAIL="rsv_gpa+asesor1@outlook.com";     $env:ROL_ASESOR_PASS="Prueba_123!"
 *   $env:ROL_COMPRAS_EMAIL="rsv_gpa+compras1@outlook.com";   $env:ROL_COMPRAS_PASS="Prueba_123!"
 *   $env:ROL_MECANICO_EMAIL="rsv_gpa+mecanico1@outlook.com"; $env:ROL_MECANICO_PASS="Prueba_123!"
 *   $env:ROL_RECEPCION_EMAIL="rsv_gpa+recepcion1@outlook.com"; $env:ROL_RECEPCION_PASS="Prueba_123!"
 *   npx playwright test --project=qa tests/qa/OBS21-10_textos-prueba.ui.spec.js
 *
 * ── ROJO ESPERADO sin el fix ──────────────────────────────────────────────
 *   Caso 1  /suscripcion con 13 días pendientes dice "terminaron".
 *   Caso 2  (guarda) prueba sin tarjeta vencida: SÍ debe decir "terminaron";
 *           el texto viejo falla porque no trae la fecha del primer cargo.
 *   Caso 3  banner con tarjeta: "20 días sin costo" sin aclarar los 7.
 *   Caso 4  Mi suscripción: "20 días de prueba restantes" sin aclarar.
 *   Caso 5  regreso de Stripe: "¡Tu prueba de 14 días comenzó!" / "día 15".
 * ═══════════════════════════════════════════════════════════════════════════
 */

const DAY = 24 * 60 * 60 * 1000;

const ROLES = [
  { nombre: "Dueño",         clave: "DUENO",
    email: process.env.ROL_DUENO_EMAIL || process.env.SEED_EMAIL || "rsv_gpa@outlook.com",
    pass: process.env.ROL_DUENO_PASS || process.env.SEED_PASSWORD || "admin123" },
  { nombre: "Administrador", clave: "ADMINISTRADOR" },
  { nombre: "Asesor",        clave: "ASESOR" },
  { nombre: "Compras",       clave: "COMPRAS" },
  { nombre: "Mecánico",      clave: "MECANICO" },
  { nombre: "Recepción",     clave: "RECEPCION" },
].map((r) => ({
  ...r,
  email: r.email || process.env[`ROL_${r.clave}_EMAIL`],
  pass: r.pass || process.env[`ROL_${r.clave}_PASS`],
}));

/** "11 de octubre", igual que lo formatea la app. */
const fechaCorta = (ms) =>
  new Date(ms).toLocaleDateString("es-MX", { day: "numeric", month: "long" });

/** Estados de la prueba que se inyectan en /billing/status. */
const ESTADOS = {
  // Caso Roberto: dado de alta ayer, sin tarjeta, le quedan 13 días.
  sinTarjetaCorriendo: () => ({
    status: 1, hasAccess: true, trialType: "cardless", nextStep: "register_card",
    trialDaysLeft: 13, cardTrialDays: 7, autoRenew: false, cancelAtPeriodEnd: false,
    trialEndsAt: new Date(Date.now() + 13 * DAY).toISOString(),
    externalSubscriptionId: null, emailVerificationPending: false,
  }),
  // Día 15: la prueba sin tarjeta venció.
  sinTarjetaVencida: () => ({
    status: 3, hasAccess: false, trialType: "cardless", nextStep: "register_card",
    trialDaysLeft: null, cardTrialDays: 7, autoRenew: false, cancelAtPeriodEnd: false,
    externalSubscriptionId: null, emailVerificationPending: false,
  }),
  // Ya registró la tarjeta: 13 + 7 = 20 días en la pasarela.
  conTarjeta20: () => {
    const fin = new Date(Date.now() + 20 * DAY).toISOString();
    return {
      status: 1, hasAccess: true, trialType: "card", nextStep: "none",
      trialDaysLeft: 20, cardTrialDays: 7, cancelAtPeriodEnd: false, autoRenew: true,
      trialEndsAt: fin, accessUntil: fin, trial_end: fin,
      stripeStatus: "trialing", externalSubscriptionId: "sub_obs21_10_simulada",
      plan_name: "basico", billing_cycle: 0, emailVerificationPending: false,
    };
  },
};

async function simularPrueba(page, estado) {
  await page.route(/\/billing\/status\//, async (route) => {
    const res = await route.fetch();
    const json = await res.json().catch(() => null);
    if (!json?.data) return route.fulfill({ response: res });
    Object.assign(json.data, estado());
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

const banner = (page) => page.getByRole("status").filter({ hasText: /prueba gratis/i }).first();

test.describe.configure({ mode: "default" });

// ─────────────────────────────────────────────────────────────────────────
// Caso 1 — Le quedan 13 días sin tarjeta: nada dice "terminaron"
// ─────────────────────────────────────────────────────────────────────────
test.describe("OBS21-10 · caso 1 — prueba sin tarjeta corriendo (13 días) @ui", () => {
  for (const rol of ROLES) {
    test(`OBS21-10 caso 1 — ${rol.nombre}`, async ({ page }, testInfo) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);
      await simularPrueba(page, ESTADOS.sinTarjetaCorriendo);
      await entrar(page, rol);

      // Banner: los días que le quedan y que los 7 se SUMAN (no "al terminar").
      await expect(banner(page)).toContainText("te quedan 13 días", { timeout: 20000 });
      await expect(banner(page)).toContainText("se te suman 7 días");
      await expect(banner(page)).not.toContainText(/al terminar/i);
      await page.screenshot({ path: testInfo.outputPath(`c1-banner-${rol.clave}.png`) });

      await page.goto("/suscripcion");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "Registra tu tarjeta y suma 7 días gratis", { timeout: 20000 },
      );
      const cuerpo = page.getByTestId("texto-registrar-tarjeta");
      await expect(cuerpo, "el síntoma de Roberto: decía 'terminaron' con 13 días pendientes")
        .not.toContainText(/terminaron/i);
      await expect(cuerpo).toContainText("te quedan 13 días");
      await expect(cuerpo).toContainText("20 días sin costo en total");
      await expect(cuerpo).toContainText(fechaCorta(Date.now() + 20 * DAY));
      await expect(page.getByRole("button", { name: "Sumar 7 días gratis" }).first()).toBeVisible();
      await expect(page.getByText(/el día \d+ de esta etapa/)).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`c1-suscripcion-${rol.clave}.png`), fullPage: true });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Caso 2 — Día 15: la prueba sin tarjeta venció (guarda: aquí SÍ "terminaron")
// ─────────────────────────────────────────────────────────────────────────
test.describe("OBS21-10 · caso 2 — prueba sin tarjeta vencida @ui", () => {
  for (const rol of ROLES) {
    test(`OBS21-10 caso 2 — ${rol.nombre}`, async ({ page }, testInfo) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);
      await simularPrueba(page, ESTADOS.sinTarjetaVencida);
      await entrar(page, rol);

      await expect(page).toHaveURL(/\/suscripcion/, { timeout: 30000 });
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Continúa 7 días más, gratis", { timeout: 20000 });
      const cuerpo = page.getByTestId("texto-registrar-tarjeta");
      await expect(cuerpo).toContainText(/terminaron/);
      await expect(cuerpo).toContainText(fechaCorta(Date.now() + 7 * DAY));
      await expect(page.getByRole("button", { name: "Continuar 7 días gratis" }).first()).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`c2-${rol.clave}.png`), fullPage: true });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Caso 3 — Ya con tarjeta, 20 días: el banner aclara que incluyen los 7
// ─────────────────────────────────────────────────────────────────────────
test.describe("OBS21-10 · caso 3 — banner de la prueba con tarjeta @ui", () => {
  for (const rol of ROLES) {
    test(`OBS21-10 caso 3 — ${rol.nombre}`, async ({ page }, testInfo) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);
      await simularPrueba(page, ESTADOS.conTarjeta20);
      await entrar(page, rol);

      await expect(banner(page)).toContainText("te quedan 20 días gratis", { timeout: 20000 });
      await expect(banner(page), "'20 días' solo, sin aclarar, es lo que confundió a Roberto")
        .toContainText("incluyen los 7 días que sumaste al registrar tu tarjeta");
      await expect(banner(page)).toContainText(`Primer cargo: ${fechaCorta(Date.now() + 20 * DAY)}`);
      await page.screenshot({ path: testInfo.outputPath(`c3-${rol.clave}.png`) });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Caso 4 — Mi suscripción (solo Dueño; los demás no deben verla)
// ─────────────────────────────────────────────────────────────────────────
test.describe("OBS21-10 · caso 4 — Mi suscripción con tarjeta @ui", () => {
  for (const rol of ROLES) {
    test(`OBS21-10 caso 4 — ${rol.nombre}`, async ({ page }, testInfo) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);
      await simularPrueba(page, ESTADOS.conTarjeta20);
      await entrar(page, rol);
      await page.goto("/configuracion");

      const titulo = page.getByText("Mi suscripción", { exact: true });
      if (rol.clave !== "DUENO") {
        // Configuración puede no estar abierta a todos los roles: lo único que
        // se exige es que nadie más que el Dueño vea "Mi suscripción".
        await page.waitForLoadState("networkidle").catch(() => {});
        await expect(titulo, `${rol.nombre} no debe ver Mi suscripción`).toHaveCount(0);
        return;
      }

      await expect(titulo).toBeVisible({ timeout: 20000 });
      const dias = page.getByTestId("dias-prueba-con-tarjeta");
      await expect(dias).toContainText("Te quedan 20 días gratis");
      await expect(dias).toContainText("incluyen los 7 días que sumaste al registrar tu tarjeta");
      await expect(page.getByText(/Fin de la prueba y primer cargo/)).toBeVisible();
      await expect(page.getByText(/días de prueba restantes/)).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`c4-${rol.clave}.png`), fullPage: true });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Caso 5 — Regreso de Stripe (páginas públicas, sin sesión)
// ─────────────────────────────────────────────────────────────────────────
test.describe("OBS21-10 · caso 5 — regreso de la pasarela @ui", () => {
  test("OBS21-10 caso 5a — éxito: ya no promete '14 días' ni 'día 15'", async ({ page }, testInfo) => {
    await page.goto("/suscripcion/exito");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("¡Listo, tu tarjeta quedó registrada!");
    const texto = page.getByTestId("texto-exito-tarjeta");
    // BL-67: sin el dato del checkout (página abierta a mano) el texto es neutro;
    // "no se te cobró nada" solo sale cuando hubo días gratis (ver BL-67 caso 3).
    await expect(texto).toContainText("Mi suscripción");
    await expect(page.locator("body")).not.toContainText(/prueba de 14 días|el día 15/);
    // Hallazgo de la prueba manual (9-oct): el respaldo SIN sesión decía "tu pago se guardó",
    // que chocaba con "no se te cobró nada hoy".
    await expect(page.locator("body")).toContainText("Tu tarjeta quedó registrada. Inicia sesión con el correo y la contraseña de tu cuenta.");
    await expect(page.locator("body")).not.toContainText(/tu pago se guard/i);
    await page.screenshot({ path: testInfo.outputPath("c5-exito.png") });
  });

  test("OBS21-10 caso 5b — cancelado: ya no promete '14 días' ni 'día 15'", async ({ page }, testInfo) => {
    await page.goto("/suscripcion/cancelado");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("No completaste tu suscripción");
    await expect(page.locator("body")).not.toContainText(/prueba de 14 días|hasta el día 15/);
    await page.screenshot({ path: testInfo.outputPath("c5-cancelado.png") });
  });
});
