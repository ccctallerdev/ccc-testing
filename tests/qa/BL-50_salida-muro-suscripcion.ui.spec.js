const { test, expect } = require("@playwright/test");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-50 — Sesión vencida ATRAPADA en la pantalla de planes @ui
 * (rama fix/bl50-salida-muro-suscripcion-front) — escrito NUEVO, en ROJO antes del fix
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   Síntoma (21-sep): cuando la suscripción vence, el muro manda a /suscripcion
 *   y ahí el usuario se queda encerrado: no hay botón de cerrar sesión (el
 *   chrome del sistema se esconde y en su lugar aparece la navbar PÚBLICA, cuyo
 *   único botón es "Iniciar Sesión"… con la sesión ya iniciada). La única salida
 *   es esperar a que caduque la sesión de Firebase.
 *
 *   Decisión (Dev, 22-sep): con la cuenta vencida se muestra el HEADER del
 *   usuario (logo, nombre, avatar, "Cerrar sesión") SIN sidebar ni BottomNav, y
 *   abajo solo el panel de planes. Las pestañas siguen bloqueadas (eso ya lo
 *   hace ProtectedRoute). Pasear por la landing con la sesión vencida abierta
 *   queda como duda D32 con Roberto: este spec NO lo exige.
 *
 * Cada caso recorre los 6 roles (todos cargan /billing/status al entrar, así
 * que el muro les aplica igual). Un rol sin credenciales se marca SKIP.
 *
 * El vencimiento se SIMULA interceptando /billing/status (misma técnica que el
 * caso 5 de BLOQUE-NAV): no hay que vencer nada en Stripe y el taller de QA
 * sigue sano.
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
 *   npx playwright test --project=qa tests/qa/BL-50_salida-muro-suscripcion.ui.spec.js
 *
 * ── ROJO ESPERADO sin el fix ──────────────────────────────────────────────
 *   Caso 1  en /suscripcion se ve "Iniciar Sesión" (navbar pública) y NO hay
 *           ningún botón "Cerrar sesión".
 *   Caso 2  no hay botón que pulsar → no se puede cerrar sesión → el usuario
 *           sigue en /suscripcion con la sesión viva.
 *   Caso 3  (guarda) las pestañas rebotan a /suscripcion — pasa HOY y debe
 *           SEGUIR pasando con el fix: el arreglo abre la puerta de salida, no
 *           las pestañas.
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

// Pestañas que cada rol SÍ tendría abiertas con la suscripción sana; con la
// cuenta vencida TODAS deben rebotar a /suscripcion (ProtectedRoute).
const PESTANAS = ["/clientes", "/dashboard", "/produccion", "/configuracion"];

/** Vence la suscripción "en el aire": /billing/status responde sin acceso. */
async function vencerSuscripcion(page) {
  await page.route(/\/billing\/status\//, async (route) => {
    const res = await route.fetch();
    const json = await res.json().catch(() => null);
    if (!json?.data) return route.fulfill({ response: res });
    json.data.hasAccess = false;
    json.data.status = 3; // Expired
    json.data.nextStep = "subscribe";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(json),
    });
  });
}

/** Login con la cuenta vencida: debe depositar en /suscripcion (BL-27). */
async function entrarVencido(page, rol) {
  await vencerSuscripcion(page);
  await page.goto("/login");
  await page.locator("#email").fill(rol.email);
  await page.locator("#password").fill(rol.pass);
  await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
  await expect(page, "precondición BL-27: la sesión vencida aterriza en /suscripcion").toHaveURL(
    /\/suscripcion/,
    { timeout: 30000 },
  );
  await expect(page.getByRole("heading", { name: /elige tu plan|continúa .* días más/i })).toBeVisible({
    timeout: 20000,
  });
}

// Botón de cerrar sesión del HEADER del usuario (icono, visible desde `sm`).
// El menú del avatar está cerrado, así que hay exactamente uno con ese nombre.
const botonCerrarSesion = (page) => page.getByRole("button", { name: /cerrar sesi[oó]n/i });
const enlaceIniciarSesion = (page) => page.getByRole("link", { name: /iniciar sesi[oó]n/i });
const sidebar = (page) => page.getByRole("complementary", { name: /navegaci[oó]n principal/i });

