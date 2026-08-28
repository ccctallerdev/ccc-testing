const { test, expect } = require("@playwright/test");
const { db: qaDb, auth: qaAuth, modo } = require("../../adminFlex");
const { headersFor } = require("../../qaAuth");
const { authHeaders } = require("#apiToken");

/**
 * ─────────────────────────────────────────────────────────────────────────
 * PRODUCCIÓN PARA EL MECÁNICO — el listado con su filtro de alcance  @api
 *
 * Punto n16 del BACKLOG_TECNICO. El Mecánico veía "No tienes autos
 * asignados" aunque la OS estuviera aprobada y asignada a él. La consulta
 * respondía 400:
 *
 *     9 FAILED_PRECONDITION: The query requires an index.
 *
 * Cuando quien consulta es un mecánico, el backend le añade el filtro
 * `assigned_mechanic` (correcto: "solo lo suyo"), y eso deja tres igualdades
 * + un orderBy, que Firestore solo resuelve con un índice compuesto que no
 * estaba declarado en ningún lado.
 *
 * ⚠️ LÍMITE IMPORTANTE DE ESTE SPEC:
 * **Los emuladores de Firestore NO exigen índices compuestos.** Corriendo en
 * emuladores este spec prueba la REGLA DE ALCANCE (que el Mecánico recibe
 * solo sus autos y con 200), pero NO puede detectar un índice que falte.
 * Para eso hay que correrlo contra refac o prod:
 *
 *     $env:AUTH_REAL="1"; $env:ID_WORKSHOP="<taller refac>"
 *     npx playwright test --project=qa tests/qa/produccion-mecanico.qa.spec.js
 *
 * Y antes, desplegar los índices (responder N si pregunta si BORRA):
 *     cd ccc-backend
 *     firebase deploy --only firestore:indexes --project ccc-taller-refac
 *     firebase deploy --only firestore:indexes --project ccc-taller
 * ─────────────────────────────────────────────────────────────────────────
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || (modo === "emulador" ? "taller-prueba" : null);
if (!ID_WORKSHOP) {
  throw new Error('Falta ID_WORKSHOP (taller real de refac). Ej: $env:ID_WORKSHOP="05Pf..."');
}

const S = `${String(Date.now()).slice(-7)}`;
const MECANICO = { correo: `mecanico.prod.${S}@ccc.test`, password: "Prueba1234!" };

const creados = { uids: [], entryIds: [] };
let mecanicoUid;
let mecanicoHeaders;

async function call(request, method, path, { body, headers } = {}) {
  const res = await request[method](`${API}${path}`, {
    headers: { ...(headers || (await authHeaders())) },
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json, data: json?.data ?? json };
}

/** OS sembrada por Admin SDK: solo hace falta que exista y esté asignada. */
async function sembrarEntry(asignadoA) {
  const ref = await qaDb().collection("entries").add({
    idWorkshop: ID_WORKSHOP,
    isDeleted: false,
    createdAt: Date.now(),
    status: 1,
    assigned_mechanic: asignadoA,
    approvalState: "APROBADA",
    observations: "seed spec produccion-mecanico",
    seedSpec: "produccion-mecanico",
  });
  creados.entryIds.push(ref.id);
  return ref.id;
}

test.describe.configure({ mode: "serial" });

test.describe("Producción: el listado del Mecánico @api", () => {
  let miEntry;

  test.beforeAll(async () => {
    const user = await qaAuth().createUser({ email: MECANICO.correo, password: MECANICO.password });
    mecanicoUid = user.uid;
    await qaAuth().setCustomUserClaims(mecanicoUid, { role: "MECANICO", idWorkshop: ID_WORKSHOP });
    creados.uids.push(mecanicoUid);
    const ahora = Date.now();
    await qaDb().collection("users").doc(mecanicoUid).set({
      uid: mecanicoUid, name: "Mecánico", firstSurname: "Producción", secondSurname: "",
      email: MECANICO.correo, rol: "MECANICO", idWorkshop: ID_WORKSHOP,
      isActive: true, isDeleted: false, createdAt: ahora, updatedAt: ahora,
    }, { merge: true });
    mecanicoHeaders = await headersFor(MECANICO.correo, MECANICO.password);

    miEntry = await sembrarEntry(mecanicoUid);
    await sembrarEntry("otro-mecanico-que-no-soy-yo");
  });

  test.afterAll(async () => {
    for (const id of creados.entryIds) await qaDb().collection("entries").doc(id).delete().catch(() => {});
    for (const uid of creados.uids) {
      await qaDb().collection("users").doc(uid).delete().catch(() => {});
      await qaAuth().deleteUser(uid).catch(() => {});
    }
  });

  test("el listado responde 200, no 400 por un índice que falta", async ({ request }) => {
    const r = await call(request, "get", `/entries?idWorkshop=${ID_WORKSHOP}&limit=100`, {
      headers: mecanicoHeaders,
    });
    // El síntoma del punto n16 era exactamente esto: 400 FAILED_PRECONDITION.
    expect(
      r.status,
      "400 aquí = falta el índice compuesto assigned_mechanic + idWorkshop + isDeleted + createdAt. " +
        "Desplegar firestore.indexes.json. OJO: los emuladores NO exigen índices, este caso solo " +
        "tiene valor real contra refac o prod.",
    ).toBe(200);
  });

  test("y trae SOLO los autos asignados a ese mecánico", async ({ request }) => {
    const r = await call(request, "get", `/entries?idWorkshop=${ID_WORKSHOP}&limit=100`, {
      headers: mecanicoHeaders,
    });
    const lista = r.data?.entries ?? [];
    const ids = lista.map((e) => e.id);
    expect(ids, "debe ver su propia OS").toContain(miEntry);
    const ajenas = lista.filter(
      (e) => String(e.assigned_mechanic || "") !== mecanicoUid,
    );
    expect(ajenas, "el mecánico no debe ver autos de otros").toHaveLength(0);
  });
});
