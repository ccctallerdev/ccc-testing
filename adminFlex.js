/**
 * adminFlex.js — Admin SDK que decide solo entre EMULADORES y refac, con la
 * MISMA regla que apiToken.js:
 *
 *   · `API` apunta a localhost/127.0.0.1 (o ya hay FIRESTORE_EMULATOR_HOST)
 *       → EMULADORES: sin llave de servicio, y deja puestos
 *         FIRESTORE/FIREBASE_AUTH_EMULATOR_HOST y AUTH_EMU para que
 *         qaAuth.headersFor() también firme contra el emulador.
 *   · Cualquier otra cosa → REFAC vía qaAdmin (serviceAccountKey).
 *   · AUTH_REAL=1 fuerza refac aunque la API sea local.
 *
 * ¿Por qué no usar qaAdmin siempre? Porque qaAdmin borra
 * FIRESTORE_EMULATOR_HOST a propósito (sus gemelos son refac-only). Los specs
 * que deben correr en AMBOS mundos (p.ej. los del límite de órdenes) importan
 * de aquí en lugar de qaAdmin.
 */
const API = process.env.API || "http://localhost:3001/v1";
const esEmulador =
  process.env.AUTH_REAL !== "1" &&
  (Boolean(process.env.FIRESTORE_EMULATOR_HOST) || /localhost|127\.0\.0\.1/.test(API));

let db, auth, projectId;
const modo = esEmulador ? "emulador" : "refac";

if (esEmulador) {
  // ANTES de inicializar, como en seed_emulator_user.js.
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
  // qaAuth lee AUTH_EMU en cada llamada: con esto headersFor() firma en el emulador.
  process.env.AUTH_EMU = process.env.AUTH_EMU || "http://127.0.0.1:9099";

  const { initializeApp, getApps } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const { getAuth } = require("firebase-admin/auth");

  projectId = process.env.EMU_PROJECT_ID || "ccc-taller-refac"; // singleProjectMode
  const app = getApps().length ? getApps()[0] : initializeApp({ projectId });
  const _db = getFirestore(app);
  const _auth = getAuth(app);
  db = () => _db;
  auth = () => _auth;
} else {
  const qaAdmin = require("./qaAdmin");
  db = qaAdmin.db;
  auth = qaAdmin.auth;
  projectId = null; // qaAdmin.projectId() lo resuelve al primer uso
}

module.exports = { db, auth, modo, esEmulador };
