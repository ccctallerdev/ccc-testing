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
 *
 * ─── PROJECT "demo" (Demo Day) ───────────────────────────────────────────
 * Recorridos para que un humano los vea correr, no para CI. Va más lento
 * a propósito (slowMo entre acciones) y siempre graba video:
 *      npm run test:demo
 * Velocidad ajustable sin tocar el spec:
 *      DEMO_SLOWMO=600 DEMO_PAUSE_MS=2000 npm run test:demo
 */
const AREAS = [
  { name: "publico", legacy: true,        descripcion: "Sitio público del embudo — no requiere sesión ni semillas" },
  { name: "acceso", legacy: true,         descripcion: "Login, roles y permisos, configuración" },
  { name: "operacion", legacy: true,      descripcion: "El ciclo del taller: recepción → diagnóstico → producción → entrega" },
  { name: "comercial", legacy: true,      descripcion: "Clientes, cotización, aprobación y documentos" },
  { name: "abastecimiento", legacy: true, descripcion: "Compras, recepción de refacciones e inventario" },
  { name: "direccion", legacy: true,      descripcion: "Centro de Control, contadores y garantías" },
  { name: "marketing", legacy: true,      descripcion: "CMS del sitio público (Fase 2): contenido por página, media y volúmenes" },
  { name: "regresiones", legacy: true,    descripcion: "Fixes puntuales que no tienen casa propia" },
  { name: "obs16ago", legacy: true,       descripcion: "Correcciones del 25-ago a las observaciones del cliente del 16-ago (seguridad, diagnósticos, importación, Modelo Operativo, Abastecimiento)" },
  { name: "demo",           descripcion: "Recorridos guiados para mostrar la app EN VIVO (Demo Day). A propósito van lentos (slowMo) — no son regresión, no correr en CI." },
  { name: "e2e_v2",         descripcion: "Recorrido completo POR INTERFAZ contra refac, sin un solo atajo por API: registro del taller (Stripe test) → equipo por rol → recepción → diagnóstico → cotización → aprobación del cliente en el celular → abastecimiento → reparación → entrega. Es el que sí detecta una regresión del front." },
  { name: "qa",             descripcion: "Gemelos para refac (QA) de specs que en tests/ están atados a los emuladores. NO reemplazan al original: son copias con la autenticación y la siembra adaptadas a Firebase real. Requieren el serviceAccountKey de refac." },
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
  projects: AREAS.map(({ name, legacy }) => {
    // Los proyectos marcados `legacy` viven en tests/_legacy/ (ver el README
    // de esa carpeta: se apoyan en atajos por API y pasan aunque la pantalla
    // esté rota, así que no valen como red de seguridad).
    const testDir = `./tests/${legacy ? "_legacy/" : ""}${name}`;

    if (name === "demo") {
      return {
        name,
        testDir,
        use: {
          // Demo Day: se ve más lento a propósito y siempre queda grabado
          // (por si algo falla en vivo, se puede reproducir el video).
          video: "on",
          launchOptions: { slowMo: Number(process.env.DEMO_SLOWMO) || 400 },
        },
      };
    }
    if (name === "e2e_v2") {
      // A velocidad alta: sin slowMo. Video solo de lo que falla, porque el
      // recorrido completo es largo.
      return { name, testDir, use: { video: "retain-on-failure" } };
    }
    return { name, testDir };
  }),
});

module.exports.AREAS = AREAS;
