/**
 * Token del admin de prueba para la API blindada (Q20).
 *
 * Desde feat/roles-setup, TODO /v1 (salvo /public) exige un ID token de
 * Firebase con el custom claim `role` firmado. Este módulo inicia sesión
 * contra el EMULADOR de Auth por REST y cachea el token ~45 min (expira
 * a la hora), para que specs y seeds se identifiquen igual que la app.
 *
 * Lo usan:
 *   - tests/*.spec.js  → require("../apiToken")
 *   - seed_*.js        → require("./apiToken")
 *
 * Requiere Node 18+ (fetch global) y la seed del usuario admin corrida
 * (global-setup lo hace solo).
 */

const AUTH_EMU = process.env.AUTH_EMU || "http://127.0.0.1:9099";
const EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const PASSWORD = process.env.SEED_PASSWORD || "prueba123";

let cached = null;
let cachedAt = 0;

/** idToken del admin semilla (claim role=ADMIN → owner). Cacheado. */
async function getApiToken() {
  if (cached && Date.now() - cachedAt < 45 * 60 * 1000) return cached;
  const res = await fetch(
    `${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `No se pudo obtener el token del emulador de Auth (${res.status}): ${await res.text()}\n` +
        "¿Están arriba los emuladores y corriste node seed_emulator_user.js?",
    );
  }
  cached = (await res.json()).idToken;
  cachedAt = Date.now();
  return cached;
}

/** Headers listos para anexar a cualquier llamada a la API. */
async function authHeaders() {
  return { Authorization: `Bearer ${await getApiToken()}` };
}

module.exports = { getApiToken, authHeaders };
