const { test, expect } = require("@playwright/test");
const { modo } = require("../../adminFlex");
const { authHeaders } = require("#apiToken");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OBS31-02 / OBS31-11 — Los "no aprobados" nunca salen del conteo del
 * Centro de Control (26 vs 20)  @api
 * SPEC DE REPRODUCCIÓN (nuevo): primero firma el problema, luego valida
 * la entrega formal como arreglo de fondo.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lo que reportó Roberto (31-ago): el CC marca 26 autos en taller y son 20.
 * El desglose real: 16 en servicio + 4 por cotizar + 6 NO APROBADOS + 4
 * entregados. Los 6 no aprobados jamás se entregan formalmente, así que
 * jamás salen del conteo.
 *
 * Hipótesis VERIFICADA leyendo el código (este spec la firma):
 *   - `dashboard.service.js`: `entries.activos` = toda OS con
 *     `statusService !== ENTREGADO`. Un NO APROBADO se queda en EN ESPERA
 *     para siempre → infla "autos en taller" para siempre. (caso 1)
 *   - El back YA permite la salida: la máquina avanza hacia adelante con
 *     saltos (EN ESPERA→ENTREGADO válido) y el PUT manual es libre, con la
 *     guarda correcta de "sin diagnóstico no se entrega" (409). Lo que NO
 *     existe es el camino en la UI (botón de entrega en No Aprobados,
 *     OBS31-11) ni la fecha de entrega denormalizada. (casos 2-4)
 *
 * CONTRA EL CÓDIGO DE HOY se espera:
 *   caso 1  VERDE  = la foto del bug (el no aprobado cuenta como activo)
 *   casos 2-3 VERDES = la entrega formal ya funciona por API y corrige el
 *                      conteo (la pieza que falta es el front)
 *   caso 4  ROJO   = falta `deliveredAt` denormalizado (la pantalla de
 *                    entregados hoy cae a registerDate, que es mentira)
 *   caso 5  VERDE esperado = separar entregados por approvalState (si da
 *                    500 es que falta el índice compuesto: va al repo)
 *   caso 6  VERDE  = la guarda del diagnóstico no se debilita (409)
 * Tras el fix, todo verde.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"
 *   $env:AUTH_REAL="1"; $env:SKIP_SEED="1"
 *   $env:ID_WORKSHOP="G85FhlhedkD4L4CEDWvW"
 *   $env:SEED_EMAIL="<Dueño o Admin>"; $env:SEED_PASSWORD="..."
 *   npx playwright test --project=qa tests/qa/OBS31-02-11_entrega-no-aprobados.api.spec.js
 *
 * Crea 2 OS con cliente obs3102.*@test.com; al final las da de baja
 * (soft-delete) para no ensuciar los conteos de corridas futuras.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || (modo === "emulador" ? "taller-prueba" : null);
if (!ID_WORKSHOP) {
  throw new Error('Falta ID_WORKSHOP. Ej: $env:ID_WORKSHOP="G85F..."');
}
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";
const S = `${String(Date.now()).slice(-7)}`;

let clientId, entryId, entrySinDiagId;
let activosAntes = null;
let entregadoEn = null;

async function call(request, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: await authHeaders(),
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json, data: json?.data ?? json };
}
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;
const payloadDe = (r) =>
  r.data?.descripcion && typeof r.data.descripcion === "object" ? r.data.descripcion : r.data;

async function tablero(request) {
  const r = await call(request, "get", `/dashboard?idWorkshop=${ID_WORKSHOP}`);
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return payloadDe(r);
}

async function laOS(request, id) {
  const r = await call(request, "get", `/entries/${id}`);
  return payloadDe(r);
}

test.describe.configure({ mode: "serial" });

