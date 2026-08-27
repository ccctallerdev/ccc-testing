/**
 * Acceso de ADMIN a refac (QA) para los specs de `tests/qa/`.
 *
 * ¿Por qué existe? Varios specs de la suite original hacen dos cosas que
 * solo funcionan contra emuladores:
 *
 *   1. Escriben directo en Firestore para sembrar situaciones difíciles de
 *      montar por API (un cliente afiliado a DOS talleres, un `clients`
 *      apuntando a la cuenta de otra persona, etc.). Contra emuladores basta
 *      `FIRESTORE_EMULATOR_HOST`; contra refac hacen falta credenciales, y
 *      sin ellas el SDK se queda buscando el metadata de GCE y avisa con
 *      "MetadataLookupWarning: All promises were rejected".
 *
 *   2. Leen el `oobCode` del correo de activación desde la API REST del
 *      emulador de Auth (`/emulator/v1/.../oobCodes`). Ese endpoint no
 *      existe en Firebase real.
 *
 * Aquí se resuelven las dos: se inicializa `firebase-admin` con el
 * serviceAccountKey de refac, y el `oobCode` se GENERA con el Admin SDK
 * (`generatePasswordResetLink`) en vez de leerlo de un buzón.
 *
 * ⚠️ MATIZ DE FIDELIDAD (importante al leer un fallo): el código que genera
 * este helper NO es el que el backend mandó por Brevo — es uno nuevo,
 * equivalente. Se prueba que la activación funciona, no que el correo del
 * backend traiga el enlace correcto. Eso último solo se puede comprobar
 * abriendo el correo a mano (o con el spec original contra emuladores).
 *
 * ⚠️ ESTE HELPER TIENE PODERES DE ADMIN sobre refac. No lo uses en specs que
 * corran contra producción.
 */

const path = require("path");

const RUTA_LLAVE =
  process.env.SERVICE_ACCOUNT_KEY ||
  path.join(__dirname, "..", "ccc-backend", "functions", "serviceAccountKey.json");

let cache = null;

/** Inicializa (una sola vez) firebase-admin apuntando a refac. */
function admin() {
  if (cache) return cache;

  const { initializeApp, cert, getApps } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const { getAuth } = require("firebase-admin/auth");

  let credencial;
  try {
    credencial = require(RUTA_LLAVE);
  } catch {
    throw new Error(
      `No encontré el serviceAccountKey en ${RUTA_LLAVE}.\n` +
        "Pásalo con SERVICE_ACCOUNT_KEY=/ruta/al/serviceAccountKey.json, o corre estos " +
        "specs solo cuando tengas el de refac en ccc-backend/functions/.",
    );
  }

  // Si algo dejó puesto el emulador, lo quitamos: aquí queremos el Firestore real.
  delete process.env.FIRESTORE_EMULATOR_HOST;

  const app = getApps().length
    ? getApps()[0]
    : initializeApp({ credential: cert(credencial), projectId: credencial.project_id });

  cache = { app, db: getFirestore(app), auth: getAuth(app), projectId: credencial.project_id };
  return cache;
}

const db = () => admin().db;
const auth = () => admin().auth;
const projectId = () => admin().projectId;

/**
 * `oobCode` de restablecimiento para ese correo — el equivalente en Firebase
 * real de leerlo del emulador. Es el mismo tipo de código que usa el enlace
 * de "Activa tu cuenta" (PASSWORD_RESET), así que sirve para completar la
 * activación desde un test.
 */
async function oobCodeFor(email) {
  const enlace = await auth().generatePasswordResetLink(email);
  const code = new URL(enlace).searchParams.get("oobCode");
  if (!code) throw new Error(`No pude extraer el oobCode del enlace generado para ${email}`);
  return code;
}

/**
 * Activa una cuenta como lo haría el cliente desde el correo: fija su
 * contraseña con el oobCode y, de paso, deja el correo verificado.
 */
async function activarCuenta(email, password) {
  const code = await oobCodeFor(email);
  const key =
    process.env.FIREBASE_API_KEY || require("./qaAuth").apiKeyPublica?.() || null;

  // La confirmación del reset va por REST (no hay equivalente en el Admin
  // SDK); si no hay API key a la mano, se hace el atajo por Admin.
  if (key) {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oobCode: code, newPassword: password }),
      },
    );
    if (res.ok) return { via: "oobCode" };
  }

  const user = await auth().getUserByEmail(email);
  await auth().updateUser(user.uid, { password, emailVerified: true });
  return { via: "admin" };
}

module.exports = { admin, db, auth, projectId, oobCodeFor, activarCuenta, RUTA_LLAVE };