// Casos independientes: un rojo no debe tumbar al resto.
test.describe.configure({ mode: "default" });

// ─────────────────────────────────────────────────────────────────────────
// Caso 1 — En el muro se ve el header del USUARIO, no la navbar pública
// ─────────────────────────────────────────────────────────────────────────
test.describe("BL-50 · caso 1 — el muro conserva el header del usuario con Cerrar sesión @ui", () => {
  for (const rol of ROLES) {
    test(`BL-50 caso 1 — ${rol.nombre}`, async ({ page }) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);

      await entrarVencido(page, rol);

      // ROJO hoy: aparece la navbar pública con "Iniciar Sesión"… con sesión iniciada.
      await expect(
        enlaceIniciarSesion(page),
        "con la sesión iniciada no debe ofrecerse 'Iniciar Sesión' (es la navbar pública)",
      ).toHaveCount(0);

      // ROJO hoy: no existe ningún botón de cerrar sesión.
      await expect(
        botonCerrarSesion(page),
        "el muro debe dejar SIEMPRE la puerta de Cerrar sesión",
      ).toBeVisible({ timeout: 10000 });

      // El header es el del usuario: se ve su nombre (lo pinta header.jsx).
      await expect(page.locator("header")).toBeVisible();

      // Sin menú lateral: no hay pestañas a donde ir hasta que pague.
      await expect(sidebar(page), "con la cuenta vencida no debe haber sidebar").toHaveCount(0);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Caso 2 — Cerrar sesión desde el muro FUNCIONA y termina en /login
// ─────────────────────────────────────────────────────────────────────────
test.describe("BL-50 · caso 2 — se puede cerrar sesión desde el muro @ui", () => {
  for (const rol of ROLES) {
    test(`BL-50 caso 2 — ${rol.nombre}`, async ({ page }) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);

      await entrarVencido(page, rol);

      // ROJO hoy: el botón no existe, el clic no puede darse y el usuario se
      // queda con la sesión viva en /suscripcion.
      await botonCerrarSesion(page).click({ timeout: 10000 });

      // Modal de confirmación (layouts/utils/LogOut.jsx).
      const modal = page.locator("div", { hasText: /seguro que quieres cerrar sesi[oó]n/i }).last();
      await modal.getByRole("button", { name: /cerrar sesi[oó]n/i }).click();

      // Sesión cerrada de verdad: ProtectedRoute expulsa a /login…
      await expect(page, "tras cerrar sesión debe quedar fuera, en /login").toHaveURL(/\/login/, {
        timeout: 20000,
      });
      // …y la landing pública vuelve a ser alcanzable como visitante.
      await page.goto("/");
      await expect(page, "sin sesión, la landing ya no rebota a /suscripcion").not.toHaveURL(/\/suscripcion/, {
        timeout: 15000,
      });
      await expect(enlaceIniciarSesion(page).first()).toBeVisible({ timeout: 15000 });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Caso 3 — GUARDA: las pestañas siguen bloqueadas (esto NO cambia con el fix)
// ─────────────────────────────────────────────────────────────────────────
test.describe("BL-50 · caso 3 — las pestañas del taller siguen rebotando al muro @ui", () => {
  for (const rol of ROLES) {
    test(`BL-50 caso 3 — ${rol.nombre}`, async ({ page }) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);

      await entrarVencido(page, rol);

      for (const ruta of PESTANAS) {
        await page.goto(ruta);
        await expect(page, `${ruta} debe rebotar a /suscripcion con la cuenta vencida`).toHaveURL(
          /\/suscripcion/,
          { timeout: 15000 },
        );
      }
      // Y sigue viendo el panel de planes, no una pantalla vacía.
      await expect(page.getByRole("heading", { name: /elige tu plan|continúa .* días más/i })).toBeVisible();
    });
  }
});
