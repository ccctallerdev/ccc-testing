/**
 * Semilla de DEMO para los fixes de la rama fix/bugs-fixes-general.
 * Crea en los EMULADORES todo lo necesario para verificar visualmente:
 *
 *   #3   Citas de agenda de DOS asesores distintos (colores diferentes)
 *   #10  Dos entradas registradas por asesores distintos (círculo de color)
 *   #13  Hoja de servicio con "Llave" y "Birlo de seguridad" (en rojo)
 *   #27  Combustible del auto visible en el expediente
 *   #30  Cotización con precios → Total en grande arriba (y folio Q4: OS-01)
 *   #33  Varias OS para probar el filtro por No. OS / placas en Servicios
 *   #35  Mecánicos: uno con rol "Mecanico" (minúsculas) que SÍ debe aparecer,
 *        uno borrado que NO debe aparecer, y ninguno con "undefined"
 *   §4   OS con costeo a medias (fila llena sin buscador, fila vacía con él)
 *
 * USO:
 *   1) Emuladores:  cd ccc-backend && npm run serve
 *   2) Backend:     cd ccc-backend && npm run backend
 *   3) node seed_fixes_demo.js
 *
 * Requiere Node 18+. Los usuarios se crean con firebase-admin (emulador).
 */

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";

const { initializeApp } = require("firebase-admin/app");
const { authHeaders } = require("./apiToken");
const { getFirestore } = require("firebase-admin/firestore");

const API = process.env.API || "http://localhost:3001/v1";
const AGENDA_API = process.env.AGENDA_API || "http://localhost:3001/agenda";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";

initializeApp({ projectId: "ccc-taller-refac" });
const db = getFirestore();
const now = Date.now();
const suffix = String(now).slice(-5);

// Dos asesores ficticios (solo id+nombre; el color sale del hash del id)
const ASESOR_A = { id: "asesor-ana", name: "Ana Torres" };
const ASESOR_B = { id: "asesor-beto", name: "Beto Ramírez" };

async function post(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) }, // Q20: API blindada
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok) {
    const detail = json ? JSON.stringify(json.errors ?? json.descripcion ?? json) : res.statusText;
    throw new Error(`POST ${path} → ${res.status}: ${detail}`);
  }
  return json?.data ?? json;
}

const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

