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
 *   $env:SEED_EMAIL='rsv_gpa@outlook.com'; $env:SEED_PASSWORD='admin123'
 *   $env:SKIP_SEED="1"
 *   npm run test:comercial     (o el área que quieras)
 *
 * ⚠️ SEED_EMAIL es PERSONAL DEL TALLER (Dueño/Admin), no un cliente de la app.
 *   Son cuentas distintas: un correo puede existir como cliente y no servir
 *   aquí. Vigentes en refac (14-sep): Dueño `rsv_gpa@outlook.com`, Mecánico
 *   `rsv_gpa+mecanico1@outlook.com` — **@outlook, no @gmail**.
 *   El ejemplo anterior (`rsv.cup@gmail.com` / `admin123`) quedó aquí meses
 *   después de dejar de servir y costó tres corridas el 14-sep: esa cuenta es
 *   el CLIENTE del recorrido e2e, no personal de taller.
 *   ¿No sabes cuál usar? `node scripts/usuarios-del-taller.js <idWorkshop>`
 *   los lista con su rol (solo lectura).
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

// Los defaults son los del EMULADOR: `seed_emulator_user.js` crea exactamente
// esta cuenta. Contra refac no existen, y ese es el punto del aviso de abajo.
const EMAIL_EMULADOR = "prueba@ccc.test";
const PASSWORD_EMULADOR = "prueba123";
const EMAIL = process.env.SEED_EMAIL || EMAIL_EMULADOR;
const PASSWORD = process.env.SEED_PASSWORD || PASSWORD_EMULADOR;
const SIN_CREDENCIALES = !process.env.SEED_EMAIL && !process.env.SEED_PASSWORD;

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
    // Tres causas muy distintas, y antes las tres decían lo mismo. La de en
    // medio es la que costaba caro: sin SEED_EMAIL el intento se hace con la
    // cuenta del EMULADOR contra Firebase real, y el INVALID_LOGIN_CREDENTIALS
    // resultante se lee como "la prueba está rota" en vez de "falta configurar".
    let pista;
    if (usarEmulador) {
      pista = "¿Están arriba los emuladores y corriste node seed_emulator_user.js?";
    } else if (SIN_CREDENCIALES) {
      pista =
        `NO definiste SEED_EMAIL / SEED_PASSWORD, así que se intentó con la cuenta del
` +
        `EMULADOR (${EMAIL_EMULADOR}), que en Firebase real NO existe.
` +
        `Define una cuenta de PERSONAL del taller (Dueño o Admin), no de cliente:
` +
        `  $env:SEED_EMAIL='rsv_gpa@outlook.com'; $env:SEED_PASSWORD='...'
` +
        `Si no sabes cuál va: node scripts/usuarios-del-taller.js <idWorkshop>`;
    } else {
      pista =
        `¿Existe ${EMAIL} en el proyecto y la contraseña es la correcta?
` +
        `Recuerda que SEED_EMAIL es PERSONAL del taller (Dueño/Admin): una cuenta de
` +
        `CLIENTE de la app existe pero no autentica aquí.
` +
        `Para ver los del taller: node scripts/usuarios-del-taller.js <idWorkshop>`;
    }
    throw new Error(`No se pudo obtener el token de ${donde}: ${err.message}\n${pista}`);
  }
}

/** Headers listos para anexar a cualquier llamada a la API. */
async function authHeaders() {
  return { Authorization: `Bearer ${await getApiToken()}` };
}

module.exports = { getApiToken, authHeaders };
