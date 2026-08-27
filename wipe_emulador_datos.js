/**
 * wipe_emulador_datos.js — Borra clients, entries y cars de los EMULADORES.
 *
 * Para dejar limpio el taller local entre corridas de pruebas sin tumbar los
 * emuladores ni perder usuarios/planes/configuración. Borra los DOCUMENTOS con
 * sus subcolecciones (recursiveDelete: hojas de servicio, cotizaciones y
 * diagnósticos de cada entry se van con ella).
 *
 * SOLO EMULADORES, por construcción: fija FIRESTORE_EMULATOR_HOST antes de
 * inicializar y NO carga ninguna llave de servicio — no hay forma de que le
 * pegue a refac ni a prod. (Para lo acumulado en refac ya existe
 * ccc-backend/functions/scripts/limpiar-taller-pruebas.js, con candado.)
 *
 * USO (emuladores corriendo; dry-run por defecto):
 *   node wipe_emulador_datos.js                         # solo cuenta e informa
 *   node wipe_emulador_datos.js --apply                 # borra
 *   node wipe_emulador_datos.js --taller=taller-prueba --apply   # solo ese taller
 *   node wipe_emulador_datos.js --colecciones=entries --apply    # solo entries
 */

// Apuntar firebase-admin al emulador ANTES de inicializar (mismo patrón que
// seed_emulator_user.js). Sin llave de servicio: solo funciona contra emulador.
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const PROJECT_ID = process.env.EMU_PROJECT_ID || "ccc-taller-refac";
const APPLY = process.argv.includes("--apply");
const arg = (nombre) => {
  const a = process.argv.find((x) => x.startsWith(`--${nombre}=`));
  return a ? a.split("=")[1] : null;
};
const TALLER = arg("taller"); // opcional: limitar a un idWorkshop
const COLECCIONES = (arg("colecciones") || "clients,entries,cars")
  .split(",").map((c) => c.trim()).filter(Boolean);

const PERMITIDAS = new Set(["clients", "entries", "cars", "tokens", "followups", "purchase_orders"]);
for (const c of COLECCIONES) {
  if (!PERMITIDAS.has(c)) {
    console.error(`⛔ Colección "${c}" no permitida. Puedes usar: ${[...PERMITIDAS].join(", ")}`);
    process.exit(1);
  }
}

initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();

async function main() {
  console.log(`🧹 Emulador ${process.env.FIRESTORE_EMULATOR_HOST} · proyecto ${PROJECT_ID}`);
  console.log(`   Colecciones: ${COLECCIONES.join(", ")}${TALLER ? ` · solo taller ${TALLER}` : " · TODOS los talleres"}`);
  console.log(`   Modo: ${APPLY ? "BORRAR" : "dry-run (usa --apply para borrar)"}\n`);

  let total = 0;
  for (const nombre of COLECCIONES) {
    let query = db.collection(nombre);
    if (TALLER) query = query.where("idWorkshop", "==", TALLER);
    const snap = await query.get();
    console.log(`   ${nombre}: ${snap.size} documentos`);
    total += snap.size;

    if (APPLY) {
      for (const doc of snap.docs) {
        // recursiveDelete: se lleva también las subcolecciones (hojas de
        // servicio, cotizaciones, diagnósticos de cada entry).
        await db.recursiveDelete(doc.ref);
      }
    }
  }

  console.log(
    APPLY
      ? `\n✅ Listo: ${total} documentos borrados (con sus subcolecciones).`
      : `\n🔎 DRY-RUN: no se borró nada (${total} documentos se borrarían).`,
  );
  process.exit(0);
}

main().catch((e) => {
  const pista = /ECONNREFUSED|UNAVAILABLE/i.test(String(e.message))
    ? "\n   ¿Están corriendo los emuladores? (firebase emulators:start desde ccc-backend)"
    : "";
  console.error(`Error: ${e.message}${pista}`);
  process.exit(1);
});
