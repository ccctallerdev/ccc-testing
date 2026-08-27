/**
 * Inicio de sesión REAL contra Firebase Auth, para specs que corren contra
 * refac (QA) o producción — NO contra el emulador.
 *
 * ¿Por qué existe además de apiToken.js? Porque `apiToken.js` habla solo con
 * el emulador (`127.0.0.1:9099`) y siempre con el MISMO usuario semilla. Aquí
 * necesitamos dos cosas que ese no da:
 *   1) autenticarnos contra el Firebase real de refac, y
 *   2) hacerlo con VARIOS usuarios distintos (uno por rol), para que cada
 *      llamada a la API vaya firmada por el rol que de verdad debe hacerla.
 *
 * La API key de Firebase para web es PÚBLICA por diseño (viaja en el bundle
 * que se sirve a cualquier visitante), pero como en este repo los .env están
 * en .gitignore, aquí NO se hardcodea: se toma de la variable de entorno
 * FIREBASE_API_KEY y, si no está, se lee de ccc-frontend/.env
 * (REACT_APP_FIREBASE_APIKEY), que es donde ya vive.
 *
 * Si defines AUTH_EMU, apunta al emulador (útil para reusar estos specs en
 * local sin cambiar nada más).
 */

const fs = require("fs");
const path = require("path");

/**
 * OJO: se lee en CADA llamada, no al cargar el módulo. apiToken.js decide si
 * toca emulador o Firebase real y ajusta AUTH_EMU DESPUÉS de importar esto;
 * si lo capturáramos aquí arriba, ese ajuste llegaría tarde y los specs
 * locales acabarían pegándole al Firebase real.
 */
const authEmu = () => process.env.AUTH_EMU || null;

/** Lee REACT_APP_FIREBASE_APIKEY del .env de ccc-frontend (repos hermanos). */
function apiKeyDesdeFrontend() {
  const candidatos = [
    path.join(__dirname, "..", "ccc-frontend", ".env"),
    path.join(__dirname, "..", "ccc-frontend", ".env.local"),
  ];
  for (const ruta of candidatos) {
    try {
      const texto = fs.readFileSync(ruta, "utf8");
      const m = texto.match(/^\s*REACT_APP_FIREBASE_APIKEY\s*=\s*"?([^"\r\n]+)"?/m);
      if (m) return m[1].trim();
    } catch {
      // el archivo no existe o no se puede leer: probamos el siguiente
    }
  }
  return null;
}

function resolverApiKey() {
  if (authEmu()) return "fake"; // el emulador ignora la key
  const key = process.env.FIREBASE_API_KEY || apiKeyDesdeFrontend();
  if (!key) {
    throw new Error(
      "Falta la API key de Firebase. Define FIREBASE_API_KEY, o deja que se " +
        "lea sola de ccc-frontend/.env (REACT_APP_FIREBASE_APIKEY). " +
        "La encuentras en la consola de Firebase > Configuración del proyecto > Tus apps (web).",
    );
  }
  return key;
}

function urlBase() {
  const emu = authEmu();
  return emu
    ? `${emu}/identitytoolkit.googleapis.com/v1`
    : "https://identitytoolkit.googleapis.com/v1";
}

// Cache por correo: los idToken duran 1 hora, los reusamos 45 min.
const cache = new Map();

/** idToken de Firebase para ese correo/contraseña. Cacheado por usuario. */
async function signIn(email, password) {
  const enCache = cache.get(email);
  if (enCache && Date.now() - enCache.at < 45 * 60 * 1000) return enCache.token;

  const res = await fetch(
    `${urlBase()}/accounts:signInWithPassword?key=${resolverApiKey()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `No se pudo iniciar sesión como ${email} (${res.status}): ${await res.text()}`,
    );
  }
  const { idToken } = await res.json();
  cache.set(email, { token: idToken, at: Date.now() });
  return idToken;
}

/** Headers Authorization listos para la API, firmados por ESE usuario. */
async function headersFor(email, password) {
  return { Authorization: `Bearer ${await signIn(email, password)}` };
}

/**
 * Claims del idToken (lo decodifica sin verificar firma: solo sirve para
 * asertar en pruebas que el backend firmó el `role` correcto).
 */
function claimsOf(idToken) {
  const payload = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
}

/** Olvida el token cacheado de un usuario (o de todos si no se pasa correo). */
function forget(email) {
  if (email) cache.delete(email);
  else cache.clear();
}

module.exports = { signIn, headersFor, claimsOf, forget, apiKeyPublica: resolverApiKey };
