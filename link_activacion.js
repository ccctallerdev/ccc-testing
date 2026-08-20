/**
 * HELPER LOCAL — imprime el enlace pendiente de un correo leyendo los oobCodes
 * del EMULADOR de Auth. Sirve para las DOS pruebas de la app:
 *
 *   - ACTIVACIÓN (alta por el taller / with-account): oobCode PASSWORD_RESET →
 *     imprime la URL de /acciones-cuenta?mode=activate (crear contraseña +
 *     correo verificado en un paso).
 *   - VERIFICACIÓN (autoregistro en la app): oobCode VERIFY_EMAIL → imprime el
 *     enlace del emulador que verifica el correo al abrirlo.
 *
 *   node link_activacion.js correo@test.com
 *
 * Si no encuentra nada: para activación pide otro con
 *   curl -X POST http://localhost:3001/v1/public/resend-activation \
 *        -H "Content-Type: application/json" -d "{\"email\":\"correo@test.com\"}"
 * y para verificación vuelve a iniciar sesión en la app (o re-regístrate),
 * que es lo que dispara el correo.
 */

const AUTH_EMU = process.env.AUTH_EMU || "http://127.0.0.1:9099";
const PROJECT_ID = process.env.EMU_PROJECT_ID || "ccc-taller-refac";
const FRONT = process.env.FRONT || "http://localhost:3000";

const email = process.argv[2];
if (!email) {
  console.error("Uso: node link_activacion.js correo@test.com");
  process.exit(1);
}

(async () => {
  const res = await fetch(`${AUTH_EMU}/emulator/v1/projects/${PROJECT_ID}/oobCodes`);
  if (!res.ok) {
    console.error(`No pude leer los oobCodes del emulador (${res.status}). ¿Están arriba los emuladores?`);
    process.exit(1);
  }
  const { oobCodes = [] } = await res.json();
  const mios = oobCodes.filter((c) => c.email === String(email).toLowerCase());
  const last = (type) => [...mios].reverse().find((c) => c.requestType === type);

  const reset = last("PASSWORD_RESET");
  const verify = last("VERIFY_EMAIL");

  if (!reset && !verify) {
    console.error(
      `No hay códigos pendientes para ${email}.\n` +
        `- Activación (alta por el taller): pide otra con\n` +
        `    curl -X POST http://localhost:3001/v1/public/resend-activation -H "Content-Type: application/json" -d "{\\"email\\":\\"${email}\\"}"\n` +
        `- Verificación (autoregistro): vuelve a iniciar sesión en la app para que reenvíe el correo.`,
    );
    process.exit(1);
  }

  if (reset) {
    console.log(`\n🔗 ACTIVACIÓN (crear contraseña + verificar correo) para ${email}:\n`);
    console.log(`   ${FRONT}/acciones-cuenta?mode=activate&oobCode=${encodeURIComponent(reset.oobCode)}\n`);
  }
  if (verify) {
    console.log(`\n✉️  VERIFICACIÓN de correo (autoregistro) para ${email}:\n`);
    console.log(`   ${verify.oobLink}\n`);
    console.log("   Ábrelo en el navegador y luego inicia sesión en la app.");
  }
})();
