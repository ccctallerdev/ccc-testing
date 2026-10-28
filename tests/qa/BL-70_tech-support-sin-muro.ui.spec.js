const { test, expect } = require("@playwright/test");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-70 — Soporte técnico caía en /suscripcion cuando fallaba la carga del
 * perfil @ui (rama fix/bl70-tech-support-sin-muro-suscripcion-front)
 * — escrito NUEVO, en ROJO antes del fix
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   Síntoma (22-oct, QA y prod, intermitente): al entrar como TECH_SUPPORT
 *   salía "Elige tu plan" + "No pudimos cargar tu cuenta", aunque soporte no
 *   pertenece a ningún taller ni tiene suscripción. Minutos después la misma
 *   cuenta entraba bien.
 *
 *   Causa: `getUserById` devuelve `false` ante cualquier error (cold start,
 *   timeout, 5xx) → el `catch` de AuthContext ponía `subscriptionExpired=true`
 *   (BL-27) → /suscripcion. El front decidía "sin suscripción" por la AUSENCIA
 *   de idWorkshop en el doc, no por rol: si el doc no cargaba, no había cómo
 *   saberlo.
 *
 *   Arreglo (solo front): el rol firmado se lee antes del perfil y manda;
 *   `getUserById` reintenta una vez; "Volver a intentar" recarga por "/" (el
 *   home de cada rol) y no por /dashboard.
 *
 * Los fallos se SIMULAN interceptando GET /v1/users/:uid (como el caso 7 de
 * BL-27). Caso 1 y 4 son de soporte; caso 2 recorre los 7 roles (6 de taller
 * + soporte); caso 3 recorre los 6 de taller (guarda: BL-27 no se relaja).
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   ⚠️ Front LOCAL con la rama (QA corre el código viejo).
 *   Mismas variables que BL-27 (BASE_URL, ROL_*_EMAIL/PASS) y además:
 *     $env:ROL_TECH_EMAIL = "techsupport-qa@ccc-taller-qa.com"
 *     $env:ROL_TECH_PASS  = "<contraseña de soporte en refac>"
 *   npx playwright test --project=qa tests/qa/BL-70_tech-support-sin-muro.ui.spec.js
 *
 * ── ROJO ESPERADO sin el fix ──────────────────────────────────────────────
 *   Caso 1: soporte cae en /suscripcion con el aviso "No pudimos cargar tu cuenta".
 *   Caso 2: todos caen en /suscripcion (no había reintento).
 *   Caso 3 (Mecánico): tras "Volver a intentar" aparece el toast "No tienes
 *           acceso a esa pantalla" (recargaba por /dashboard).
 *   Caso 4 (guarda): pasa hoy y debe seguir pasando.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const TECH = {
  nombre: "Soporte técnico", clave: "TECH", plataforma: true,
  email: process.env.ROL_TECH_EMAIL || "techsupport-qa@ccc-taller-qa.com",
  pass: process.env.ROL_TECH_PASS,
  home: /\/gestion-planes/,
};

const ROLES_TALLER = [
  { nombre: "Dueño",         clave: "DUENO",
    email: process.env.ROL_DUENO_EMAIL || process.env.SEED_EMAIL || "rsv_gpa@outlook.com",
    pass: process.env.ROL_DUENO_PASS || process.env.SEED_PASSWORD || "admin123" },
  { nombre: "Administrador", clave: "ADMINISTRADOR" },
  { nombre: "Asesor",        clave: "ASESOR" },
  { nombre: "Compras",       clave: "COMPRAS" },
  { nombre: "Mecánico",      clave: "MECANICO", home: /\/servicios/ },
  { nombre: "Recepción",     clave: "RECEPCION" },
].map((r) => ({
  ...r,
  email: r.email || process.env[`ROL_${r.clave}_EMAIL`],
  pass: r.pass || process.env[`ROL_${r.clave}_PASS`],
}));

const TODOS = [...ROLES_TALLER, TECH];

/** GET /v1/users/:uid (no /me, no listas). */
const RE_USERS = /\/v1\/users\/(?!me\b)[^/?]+(\?|$)/;
const esGetPerfil = (req) => req.method() === "GET" && RE_USERS.test(req.url());

/** El perfil falla SIEMPRE con `codigo`. */
async function perfilSiempreFalla(page, codigo = 500) {
  await page.route(RE_USERS, (route) =>
    esGetPerfil(route.request())
      ? route.fulfill({ status: codigo, contentType: "application/json", body: JSON.stringify({ descripcion: "simulado" }) })
      : route.continue(),
  );
}

/** El perfil falla SOLO la primera vez (cold start) y luego pasa de largo. */
async function perfilFallaUnaVez(page, codigo = 503) {
  let fallos = 0;
  await page.route(RE_USERS, (route) => {
    if (esGetPerfil(route.request()) && fallos === 0) {
      fallos += 1;
      return route.fulfill({ status: codigo, contentType: "application/json", body: JSON.stringify({ descripcion: "simulado" }) });
    }
    return route.continue();
  });
  return () => fallos;
}

async function entrar(page, rol) {
  await page.goto("/login");
  await page.locator("#email").fill(rol.email);
  await page.locator("#password").fill(rol.pass);
  await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });
}

const aviso = (page) => page.getByTestId("aviso-motivo-suscripcion");
const toastSinAcceso = (page) => page.getByText("No tienes acceso a esa pantalla");
const sinCredenciales = (rol) => `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`;

