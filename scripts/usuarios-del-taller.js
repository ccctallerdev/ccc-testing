/**
 * usuarios-del-taller.js — SOLO LECTURA. Dice quién es quién en un taller.
 *
 * Nació el 14-sep porque adivinar el correo del Dueño para correr un spec
 * costó tres corridas fallidas: los defaults del repo apuntan a cuentas que ya
 * no existen (`rsv.cup@gmail.com`, `prueba@ccc.test`) y los docs mezclan
 * `@gmail` con `@outlook`. Esto lo pregunta en vez de adivinarlo.
 *
 * NO escribe nada: un `.get()` sobre `users` y otro sobre `clients`.
 * No imprime contraseñas — no viven en la base, viven en Auth y no se leen.
 *
 * CORRER (desde ccc-testing):
 *   $env:AUTH_REAL="1"
 *   node scripts/usuarios-del-taller.js G85FhlhedkD4L4CEDWvW
 *
 * Sin argumento usa ID_WORKSHOP. Requiere el serviceAccountKey de refac
 * (el mismo que usa qaAdmin.js).
 */
process.env.AUTH_REAL = process.env.AUTH_REAL || "1";

const { db, modo } = require("../adminFlex");

const ID_WORKSHOP = process.argv[2] || process.env.ID_WORKSHOP;
if (!ID_WORKSHOP) {
  console.error('Falta el taller. Uso: node scripts/usuarios-del-taller.js <idWorkshop>');
  process.exit(1);
}

// Orden de la matriz de roles, no alfabético: se lee de arriba abajo igual que
// el organigrama. BL-14 (17-sep-2026): la trampa se corrigió — SUPER_ADMIN
// es el Dueño y ADMIN el Administrador, como cualquiera supondría.
const ORDEN = ["SUPER_ADMIN", "ADMIN", "ASESOR", "MECANICO", "COMPRAS", "TECH_SUPPORT"];
const ALIAS = {
  SUPER_ADMIN: "Dueño",
  ADMIN: "Administrador",
  ASESOR: "Asesor",
  MECANICO: "Mecánico",
  COMPRAS: "Compras",
  TECH_SUPPORT: "Soporte",
};

(async () => {
  console.log(`\nTaller ${ID_WORKSHOP} · modo: ${modo}\n`);

  const taller = await db().collection("workshops").doc(ID_WORKSHOP).get();
  if (!taller.exists) {
    console.log("⚠️  Ese taller NO existe en este proyecto. ¿Es el id correcto, o estás en el proyecto equivocado?\n");
  } else {
    const w = taller.data();
    console.log(`Nombre: ${w.name || "(sin nombre)"}${w.isDeleted ? "  ⚠️ DADO DE BAJA" : ""}\n`);
  }

  const snap = await db()
    .collection("users")
    .where("idWorkshop", "==", ID_WORKSHOP)
    .where("isDeleted", "==", false)
    .get();

  if (snap.empty) {
    console.log("No hay usuarios activos en este taller.\n");
    return;
  }

  const users = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  users.sort((a, b) => {
    const ia = ORDEN.indexOf(a.rol), ib = ORDEN.indexOf(b.rol);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  console.log(`${users.length} usuario(s):\n`);
  for (const u of users) {
    const etiqueta = ALIAS[u.rol] ? `${u.rol} (${ALIAS[u.rol]})` : u.rol || "(sin rol)";
    const inactivo = u.isActive === false ? "  ⚠️ INACTIVO" : "";
    console.log(`  ${etiqueta.padEnd(28)} ${u.email}${inactivo}`);
    console.log(`  ${"".padEnd(28)} uid: ${u.uid}`);
  }

  console.log("\nPara un spec de API necesitas el correo de un rol NO acotado");
  console.log("(Dueño o Administrador): el Mecánico solo ve SUS autos asignados,");
  console.log("así que con su token no se reproducen las consultas del taller completo.\n");
  console.log("Las contraseñas no están aquí: viven en Firebase Auth y no se leen.\n");
})().catch((err) => {
  console.error("\nERROR:", err.message);
  if (/UNAVAILABLE|proxy|ENOTFOUND/i.test(err.message)) {
    console.error("Parece red: esto necesita salida a firestore.googleapis.com.\n");
  }
  process.exit(1);
});
