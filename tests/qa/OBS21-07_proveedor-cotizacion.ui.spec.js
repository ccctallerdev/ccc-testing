const { test, expect } = require("@playwright/test");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OBS21-07 — la cotización que ve el cliente NO muestra el proveedor @ui
 * (rama fix/obs21-07-proveedor-cotizacion-front) — escrito NUEVO, en ROJO antes del fix
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Roberto, 21-sep-2026 (punto 8, "lo más importante"): "Cuando se hace la
 * cotización y está lista para enviar al cliente, sale el nombre del proveedor,
 * ese no debería de salir. Hay que ocultarlo."
 *
 * La vista es /cotizacion-vista/:id (capacidad CAN_CREATE_QUOTE: Dueño,
 * Administrador, Asesor; Recepción se colapsa en Asesor). Compras y Mecánico
 * rebotan. Para los que entran, la tabla "Refacciones y materiales" NO debe
 * tener columna Proveedor ni pintar el nombre del proveedor de ninguna partida.
 *
 * Los datos se SIMULAN interceptando GET /entries/:id y GET /entries/:id/quotes/:qid
 * (mismo patrón que BLOQUE-TRIV02): así el caso no depende de que exista una OS
 * con cotización en el ambiente y siempre prueba una partida CON proveedor.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   ⚠️ Front LOCAL con la rama (QA corre el código viejo).
 *   $env:BASE_URL="http://localhost:3000"; $env:SKIP_SEED="1"
 *   $env:ROL_DUENO_EMAIL="rsv_gpa@outlook.com";                $env:ROL_DUENO_PASS="admin123"
 *   $env:ROL_ADMINISTRADOR_EMAIL="rsv_gpa+admin1@outlook.com"; $env:ROL_ADMINISTRADOR_PASS="Prueba_123!"
 *   $env:ROL_ASESOR_EMAIL="rsv_gpa+asesor1@outlook.com";       $env:ROL_ASESOR_PASS="Prueba_123!"
 *   $env:ROL_COMPRAS_EMAIL="rsv_gpa+compras1@outlook.com";     $env:ROL_COMPRAS_PASS="Prueba_123!"
 *   $env:ROL_MECANICO_EMAIL="rsv_gpa+mecanico1@outlook.com";   $env:ROL_MECANICO_PASS="Prueba_123!"
 *   $env:ROL_RECEPCION_EMAIL="rsv_gpa+recepcion1@outlook.com"; $env:ROL_RECEPCION_PASS="Prueba_123!"
 *   npx playwright test --project=qa tests/qa/OBS21-07_proveedor-cotizacion.ui.spec.js
 *
 * ── ROJO ESPERADO sin el fix ──────────────────────────────────────────────
 *   El encabezado "Proveedor" existe y la celda dice "Distribuidora La Estrella".
 * ═══════════════════════════════════════════════════════════════════════════
 */

const ROLES = [
  { nombre: "Dueño",         clave: "DUENO",         entra: true,
    email: process.env.ROL_DUENO_EMAIL || process.env.SEED_EMAIL || "rsv_gpa@outlook.com",
    pass: process.env.ROL_DUENO_PASS || process.env.SEED_PASSWORD || "admin123" },
  { nombre: "Administrador", clave: "ADMINISTRADOR", entra: true },
  { nombre: "Asesor",        clave: "ASESOR",        entra: true },
  { nombre: "Compras",       clave: "COMPRAS",       entra: false },
  { nombre: "Mecánico",      clave: "MECANICO",      entra: false },
  { nombre: "Recepción",     clave: "RECEPCION",     entra: true },
].map((r) => ({
  ...r,
  email: r.email || process.env[`ROL_${r.clave}_EMAIL`],
  pass: r.pass || process.env[`ROL_${r.clave}_PASS`],
}));

const ENTRY_ID = "e2e-obs21-07-entry";
const QUOTE_ID = "e2e-obs21-07-quote";
const PROVEEDOR = "Distribuidora La Estrella";

const QUOTE = {
  id: QUOTE_ID,
  stage: "COTIZACION",
  status: "ENVIADA",
  diagnostic: "ROJO · Sistema eléctrico / Baterías: el BMS necesita actualización.",
  parts: [
    { id: "p1", description: "Actualización software BMS", supplierName: PROVEEDOR, supplierId: "sup-estrella", availability: "por-pedir", count: 1, unitPrice: 1800 },
    { id: "p2", description: "Filtro de cabina (polen)", supplierName: "", availability: "en-inventario", count: 1, unitPrice: 243 },
    { id: "p3", description: "Banda de accesorios", supplierName: PROVEEDOR, supplierId: "sup-estrella", count: 2, unitPrice: 380 },
  ],
  labor: [
    { id: "l1", description: "Cambio de filtro de cabina", count: 1, unitPrice: 350 },
    { id: "l2", description: "Cambio de banda de accesorios", count: 1, unitPrice: 350 },
  ],
};

const ENTRY = {
  id: ENTRY_ID,
  sheet: "1130",
  statusService: "EN_ESPERA",
  quoteId: QUOTE_ID,
  quote: QUOTE,
  car: { brand: "Volkswagen", model: "Jetta", year: "2022", codeCar: "MNO-345" },
  client: { name: "Cliente", firstSurname: "Prueba", phone: "5555555555" },
};

async function entrarComo(page, rol) {
  await page.goto("/login");
  await page.locator("#email").fill(rol.email);
  await page.locator("#password").fill(rol.pass);
  await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });
  await expect(page).not.toHaveURL(/\/suscripcion/, { timeout: 5000 });
}

/** Simula la OS y su cotización; lo demás (clientes, autos) sigue yendo al API real. */
async function simularCotizacion(page) {
  await page.route(new RegExp(`/entries/${ENTRY_ID}/quotes/${QUOTE_ID}(\\?.*)?$`), (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: QUOTE }) })
  );
  await page.route(new RegExp(`/entries/${ENTRY_ID}(\\?.*)?$`), (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: ENTRY }) })
  );
}

test.describe.configure({ mode: "default" });

test.describe("OBS21-07 — la cotización no muestra el proveedor @ui", () => {
  for (const rol of ROLES) {
    test(`OBS21-07 — ${rol.nombre}`, async ({ page }) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);
      await simularCotizacion(page);
      await entrarComo(page, rol);
      await page.goto(`/cotizacion-vista/${ENTRY_ID}`);

      if (!rol.entra) {
        await expect(page, `${rol.nombre} debe rebotar de la cotización`).not.toHaveURL(/\/cotizacion-vista/, { timeout: 15000 });
        await expect(page.getByText(/no tienes acceso/i)).toBeVisible({ timeout: 10000 });
        return;
      }

      // La cotización cargó: se ve la partida simulada
      await expect(page.getByText("Actualización software BMS")).toBeVisible({ timeout: 20000 });
      // Ni encabezado "Proveedor" ni el nombre del proveedor en ninguna celda
      await expect(page.getByRole("columnheader", { name: /proveedor/i })).toHaveCount(0);
      await expect(page.getByText(PROVEEDOR)).toHaveCount(0);
      // Lo demás sigue: descripción, unitario y subtotal de la partida
      const fila = page.getByRole("row", { name: /Actualización software BMS/ });
      await expect(fila).toContainText("$1,800.00");
    });
  }
});
