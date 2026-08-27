/**
 * Token del usuario de pruebas para la API blindada (Q20).
 *
 * TODO /v1 (salvo /public) exige un ID token de Firebase con el custom claim
 * `role` firmado. Este módulo inicia sesión y cachea el token ~45 min, para
 * que specs y seeds se identifiquen igual que la app.
 *
 * ── CONTRA QUÉ FIREBASE (26-ago) ──────────────────────────────────────────
 * Antes hablaba SIEMPRE con el emulador, y por eso los ~38 specs de UI no se
 * podían correr contra refac. Ahora decide solo:
 *
 *   · `API` apunta a localhost/127.0.0.1  →  EMULADOR (comportamiento de
 *     siempre; correr en local no cambia en nada).
 *   · `API` apunta a cualquier otra cosa  →  FIREBASE REAL, con la API key
 *     web (ver qaAuth.js: la toma de FIREBASE_API_KEY o del .env de
 *     ccc-frontend).
 *
 * Se puede forzar cualquiera de los dos: AUTH_EMU="http://127.0.0.1:9099"
 * fuerza el emulador, AUTH_REAL=1 fuerza el Firebase real.
 *
 * Para correr un spec de UI contra refac:
 *   $env:BASE_URL="https://ccc-frontend-qa.vercel.app"
 *   $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"
 *   $env:SEED_EMAIL="rsv.cup@gmail.com"; $env:SEED_PASSWORD="admin123"
 *   $env:SKIP_SEED="1"
 *   npm run test:comercial     (o el área que quieras)
 *
 * OJO: que la autenticación funcione no garantiza que el spec pase. Varios
 * asumen datos de la semilla local (`taller-prueba`, placas concretas, etc.);
 * esos hay que ajustarlos o correrlos solo en local.
 *
 * Lo usan:
 *   - los specs → require("#apiToken")   ← alias nativo de Node, declarado en
 *     el campo "imports" de package.json.
 *   - los seed_*.js → require("./apiToken")
 *
 * Requiere Node 18+ (fetch global).
 */

const { signIn } = require("./qaAuth");

const API = process.env.API || "http://localhost:3001/v1";
const EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const PASSWORD = process.env.SEED_PASSWORD || "prueba123";

const apiEsLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(API);
const usarEmulador =
  process.env.AUTH_REAL === "1" ? false : Boolean(process.env.AUTH_EMU) || apiEsLocal;

// qaAuth decide por AUTH_EMU; si toca emulador y nadie lo definió, lo ponemos
// nosotros con el default de siempre para no cambiar el comportamiento local.
if (usarEmulador && !process.env.AUTH_EMU) {
  process.env.AUTH_EMU = "http://127.0.0.1:9099";
}
if (!usarEmulador && process.env.AUTH_REAL === "1") {
  delete process.env.AUTH_EMU;
}

/** idToken del usuario de pruebas (claim role=ADMIN → owner). Cacheado. */
async function getApiToken() {
  try {
    return await signIn(EMAIL, PASSWORD);
  } catch (err) {
    const donde = usarEmulador ? "el emulador de Auth" : "Firebase";
    const pista = usarEmulador
      ? "¿Están arriba los emuladores y corriste node seed_emulator_user.js?"
      : `¿Existe ${EMAIL} en el proyecto y la contraseña es la correcta?`;
    throw new Error(`No se pudo obtener el token de ${donde}: ${err.message}\n${pista}`);
  }
}

/** Headers listos para anexar a cualquier llamada a la API. */
async function authHeaders() {
  return { Authorization: `Bearer ${await getApiToken()}` };
}

module.exports = { getApiToken, authHeaders };
