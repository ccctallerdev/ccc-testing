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
 *
 * Tres atajos que evitan fricción al correr por carpetas:
 *   · Si solo se pidió el proyecto `publico`, NO siembra: el sitio público es
 *     anónimo y no toca la base, así que basta el frontend en :3000.
 *   · Si se exporta SKIP_SEED=1, NO siembra — para cuando `demo` corre contra
 *     PRODUCCIÓN (BASE_URL/API apuntando a controlcentralcar.com) y no hay
 *     emuladores locales levantados. Las semillas SIEMPRE apuntan a
 *     127.0.0.1 así que nunca tocarían prod por sí solas, pero sin
 *     emuladores arriba tronarían con ECONNREFUSED antes de llegar al test.
 *   · Avisa si hay specs sueltos en tests/, porque esos no pertenecen a
 *     ningún project y pasarían desapercibidos sin ejecutarse nunca.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

module.exports = async () => {
  const sueltos = fs
    .readdirSync(path.join(__dirname, "tests"))
    .filter((f) => f.endsWith(".spec.js"));
  if (sueltos.length) {
    console.warn(
      "\n⚠️  Specs sueltos en tests/ — NINGÚN proyecto los ejecuta:\n   " +
        sueltos.join("\n   ") +
        "\n   Muévelos a una carpeta de área (ver tests/README.md).\n",
    );
  }

  // OJO: Playwright NO filtra `config.projects` aquí — siempre llegan TODOS los
  // proyectos, se haya pedido uno o la suite entera. La única forma fiable de
  // saber qué se pidió es leer los argumentos. (Se probó: con --project=publico
  // config.projects seguía trayendo los siete.)
  const pedidos = [];
  process.argv.forEach((a, i) => {
    if (a.startsWith("--project=")) pedidos.push(a.slice("--project=".length));
    else if (a === "--project" && process.argv[i + 1]) pedidos.push(process.argv[i + 1]);
  });
  if (pedidos.length > 0 && pedidos.every((n) => n === "publico")) {
    console.log("\n🌱 Solo el sitio público: no hacen falta semillas.\n");
    return;
  }
  if (process.env.SKIP_SEED === "1") {
    console.log("\n🌱 SKIP_SEED=1: no se siembra (útil corriendo `demo` contra producción).\n");
    return;
  }

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