test.describe("OBS31-02/11 · entrega formal del NO APROBADO y conteo del CC @api", () => {
  test("0) se arma la OS: diagnóstico hecho, cotización enviada y RECHAZADA", async ({ request }) => {
    activosAntes = Number((await tablero(request))?.entries?.activos);
    expect(Number.isFinite(activosAntes), "el tablero debe traer entries.activos").toBe(true);

    const cliente = await call(request, "post", "/clients", {
      fullName: `Cliente obs31-02 ${S}`,
      email: `obs3102.${S}@test.com`,
      phone: `55${S}9`.slice(0, 10),
      idWorkshop: ID_WORKSHOP,
      createdBy: MECHANIC_ID,
    });
    clientId = idOf(cliente.data);
    const auto = await call(request, "post", "/cars", {
      clientId, brand: "Chevrolet", model: "Aveo", year: 2019,
      vin: `O32VIN${S}00000000`.slice(0, 17), codeCar: `O32-${S.slice(-5)}`,
      color: "Blanco", fuel: "Gasolina", transmition: "Manual", km: 61000,
    });
    const os = await call(request, "post", "/entries", {
      idWorkshop: ID_WORKSHOP, clientId, carId: idOf(auto.data),
      assigned_mechanic: MECHANIC_ID, status: 1,
      observations: "spec OBS31-02/11 (entrega formal del no aprobado)",
      registerDate: Date.now(), approvalState: "EN ESPERA",
    });
    expect(os.status, JSON.stringify(os.body)).toBeLessThan(300);
    entryId = idOf(os.data);

    const hoja = await call(request, "post", `/entries/${entryId}/service-sheet`, {
      car_items: ["Documentos", "Llave"],
      checks: ["Diagnóstico general"],
      isCheckAll: false,
      observations: "spec OBS31-02/11",
      km: 61000,
      fuel_tank: "1/4",
    });
    expect(hoja.status, JSON.stringify(hoja.body)).toBeLessThan(300);

    // El diagnóstico SÍ se hizo (es justo lo que el taller cobra aunque el
    // cliente no apruebe) — y es lo que la guarda de entrega exige.
    const diag = await call(request, "post", `/entries/${entryId}/diagnostics`, {
      generalObservations: "spec OBS31-02/11",
      findings: [{
        system: "Frenos", component: "Balatas",
        finding: `Balatas al límite ${S}`, severity: "ROJO",
        recommendation: "Cambio inmediato",
        commercialDescription: "Los frenos están al límite",
        consequence: "Riesgo de no frenar a tiempo",
      }],
      idMechanic: MECHANIC_ID,
    });
    expect(diag.status, JSON.stringify(diag.body)).toBeLessThan(300);

    const cot = await call(request, "post", `/entries/${entryId}/quotes`, {
      diagnostic: "ROJO · Los frenos están al límite",
      labor: [{ description: "Cambio de balatas", count: 1, unitPrice: 400, cost: 400, subtotal: 400, state: true }],
      parts: [],
      status: 2,
      clientBringsParts: false,
      stage: "COTIZACION",
    });
    expect(cot.status, JSON.stringify(cot.body)).toBeLessThan(300);

    // El cliente NO aprueba: la OS queda NO APROBADA (con rejectedDate).
    const rechazo = await call(request, "put", `/entries/${entryId}`, {
      approvalState: "NO APROBADA",
    });
    expect(rechazo.status, JSON.stringify(rechazo.body)).toBeLessThan(300);
    const e = await laOS(request, entryId);
    expect(e?.approvalState).toBe("NO APROBADA");
    expect(e?.rejectedDate, "el rechazo debe dejar rejectedDate").toBeTruthy();
  });

  test("1) LA FOTO DEL BUG: el no aprobado cuenta como auto EN TALLER y nada lo saca", async ({ request }) => {
    const t = await tablero(request);
    expect(
      Number(t?.entries?.activos),
      "el no aprobado infla 'autos en taller' (así se llega a 26 con 20 autos)",
    ).toBe(activosAntes + 1);
    // Y vive en el panel de aprobación como NO_APROBADA — de ahí no hay
    // ningún botón que lo saque: ese es OBS31-11.
    expect(Number(t?.entries?.approval?.NO_APROBADA)).toBeGreaterThanOrEqual(1);
  });

  test("2) la ENTREGA FORMAL del no aprobado procede por API (diagnóstico en mano)", async ({ request }) => {
    entregadoEn = Date.now();
    const ent = await call(request, "put", `/entries/${entryId}`, {
      statusService: "ENTREGADO",
    });
    expect(ent.status, JSON.stringify(ent.body)).toBeLessThan(300);

    const e = await laOS(request, entryId);
    expect(e?.statusService).toBe("ENTREGADO");
    expect(e?.approvalState, "sigue NO APROBADA: se entregó SIN autorización").toBe("NO APROBADA");
    const enBitacora = Array.isArray(e?.statusHistory) &&
      e.statusHistory.some((h) => h?.status === "ENTREGADO");
    expect(enBitacora, "la bitácora debe registrar la entrega").toBe(true);
  });

  test("3) EL ARREGLO DE FONDO: entregado, el auto SALE del conteo (26 → 20)", async ({ request }) => {
    const t = await tablero(request);
    expect(
      Number(t?.entries?.activos),
      "tras la entrega formal el conteo regresa a su valor real",
    ).toBe(activosAntes);
  });

  test("4) ROJO esperado hoy: la entrega debe dejar deliveredAt denormalizado", async ({ request }) => {
    // La pantalla de Vehículos entregados ordena/filtra por fecha de entrega,
    // pero hoy cae a registerDate porque nadie escribe deliveredAt en la
    // entrada (la fecha real vive enterrada en statusHistory).
    const e = await laOS(request, entryId);
    const dv = Number(e?.deliveredAt);
    expect(Number.isFinite(dv), "la entrada entregada debe traer deliveredAt (número)").toBe(true);
    expect(Math.abs(dv - entregadoEn), "deliveredAt debe ser la fecha real de la entrega").toBeLessThan(5 * 60_000);
  });

  test("5) el listado de entregados separa aceptaron / NO aceptaron", async ({ request }) => {
    // OBS31-11: la pantalla necesita listar los entregados SIN autorización
    // aparte. El listado ya acepta ambos filtros; si esto da 500 es que falta
    // el índice compuesto en firestore.indexes.json (al repo, BL-16).
    const r = await call(
      request, "get",
      `/entries?idWorkshop=${ID_WORKSHOP}&statusService=ENTREGADO&approvalState=${encodeURIComponent("NO APROBADA")}&limit=50`,
    );
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const filas = payloadDe(r)?.entries || [];
    expect(filas.some((x) => x.id === entryId), "el entregado sin autorización debe aparecer").toBe(true);
    for (const x of filas) {
      expect(x.approvalState, `la fila ${x.id} no es NO APROBADA`).toBe("NO APROBADA");
      expect(String(x.statusService).toUpperCase()).toBe("ENTREGADO");
    }
  });

  test("6) la guarda sigue firme: SIN diagnóstico no hay entrega (409) — y limpieza", async ({ request }) => {
    const auto2 = await call(request, "post", "/cars", {
      clientId, brand: "Chevrolet", model: "Spark", year: 2018,
      vin: `O32VIN${S}11111111`.slice(0, 17), codeCar: `O32B-${S.slice(-5)}`,
      color: "Rojo", fuel: "Gasolina", transmition: "Manual", km: 80000,
    });
    const os2 = await call(request, "post", "/entries", {
      idWorkshop: ID_WORKSHOP, clientId, carId: idOf(auto2.data),
      assigned_mechanic: MECHANIC_ID, status: 1,
      observations: "spec OBS31-02/11 (guarda de diagnóstico)",
      registerDate: Date.now(), approvalState: "EN ESPERA",
    });
    expect(os2.status, JSON.stringify(os2.body)).toBeLessThan(300);
    entrySinDiagId = idOf(os2.data);

    const ent = await call(request, "put", `/entries/${entrySinDiagId}`, {
      statusService: "ENTREGADO",
    });
    expect(ent.status, "entregar sin diagnóstico debe seguir bloqueado").toBe(409);
  });

  test.afterAll("limpieza: baja lógica de las OS del spec, pase lo que pase", async ({ playwright }) => {
    // `request` es fixture de test, no vive en afterAll: contexto propio.
    // Va en afterAll porque en modo serial un caso ROJO (el 4, hoy) saltaría
    // la limpieza si viviera dentro de un test.
    const ctx = await playwright.request.newContext();
    for (const id of [entryId, entrySinDiagId].filter(Boolean)) {
      await call(ctx, "delete", `/entries/${id}`).catch(() => {});
    }
    await ctx.dispose();
  });
});
