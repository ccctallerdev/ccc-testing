/**
 * Global setup de Playwright: siembra lo mínimo ANTES de correr la suite,
 * para que `npm test` funcione en un emulador recién limpiado sin correr
 * semillas a mano.
 *
 *   1) seed_emulator_user.js — usuario de login + taller + suscripción +
 *      mecánico (necesita los EMULADORES arriba).
 *   2) seed_prueba_e2e.js — Nissan Versa con diagnóstico, que usa
 *      flujo-costeo.spec.js (necesita la API en :3001).
 *
 * Ambas semillas son idempotentes/aditivas: correr la suite varias veces
 * no rompe nada.
 */
const { execSync } = require("child_process");

module.exports = async () => {
  console.log("\n🌱 Global setup: sembrando datos base…");
  try {
    execSync("node seed_emulator_user.js", { stdio: "inherit", cwd: __dirname });
    execSync("node seed_prueba_e2e.js", { stdio: "inherit", cwd: __dirname });
    console.log("🌱 Global setup listo.\n");
  } catch (e) {
    console.error(
      "\n❌ Global setup falló. Verifica que estén corriendo:\n" +
        "   1) Emuladores:  cd ccc-backend && npm run serve\n" +
        "   2) Backend:     cd ccc-backend && npm run backend\n",
    );
    throw e;
  }
};