test.describe.configure({ mode: "default" });

// ─────────────────────────────────────────────────────────────────────────
// Caso 1 — soporte con el perfil caído: entra a su CMS, nunca al muro.
// ─────────────────────────────────────────────────────────────────────────
test.describe("BL-70 · caso 1 — soporte técnico con users 500 NO ve el muro de suscripción @ui", () => {
  test(`BL-70 caso 1 — ${TECH.nombre}`, async ({ page }, testInfo) => {
    test.skip(!TECH.email || !TECH.pass, sinCredenciales(TECH));
    await perfilSiempreFalla(page, 500);
    await entrar(page, TECH);

    await expect(page, "ROJO hoy: caía en /suscripcion").toHaveURL(TECH.home, { timeout: 30000 });
    await expect(page).not.toHaveURL(/\/suscripcion/);
    await expect(aviso(page)).toHaveCount(0);
    await expect(page.getByText(/Elige tu plan/)).toHaveCount(0);
    // Sigue avisando que el perfil no cargó, pero sin bloquear.
    await expect(page.getByText(/No se pudo cargar tu perfil/)).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("heading", { name: /^Planes$/ })).toBeVisible({ timeout: 20000 });
    await page.screenshot({ path: testInfo.outputPath("c1-TECH.png"), fullPage: true });

    // Un refresh con el perfil caído tampoco lo saca de su CMS.
    await page.reload();
    await expect(page).toHaveURL(TECH.home, { timeout: 30000 });
    await expect(page).not.toHaveURL(/\/suscripcion/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Caso 2 — fallo TRANSITORIO (una sola respuesta 503): todos los roles entran
// como si nada, gracias al reintento. Es el escenario real del 22-oct.
// ─────────────────────────────────────────────────────────────────────────
test.describe("BL-70 · caso 2 — un 503 aislado en el perfil se absorbe con el reintento @ui", () => {
  for (const rol of TODOS) {
    test(`BL-70 caso 2 — ${rol.nombre}`, async ({ page }, testInfo) => {
      test.skip(!rol.email || !rol.pass, sinCredenciales(rol));
      const fallos = await perfilFallaUnaVez(page, 503);
      await entrar(page, rol);

      await expect(page, "ROJO hoy: sin reintento caía en /suscripcion").not.toHaveURL(/\/suscripcion/, { timeout: 30000 });
      await page.waitForTimeout(2500);
      await expect(page).not.toHaveURL(/\/suscripcion/);
      await expect(aviso(page)).toHaveCount(0);
      await expect(page.getByText(/No se pudo cargar tu perfil/)).toHaveCount(0);
      expect(fallos(), "el 503 simulado sí se disparó").toBe(1);
      if (rol.home) await expect(page).toHaveURL(rol.home);
      await page.screenshot({ path: testInfo.outputPath(`c2-${rol.clave}.png`), fullPage: true });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Caso 3 (guarda + ajuste) — un taller con el perfil caído SIGUE yendo a
// /suscripcion con el aviso de BL-27 (no se relaja nada), y "Volver a
// intentar" lo regresa a SU home sin el toast de "no tienes acceso".
// ─────────────────────────────────────────────────────────────────────────
test.describe("BL-70 · caso 3 — un taller con users 500 sigue viendo el aviso; reintentar lo lleva a su home @ui", () => {
  for (const rol of ROLES_TALLER) {
    test(`BL-70 caso 3 — ${rol.nombre}`, async ({ page }, testInfo) => {
      test.skip(!rol.email || !rol.pass, sinCredenciales(rol));
      await perfilSiempreFalla(page, 500);
      await entrar(page, rol);

      await expect(page).toHaveURL(/\/suscripcion/, { timeout: 30000 });
      await expect(aviso(page)).toBeVisible({ timeout: 20000 });
      await expect(aviso(page)).toHaveAttribute("data-motivo", "perfil_no_cargado");
      await page.screenshot({ path: testInfo.outputPath(`c3-${rol.clave}.png`), fullPage: true });

      await page.unroute(RE_USERS);
      await aviso(page).getByRole("button", { name: /Volver a intentar/ }).click();
      await expect(page).not.toHaveURL(/\/suscripcion/, { timeout: 30000 });
      await page.waitForTimeout(2000);
      await expect(toastSinAcceso(page), "ROJO hoy para Mecánico: recargaba por /dashboard").toHaveCount(0);
      if (rol.home) await expect(page).toHaveURL(rol.home);
      await page.screenshot({ path: testInfo.outputPath(`c3-tras-reintentar-${rol.clave}.png`), fullPage: true });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Caso 4 (guarda) — soporte con todo sano: entra a Gestión de Planes y el
// header lo identifica (el perfil sí cargó).
// ─────────────────────────────────────────────────────────────────────────
test.describe("BL-70 · caso 4 — soporte técnico con el perfil sano entra normal @ui", () => {
  test(`BL-70 caso 4 — ${TECH.nombre}`, async ({ page }) => {
    test.skip(!TECH.email || !TECH.pass, sinCredenciales(TECH));
    await entrar(page, TECH);
    await expect(page).toHaveURL(TECH.home, { timeout: 30000 });
    await expect(aviso(page)).toHaveCount(0);
    await expect(page.getByText(/No se pudo cargar tu perfil/)).toHaveCount(0);
    await expect(page.getByText("Soporte Técnico")).toBeVisible({ timeout: 20000 });
  });
});