/** Crea cliente + auto + entrada (con asesor) + hoja con llave/birlo. */
async function createOsFor(asesor, carModel, plates, withQuote) {
  const client = await post(API, "/clients", {
    fullName: `Cliente de ${asesor.name} ${suffix}`,
    email: `demo.${asesor.id}.${suffix}@test.com`,
    phone: `55${suffix}${Math.floor(Math.random() * 90 + 10)}`,
    idWorkshop: ID_WORKSHOP,
    createdBy: asesor.id,
  });
  const clientId = idOf(client);
  await post(API, "/tokens", { idWorkshop: ID_WORKSHOP, idClient: clientId });

  const car = await post(API, "/cars", {
    clientId,
    brand: "Nissan",
    model: carModel,
    year: 2019,
    vin: `DEMO${suffix}${plates}0000000`.slice(0, 17),
    codeCar: plates,
    color: "Gris",
    fuel: "Gasolina", // #27: debe verse en el expediente
    transmition: "Automatica",
    km: 87500,
  });
  const carId = idOf(car);

  const entry = await post(API, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId,
    carId,
    assigned_mechanic: "mecanico-prueba",
    status: 1,
    observations: `Demo fixes — registrada por ${asesor.name}`,
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
    createdBy: asesor.id,        // #10: círculo de color
    createdByName: asesor.name,
  });
  const entryId = idOf(entry);
  const os = entry?.sheet;

  // #13: hoja con Llave y Birlo (rojos) + otros ítems normales
  await post(API, `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos", "Llave", "Birlo de seguridad", "Tapetes", "Gato"],
    checks: ["Servicio de Frenos"],
    isCheckAll: false,
    observations: "Hoja de demo (llave y birlo deben verse en rojo).",
    km: 87500,
    fuel_tank: "3/4",
  });

  // Diagnóstico (necesario para llegar al Costeo y ver el flujo completo)
  await post(API, `/entries/${entryId}/diagnostics`, {
    idMechanic: "mecanico-prueba",
    generalObservations: "Diagnóstico de demo para el flujo de fixes.",
    findings: [
      { id: "d-rojo", system: "Frenos", component: "Balatas delanteras", finding: "Balatas al límite.", severity: "ROJO", recommendation: "Reemplazo inmediato.", commercialDescription: "Sus frenos están al límite.", consequence: "Riesgo de no frenar a tiempo." },
      { id: "d-verde", system: "Motor", component: "Filtro de aire", finding: "Polvo ligero.", severity: "VERDE", recommendation: "Cambiar en el próximo servicio.", commercialDescription: "Filtro con desgaste leve.", consequence: "Menor eficiencia." },
    ],
  });

  if (withQuote) {
    // Costeo (borrador, sin folio) + cotización con precios (folio OS-01,
    // total en grande #30). El costeo deja una fila llena y una vacía (§4).
    await post(API, `/entries/${entryId}/quotes`, {
      diagnostic: "Costeo de demo (sin precios; no genera folio)",
      labor: [{ description: "Trabajo por cotizar", count: 1, cost: "", subtotal: 0 }],
      parts: [{ description: "Refacción capturada (fila llena, sin buscador)", count: 1, cost: "", subtotal: 0 }],
      status: 2,
      stage: "COSTEO",
    });
    await post(API, `/entries/${entryId}/quotes`, {
      diagnostic: "Cotización de demo (folio OS-01, total en grande)",
      labor: [{ description: "Mano de obra", count: 2, cost: 450, subtotal: 900 }],
      parts: [{ description: "Balatas delanteras", count: 1, cost: 850, subtotal: 850 }],
      status: 2,
      stage: "COTIZACION",
    });
  }

  console.log(`✅ OS ${os} (${carModel}, placas ${plates}) — asesor ${asesor.name}${withQuote ? " · costeo + cotización $1,750" : ""}`);
  return { entryId, os };
}

/** #3: cita de agenda a nombre de un asesor, a N días de hoy a las 11:00. */
async function createEvent(asesor, daysFromNow, title) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(11, 0, 0, 0);
  await post(AGENDA_API, "/addevent", {
    idWorkshop: ID_WORKSHOP,
    title,
    description: "cita de demo",
    phone: "5512345678",
    start: d,
    end: d,
    allDay: false,
    createdBy: asesor.id,
    createdByName: asesor.name,
  });
  console.log(`✅ Cita "${title}" — ${asesor.name} (${d.toLocaleDateString("es-MX")})`);
}

/** #35: mecánicos con rol en minúsculas y uno borrado. */
async function seedMechanics() {
  const mechs = [
    { id: `mec-demo-a-${suffix}`, name: "Carlos", firstSurname: "Domínguez", rol: "MECANICO", isDeleted: false },
    // rol en formato viejo (minúsculas/mixto): DEBE aparecer en el dropdown
    { id: `mec-demo-b-${suffix}`, name: "Luisa", firstSurname: "", rol: "Mecanico", isDeleted: false },
    // borrado: NO debe aparecer
    { id: `mec-demo-x-${suffix}`, name: "Fantasma", firstSurname: "Borrado", rol: "MECANICO", isDeleted: true },
  ];
  for (const m of mechs) {
    await db.collection("users").doc(m.id).set({
      uid: m.id,
      name: m.name,
      firstSurname: m.firstSurname,
      // sin secondSurname a propósito: el nombre NO debe mostrar "undefined"
      email: `${m.id}@test.com`,
      rol: m.rol,
      idWorkshop: ID_WORKSHOP,
      isActive: true,
      isDeleted: m.isDeleted,
      createdAt: now,
      updatedAt: now,
    });
  }
  console.log("✅ Mecánicos demo: Carlos (MECANICO), Luisa (rol 'Mecanico'), Fantasma (borrado)");
}

async function main() {
  console.log(`🌱 Demo de fixes en ${API} · taller ${ID_WORKSHOP}\n`);

  await seedMechanics();

  await createEvent(ASESOR_A, 1, `Afinación — cita de ${ASESOR_A.name}`);
  await createEvent(ASESOR_A, 2, `Frenos — cita de ${ASESOR_A.name}`);
  await createEvent(ASESOR_B, 1, `Suspensión — cita de ${ASESOR_B.name}`);

  await createOsFor(ASESOR_A, "Versa", `ANA-${suffix}`, true);
  await createOsFor(ASESOR_B, "March", `BET-${suffix}`, false);

  console.log(`
🎉 LISTO. Checklist visual (con REACT_APP_USE_EMULATORS=true):
   1. AGENDA:    las citas de Ana y Beto tienen colores distintos (#3).
   2. ENTRADAS:  cada OS lleva un círculo del color de su asesor; hover
                 muestra el nombre (#10).
   3. SERVICIOS: usa el buscador "No. OS o placas" con ANA-${suffix} (#33).
                 (la OS debe estar APROBADA para aparecer en Servicios)
   4. COTIZACIÓN de la OS del Versa: badge con folio OS-01, Total $1,750.00
                 en grande arriba (#30/Q4); el costeo aparece sin folio.
   5. COSTEO:    la fila capturada no muestra buscador de inventario; una
                 fila nueva sí (§4).
   6. HOJA/EXPEDIENTE: "Llave" y "Birlo de seguridad" en rojo (#13);
                 Combustible = Gasolina en el expediente (#27).
   7. HOJA DE SERVICIO → selector de mecánico: aparecen Carlos y Luisa
                 (sin "undefined"), NO aparece "Fantasma" (#35).
   8. EVIDENCIAS: sube una foto en el expediente → tu nombre sobre la
                 miniatura (#14).
`);
}

main().catch((e) => {
  console.error("\n❌ Error:", e.message);
  process.exit(1);
});
