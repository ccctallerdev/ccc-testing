const { test, expect } = require("@playwright/test");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-14 — los claims de roles quedaron AL DERECHO (SUPER_ADMIN=Dueño, ADMIN=Administrador) @ui
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El problema histórico: internamente ADMIN era el Dueño y SUPER_ADMIN el
 * Administrador — al revés de lo que cualquiera supone. El 17-sep-2026 se
 * intercambiaron (código + migración `migrar-roles-bl14.js`).
 *
 * Este spec es la prueba de los 6 roles que exige la etiqueta riesgo-alto:
 * para cada rol con credenciales configuradas, verifica que tras iniciar
 * sesión (1) NO se queda varado en /login, (2) aterriza donde manda
 * `homeSeguro`, y (3) el header lo etiqueta con el nombre CORRECTO — la
 * aserción que hoy es el rojo natural: el Dueño ve "Administrador" en el
 * header porque su claim viejo (ADMIN) siempre significó otra cosa.
 *
 * EN ROJO antes del cambio; VERDE solo con código nuevo + migración corrida.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   ⚠️ Requiere front local Y backend local, DESPUÉS de aplicar
 *      `migrar-roles-bl14.js --apply` en refac (y re-login = tokens nuevos).
 *   $env:BASE_URL="http://localhost:3000"; $env:SKIP_SEED="1"
 *   $env:ROL_DUENO_EMAIL="rsv_gpa@outlook.com"; $env:ROL_DUENO_PASS="admin123"
 *   # opcionales, si el taller de prueba tiene esas cuentas:
 *   $env:ROL_ADMINISTRADOR_EMAIL="..."; $env:ROL_ADMINISTRADOR_PASS="..."
 *   $env:ROL_ASESOR_EMAIL="...";        $env:ROL_ASESOR_PASS="..."
 *   $env:ROL_COMPRAS_EMAIL="...";       $env:ROL_COMPRAS_PASS="..."
 *   $env:ROL_MECANICO_EMAIL="rsv_gpa+mecanico1@outlook.com"; $env:ROL_MECANICO_PASS="admin123"
 *   $env:ROL_RECEPCION_EMAIL="...";     $env:ROL_RECEPCION_PASS="..."
 *   npx playwright test --project=qa tests/qa/BL-14_roles-al-derecho.ui.spec.js
 *
 *   Los roles sin credenciales se saltan (se reporta cuáles).
 * ═══════════════════════════════════════════════════════════════════════════
 */

const ROLES = [
  {
    nombre: "Dueño",
    email: process.env.ROL_DUENO_EMAIL || process.env.SEED_EMAIL || "rsv_gpa@outlook.com",
    pass: process.env.ROL_DUENO_PASS || process.env.SEED_PASSWORD || "admin123",
    // Dueño tiene CAN_VIEW_CLIENTS → aterriza en /clientes (RedirectIfAuthenticated)
    aterriza: /\/(clientes|dashboard)/,
    etiqueta: /^Dueño$/,
  },
  {
    nombre: "Administrador",
    email: process.env.ROL_ADMINISTRADOR_EMAIL,
    pass: process.env.ROL_ADMINISTRADOR_PASS,
    aterriza: /\/(clientes|dashboard)/,
    etiqueta: /^Administrador$/,
  },
  {
    nombre: "Asesor",
    email: process.env.ROL_ASESOR_EMAIL,
    pass: process.env.ROL_ASESOR_PASS,
    aterriza: /\/(clientes|dashboard)/,
    etiqueta: /^asesor$/i, // el header baja a minúsculas los roles sin etiqueta propia
  },
  {
    nombre: "Compras",
    email: process.env.ROL_COMPRAS_EMAIL,
    pass: process.env.ROL_COMPRAS_PASS,
    aterriza: /\/(dashboard|servicios)/,
    etiqueta: /^compras$/i,
  },
  {
    nombre: "Mecánico",
    email: process.env.ROL_MECANICO_EMAIL,
    pass: process.env.ROL_MECANICO_PASS,
    // homeSeguro: el Mecánico no ve dashboard → /servicios (bloque navegación)
    aterriza: /\/servicios/,
    etiqueta: /^Mecánico$/,
  },
  {
    nombre: "Recepción",
    email: process.env.ROL_RECEPCION_EMAIL,
    pass: process.env.ROL_RECEPCION_PASS,
    aterriza: /\/(clientes|dashboard|servicios)/,
    etiqueta: /^recepcion$/i,
  },
];

test.describe("BL-14 — seis roles con nombres al derecho @ui", () => {
  for (const rol of ROLES) {
    test(`${rol.nombre}: entra, aterriza bien y el header lo nombra bien`, async ({ page }) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_*_EMAIL/PASS)`);

      await page.goto("/login");
      await page.locator("#email").fill(rol.email);
      await page.locator("#password").fill(rol.pass);
      await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();

      // 1) No se queda varado en /login (ni rebota a /suscripcion)
      await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });
      await expect(page).not.toHaveURL(/\/suscripcion/, {
        timeout: 5000,
      });

      // 2) Aterriza donde manda homeSeguro / RedirectIfAuthenticated
      await expect(page, `${rol.nombre} debe aterrizar en su pantalla`).toHaveURL(rol.aterriza, {
        timeout: 15000,
      });

      // 3) La etiqueta del header dice la VERDAD sobre el rol.
      //    (El rojo histórico: el Dueño veía "Administrador".)
      await expect(
        page.getByText(rol.etiqueta).first(),
        `el header debe etiquetar a ${rol.nombre} correctamente`,
      ).toBeVisible({ timeout: 15000 });
    });
  }
});
