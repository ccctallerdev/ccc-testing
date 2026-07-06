// @ts-check
const { defineConfig } = require("@playwright/test");

/**
 * Playwright para pruebas E2E de CCC.
 * Usa el navegador Edge YA INSTALADO (channel: "msedge") — no descarga Chromium.
 * Apunta al frontend local (localhost:3000). Correr con: npx playwright test
 */
module.exports = defineConfig({
  testDir: "./tests",
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
});
