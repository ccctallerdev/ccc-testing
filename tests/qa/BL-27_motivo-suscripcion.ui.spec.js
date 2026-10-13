const { test, expect } = require("@playwright/test");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-27 — El rebote a /suscripcion dice POR QUÉ @ui
 * (rama fix/bl27-motivo-suscripcion-front) — escrito NUEVO, en ROJO antes del fix
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   Síntoma (15-sep, probando BL-20): con credenciales válidas, la app manda a
 *   /suscripcion SIN una palabra. Cinco situaciones se veían igual: nunca pagó,
 *   venció, canceló, falló el cobro… o NO PUDIMOS LEER su estado. Un taller que
 *   sí pagó veía lo mismo que uno que nunca pagó.
 *
 *   Arreglo: AuthContext conserva el motivo y /suscripcion lo pinta arriba de
 *   los planes; "no pudimos verificar" ofrece reintentar, el cobro fallido abre
 *   el método de pago.
 *
 * Los estados se SIMULAN interceptando /billing/status (y /subscriptions, la
 * lectura legada), como BL-50 y OBS21-10. Cada caso recorre los 6 roles: todos
 * cargan el estado al entrar y todos caen en /suscripcion si no hay acceso.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   ⚠️ Front LOCAL con la rama (QA corre el código viejo).
 *   Mismas variables que OBS21-10 (BASE_URL, SKIP_SEED, ROL_*_EMAIL/PASS).
 *   npx playwright test --project=qa tests/qa/BL-27_motivo-suscripcion.ui.spec.js
 *
 * ── ROJO ESPERADO sin el fix ──────────────────────────────────────────────
 *   Casos 1–4: no existe ningún aviso [data-testid=aviso-motivo-suscripcion].
 *   Caso 5 y 6 (guardas): pasan hoy y deben seguir pasando.
 * ═══════════════════════════════════════════════════════════════════════════
 */

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

const RE_STATUS = /\/billing\/status\//;
const RE_LEGADO = /\/v1\/subscriptions\//;

/** /billing/status responde con este código, sin cuerpo útil. */
async function statusConCodigo(page, codigo) {
  await page.route(RE_STATUS, (route) =>
    route.fulfill({ status: codigo, contentType: "application/json", body: JSON.stringify({ descripcion: "simulado" }) }),
  );
}

