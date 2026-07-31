// @ts-check
const { defineConfig } = require("@playwright/test");

/**
 * Playwright para pruebas E2E de CCC.
 * Usa el navegador Edge YA INSTALADO (channel: "msedge") — no descarga Chromium.
 * Apunta al frontend local (localhost:3000). Correr todo con: npm test
 *
 * ─── DOS EJES PARA FILTRAR ───────────────────────────────────────────────
 *
 * 1) POR ÁREA (carpetas de tests/, un "project" cada una):
 *      npm run test:operacion        →  solo el ciclo del taller
 *      npx playwright test --project=abastecimiento
 *
 * 2) POR TIPO (etiquetas en cada test, cruzan todas las áreas):
 *      npm run test:api     → solo las de API (sin navegador, rápidas)
 *      npm run test:ui      → solo las que abren el navegador
 *      npm run test:rapido  → todo menos @lento y @red
 *      npm run test:sin-red → todo menos lo que sale a internet
 *
 *    Etiquetas: @api · @ui · @lento (ciclos completos, minutos)
 *               @humo (arranque) · @publico (sitio sin sesión) · @red (sale a internet)
 *
 * Se pueden combinar:  npx playwright test --project=comercial --grep @api
 *
 * ⚠️  Un spec suelto en tests/ (fuera de una carpeta de área) NO pertenece a
 *     ningún project y NO se ejecuta. global-setup avisa si encuentra alguno.
 */
const AREAS = [
  { name: "publico",        descripcion: "Sitio público del embudo — no requiere sesión ni semillas" },
  { name: "acceso",         descripcion: "Login, roles y permisos, configuración" },
  { name: "operacion",      descripcion: "El ciclo del taller: recepción → diagnóstico → producción → entrega" },
  { name: "comercial",      descripcion: "Clientes, cotización, aprobación y documentos" },
  { name: "abastecimiento", descripcion: "Compras, recepción de refacciones e inventario" },
  { name: "direccion",      descripcion: "Centro de Control, contadores y garantías" },
  { name: "regresiones",    descripcion: "Fixes puntuales que no tienen casa propia" },
];

module.exports = defineConfig({
  // Siembra usuario/taller/datos base antes de la suite (adiós semillas manuales).
  globalSetup: "./global-setup.js",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.BASE_URL || "http://localhost:3000",
    channel: "msedge", // usa Microsoft Edge del sistema (Chromium)
    headless: false, // ponlo en true para correr sin ver la ventana
    viewport: { width: 1366, height: 900 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: AREAS.map(({ name }) => ({ name, testDir: `./tests/${name}` })),
});

module.exports.AREAS = AREAS;
