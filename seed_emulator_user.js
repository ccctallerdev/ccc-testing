/**
 * Crea el usuario de prueba en los EMULADORES (Auth + Firestore) para poder
 * iniciar sesión en la app apuntando a emuladores.
 *
 * Crea:
 *   - Usuario de Auth (emulador):  prueba@ccc.test / prueba123
 *   - users/{uid} en Firestore con rol ADMIN e idWorkshop = "taller-prueba"
 *   - workshops/{idWorkshop} mínimo
 *
 * USO:
 *   1) Ten los emuladores corriendo (firebase emulators:start ...).
 *   2) node seed_emulator_user.js
 *
 * Apunta a los emuladores por variables de entorno (ya seteadas abajo).
 */

// Apuntar firebase-admin a los emuladores ANTES de inicializar.
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";

const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

// ── Config del usuario/taller de prueba ──────────────────────────────────────
const EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const PASSWORD = process.env.SEED_PASSWORD || "prueba123";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
// ─────────────────────────────────────────────────────────────────────────────

initializeApp({ projectId: "ccc-taller-refac" });
const db = getFirestore();
const auth = getAuth();
const now = Date.now();

async function main() {
  console.log(`🌱 Sembrando usuario de prueba en emuladores (Auth ${process.env.FIREBASE_AUTH_EMULATOR_HOST}, Firestore ${process.env.FIRESTORE_EMULATOR_HOST})\n`);

  // 1) Usuario de Auth (emulador)
  let user;
  try {
    user = await auth.createUser({ email: EMAIL, password: PASSWORD, displayName: "Admin Prueba", emailVerified: true });
    console.log(`✅ Usuario de Auth creado: ${EMAIL} (uid ${user.uid})`);
  } catch (e) {
    if (e.code === "auth/email-already-exists") {
      user = await auth.getUserByEmail(EMAIL);
      // Reparar la contraseña al valor esperado por los tests: si alguien la
      // cambió a mano en la app, la seed la regresa a PASSWORD (idempotente).
      await auth.updateUser(user.uid, { password: PASSWORD, emailVerified: true });
      console.log(`↪️  Usuario de Auth ya existía: ${EMAIL} (uid ${user.uid}) — contraseña restablecida a la de la seed`);
    } else {
      throw e;
    }
  }
  const uid = user.uid;

  // 1b) Q20/roles: el backend ahora autoriza por el CUSTOM CLAIM firmado
  // (`role`), no por el campo de Firestore. Sin claim, TODA la API responde
  // 403 y la suite entera truena. ADMIN = Dueño (owner) en el nuevo mapeo.
  await auth.setCustomUserClaims(uid, { role: "ADMIN" });
  console.log(`✅ Custom claim role='ADMIN' (owner) asignado a ${EMAIL}`);

  // 2) Doc de usuario en Firestore (la app carga userData desde aquí).
  //    El campo es `uid` (igual que en la base real), NO `id`.
  await db.collection("users").doc(uid).set(
    {
      uid,
      name: "Admin",
      firstSurname: "Prueba",
      secondSurname: "",
      email: EMAIL,
      rol: "ADMIN",
      idWorkshop: ID_WORKSHOP,
      isActive: true,
      isDeleted: false,
      createdAt: now,
      updatedAt: now,
    },
    { merge: true },
  );
  console.log(`✅ Firestore users/${uid} (rol ADMIN, idWorkshop ${ID_WORKSHOP})`);

  // 2b) Mecánico del taller (el asistente de nueva entrada exige asignar uno).
  await db.collection("users").doc("mecanico-prueba").set(
    {
      uid: "mecanico-prueba",
      name: "Mecánico",
      firstSurname: "Prueba",
      email: "mecanico@ccc.test",
      rol: "MECANICO",
      idWorkshop: ID_WORKSHOP,
      isActive: true,
      isDeleted: false,
      createdAt: now,
      updatedAt: now,
    },
    { merge: true },
  );
  console.log("✅ Firestore users/mecanico-prueba (rol MECANICO)");

  // 3) Taller mínimo
  await db.collection("workshops").doc(ID_WORKSHOP).set(
    { id: ID_WORKSHOP, idWorkshop: ID_WORKSHOP, name: "Taller de Prueba", isDeleted: false, createdAt: now, updatedAt: now },
    { merge: true },
  );
  console.log(`✅ Firestore workshops/${ID_WORKSHOP}`);

  // 4) Suscripción ACTIVA del taller (la app la pide al entrar; sin ella da 404).
  //    Se busca por el campo `idReference` = idWorkshop. trial_end muy futuro → no expira.
  await db.collection("subscriptions").doc(ID_WORKSHOP).set(
    {
      idReference: ID_WORKSHOP,
      subscriptionType: 0, // 0 = Workshop
      max_users: 10,
      plan_name: "Prueba",
      billing_cycle: 1, // 1 = Anual
      price: 0,
      status: 2, // 2 = Active
      isTrial: false,
      trial_end: Math.floor(now / 1000) + 10 * 365 * 24 * 3600, // +10 años (no expira)
      isActive: true,
      isDeleted: false,
      createdAt: now,
      updatedAt: now,
    },
    { merge: true },
  );
  console.log(`✅ Firestore subscriptions (idReference ${ID_WORKSHOP}, activa)\n`);

  console.log("🎉 LISTO. Inicia sesión en la app con:");
  console.log(`   Correo:      ${EMAIL}`);
  console.log(`   Contraseña:  ${PASSWORD}`);
  console.log(`   idWorkshop:  ${ID_WORKSHOP}  (usa este mismo en seed_prueba_e2e.js)\n`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("\n❌ Error:", e.message);
  console.error("¿Están corriendo los emuladores? (firebase emulators:start)");
  process.exit(1);
});