/** /billing/status responde 200 con el documento real pisado por `parche`. */
async function statusConDatos(page, parche) {
  await page.route(RE_STATUS, async (route) => {
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

const aviso = (page) => page.getByTestId("aviso-motivo-suscripcion");

test.describe.configure({ mode: "default" });

const SIN_ACCESO = { hasAccess: false, status: 3, trialType: "card", nextStep: "subscribe", trialDaysLeft: null };

const CASOS = [
  {
    id: "1", titulo: "la lectura del estado FALLA (500) → 'no pudimos verificar' + reintentar",
    preparar: (page) => statusConCodigo(page, 500),
    motivo: "no_verificado", texto: /No pudimos verificar tu plan/, boton: /Volver a intentar/,
    noDebe: /No encontramos una suscripción/,
  },
  {
    id: "2", titulo: "sin suscripción (404 en billing y en la lectura legada)",
    preparar: async (page) => {
      await statusConCodigo(page, 404);
      await page.route(RE_LEGADO, (route) => route.fulfill({ status: 404, body: "{}" }));
    },
    motivo: "sin_suscripcion", texto: /No encontramos una suscripción para tu taller/,
    extra: /soporte@controlcentralcar\.com/,
  },
  {
    id: "3", titulo: "cobro fallido (past_due) → actualizar método de pago",
    preparar: (page) => statusConDatos(page, { ...SIN_ACCESO, stripeStatus: "past_due" }),
    motivo: "cobro_fallido", texto: /No pudimos cobrar tu suscripción/, boton: /Actualizar método de pago/,
  },
  {
    id: "4", titulo: "cancelada (canceled)",
    preparar: (page) => statusConDatos(page, { ...SIN_ACCESO, stripeStatus: "canceled" }),
    motivo: "cancelada", texto: /Tu suscripción está cancelada/,
  },
];

for (const caso of CASOS) {
  test.describe(`BL-27 · caso ${caso.id} — ${caso.titulo} @ui`, () => {
    for (const rol of ROLES) {
      test(`BL-27 caso ${caso.id} — ${rol.nombre}`, async ({ page }, testInfo) => {
        test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);
        await caso.preparar(page);
        await entrar(page, rol);

        await expect(page, "sin acceso debe caer en /suscripcion").toHaveURL(/\/suscripcion/, { timeout: 30000 });
        await expect(aviso(page), "ROJO hoy: la pantalla no dice por qué").toBeVisible({ timeout: 20000 });
        await expect(aviso(page)).toHaveAttribute("data-motivo", caso.motivo);
        await expect(aviso(page)).toContainText(caso.texto);
        if (caso.extra) await expect(aviso(page)).toContainText(caso.extra);
        if (caso.noDebe) await expect(aviso(page)).not.toContainText(caso.noDebe);
        if (caso.boton) await expect(aviso(page).getByRole("button", { name: caso.boton })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`c${caso.id}-${rol.clave}.png`), fullPage: true });

        // Caso 1: al reintentar con el backend ya sano, el aviso de "no pudimos
        // verificar" desaparece (si el taller tiene acceso, vuelve a su taller).
        if (caso.id === "1") {
          await page.unroute(RE_STATUS);
          await aviso(page).getByRole("button", { name: /Volver a intentar/ }).click();
          await expect(page.getByText("No pudimos verificar tu plan")).toHaveCount(0, { timeout: 20000 });
          await page.screenshot({ path: testInfo.outputPath(`c1-tras-reintentar-${rol.clave}.png`), fullPage: true });
        }
      });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Caso 7 — hallazgo de la prueba manual (9-oct): con el servidor caído falla
// la carga de la CUENTA antes que la del plan. Debe avisar igual (no solo un
// toast) y "Volver a intentar" debe regresar al taller cuando el back vuelve.
// ─────────────────────────────────────────────────────────────────────────
test.describe("BL-27 · caso 7 — la cuenta no carga (users 500) → 'no pudimos cargar tu cuenta' @ui", () => {
  for (const rol of ROLES) {
    test(`BL-27 caso 7 — ${rol.nombre}`, async ({ page }, testInfo) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);
      const RE_USERS = /\/v1\/users\/(?!me)[^/?]+/;
      await page.route(RE_USERS, (route) =>
        route.request().method() === "GET"
          ? route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
          : route.continue(),
      );
      await entrar(page, rol);
      await expect(page).toHaveURL(/\/suscripcion/, { timeout: 30000 });
      await expect(aviso(page), "antes solo había un toast").toBeVisible({ timeout: 20000 });
      await expect(aviso(page)).toHaveAttribute("data-motivo", "perfil_no_cargado");
      await expect(aviso(page)).toContainText("No pudimos cargar tu cuenta");
      await expect(aviso(page)).not.toContainText(/No encontramos una suscripción/);
      await page.screenshot({ path: testInfo.outputPath(`c7-${rol.clave}.png`), fullPage: true });

      await page.unroute(RE_USERS);
      await aviso(page).getByRole("button", { name: /Volver a intentar/ }).click();
      await expect(page.getByText("No pudimos cargar tu cuenta")).toHaveCount(0, { timeout: 30000 });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Caso 5 (guarda) — prueba sin tarjeta vencida: la pantalla ya lo explica
// (OBS21-10); NO debe aparecer un segundo aviso encima.
// ─────────────────────────────────────────────────────────────────────────
test.describe("BL-27 · caso 5 — prueba sin tarjeta vencida: sin aviso duplicado @ui", () => {
  for (const rol of ROLES) {
    test(`BL-27 caso 5 — ${rol.nombre}`, async ({ page }) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);
      await statusConDatos(page, {
        hasAccess: false, status: 3, trialType: "cardless", nextStep: "register_card",
        trialDaysLeft: null, cardTrialDays: 7, externalSubscriptionId: null,
      });
      await entrar(page, rol);
      await expect(page).toHaveURL(/\/suscripcion/, { timeout: 30000 });
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Continúa 7 días más, gratis", { timeout: 20000 });
      await expect(aviso(page)).toHaveCount(0);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Caso 6 (guarda) — con acceso NO cambia nada: no rebota ni pinta aviso.
// ─────────────────────────────────────────────────────────────────────────
test.describe("BL-27 · caso 6 — con acceso no rebota ni hay aviso @ui", () => {
  for (const rol of ROLES) {
    test(`BL-27 caso 6 — ${rol.nombre}`, async ({ page }) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);
      await statusConDatos(page, { hasAccess: true, status: 2, stripeStatus: "active", trialType: "card", nextStep: "none" });
      await entrar(page, rol);
      await page.waitForTimeout(2000);
      await expect(page, "con acceso no debe rebotar a /suscripcion").not.toHaveURL(/\/suscripcion/);
      await page.goto("/suscripcion");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20000 });
      await expect(aviso(page)).toHaveCount(0);
    });
  }
});
