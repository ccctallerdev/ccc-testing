const { test, expect } = require("@playwright/test");
const { modo } = require("../../adminFlex");
const { authHeaders } = require("#apiToken");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-1 (a)(b) — Escrituras blindadas: campos y estados que el API NO debería
 * aceptar del cliente  @api
 * SPEC DE REPRODUCCIÓN (nuevo): primero firma los hoyos, luego valida el fix.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Contexto (backlog #1, detectado 8-ago): el patrón raíz era validar con Zod
 * y luego escribir el body CRUDO. Los barridos del 11/19/25-ago cerraron
 * mucho (subscriptions eliminado, workshops/cars/clients con whitelist).
 * La AUDITORÍA DE HOY (9-sep, leyendo código) encontró lo que sigue VIVO:
 *
 *   1. `CreateEntrySchema` acepta CUALQUIER `status` numérico y CUALQUIER
 *      `approvalState` de nacimiento → una OS puede NACER "APROBADA" (con
 *      approvedDate propio) saltándose cotización y selección oficial.
 *   2. `CreateQuoteSchema.status` es z.number() pelón → status 99, -5, etc.
 *   3. `CreateDiagnosticSchema.status` igual.
 *
 * CONTRA EL CÓDIGO DE HOY se espera:
 *   caso 1-4 ROJOS  = los hoyos reproducidos (hoy responden 2xx)
 *   caso 5-7 VERDES = los blindajes previos siguen firmes (regresión)
 * Tras el fix, todo verde.
 *
 * CONTRATO DEL FIX que estos casos firman:
 *   - Una OS NACE con status 1 y approvalState "EN ESPERA": cualquier otro
 *     valor en el POST se RECHAZA (la aprobación es un flujo, no un campo).
 *   - `status` de quotes y diagnósticos: solo el catálogo conocido (1..4);
 *     fuera de eso, 400.
 *   - Campos desconocidos o protegidos en PUT (isDeleted, createdAt, sheet,
 *     officialQuoteAdvance, idWorkshop del cliente) se ignoran o rechazan,
 *     NUNCA se escriben.
 *
 * ── CÓMO CORRERLO ─────────────────────────────────────────────────────────
 * Emuladores (terminal limpia, npm run serve + npm run backend):
 *   npx playwright test --project=qa tests/qa/BL1-escrituras-blindadas.api.spec.js
 * Contra QA: $env de siempre (API, AUTH_REAL, SKIP_SEED, ID_WORKSHOP,
 *   SEED_EMAIL/PASSWORD de Dueño o Admin).
 *
 * Crea 1 cliente/auto y hasta 3 OS (obs.bl1.*@test.com); TODO se da de baja
 * en afterAll pase lo que pase.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || (modo === "emulador" ? "taller-prueba" : null);
if (!ID_WORKSHOP) throw new Error('Falta ID_WORKSHOP. Ej: $env:ID_WORKSHOP="G85F..."');
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";
const S = String(Date.now()).slice(-7);

let clientId, carId, entryId, quoteId;
const entriesCreadas = [];
const carsCreados = [];

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

/** Un auto NUEVO por caso: createEntry rechaza una 2ª OS activa del mismo
 * auto (ACTIVE_ENTRY_EXISTS) y eso enmascararía el rechazo que sí se prueba
 * (falso verde detectado el 9-sep en la primera corrida). */
async function crearAuto(request, sufijo) {
  const r = await call(request, "post", "/cars", {
    clientId, brand: "Ford", model: "Fiesta", year: 2018,
    vin: `BL${sufijo}VIN${S}0000000`.slice(0, 17), codeCar: `BL${sufijo}-${S.slice(-5)}`.slice(0, 8),
    color: "Plata", fuel: "Gasolina", transmition: "Manual", km: 72000,
  });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  const id = idOf(r.data);
  carsCreados.push(id);
  return id;
}

const osBase = (carIdPropio) => ({
  idWorkshop: ID_WORKSHOP,
  clientId,
  carId: carIdPropio ?? carId,
  assigned_mechanic: MECHANIC_ID,
  status: 1,
  observations: "spec BL-1 escrituras blindadas",
  registerDate: Date.now(),
  approvalState: "EN ESPERA",
});

/** Si un caso ROJO (hoy) llegó a crear la OS, se registra para la limpieza. */
function registrarSiSeCreo(r) {
  const id = idOf(payloadDe(r));
  if (r.status < 300 && id) entriesCreadas.push(id);
}

test.describe.configure({ mode: "serial" });

test.describe("BL-1 · el API rechaza estados y campos que no son del cliente @api", () => {
  test("0) armado: cliente, auto y una OS legítima con cotización", async ({ request }) => {
    const cliente = await call(request, "post", "/clients", {
      fullName: `Cliente BL1 ${S}`,
      email: `obs.bl1.${S}@test.com`,
      phone: `54${S}00`.slice(0, 10),
      idWorkshop: ID_WORKSHOP,
      createdBy: MECHANIC_ID,
    });
    expect(cliente.status, JSON.stringify(cliente.body)).toBeLessThan(300);
    clientId = idOf(cliente.data);

    carId = await crearAuto(request, "0");

    const os = await call(request, "post", "/entries", osBase());
    expect(os.status, JSON.stringify(os.body)).toBeLessThan(300);
    entryId = idOf(os.data);
    entriesCreadas.push(entryId);

    const cot = await call(request, "post", `/entries/${entryId}/quotes`, {
      diagnostic: "spec BL-1",
      labor: [{ description: "Revisión", count: 1, unitPrice: 200, cost: 200, subtotal: 200, state: true }],
      parts: [],
      status: 2,
      clientBringsParts: false,
      stage: "COTIZACION",
    });
    expect(cot.status, JSON.stringify(cot.body)).toBeLessThan(300);
    quoteId = idOf(cot.data);
  });

  test("1) ROJO esperado hoy: una OS NO puede nacer con status arbitrario (4)", async ({ request }) => {
    const autoPropio = await crearAuto(request, "1");
    const r = await call(request, "post", "/entries", {
      ...osBase(autoPropio),
      status: 4, // fuera del único valor de nacimiento (1)
    });
    registrarSiSeCreo(r);
    expect(
      r.status,
      "el alta con status distinto de 1 debe RECHAZARSE (hoy la acepta y nace fuera del flujo)",
    ).toBeGreaterThanOrEqual(400);
  });

  test("2) ROJO esperado hoy: una OS NO puede nacer ya APROBADA (saltarse el flujo)", async ({ request }) => {
    const autoPropio = await crearAuto(request, "2");
    const r = await call(request, "post", "/entries", {
      ...osBase(autoPropio),
      approvalState: "APROBADA",
      approvedDate: Date.now(),
    });
    registrarSiSeCreo(r);
    expect(
      r.status,
      "la aprobación es un FLUJO (cotización → selección → aprobar), no un campo del alta",
    ).toBeGreaterThanOrEqual(400);
  });

  test("3) ROJO esperado hoy: el status de una cotización fuera de catálogo se rechaza", async ({ request }) => {
    const r = await call(request, "post", `/entries/${entryId}/quotes`, {
      diagnostic: "spec BL-1 status forjado",
      labor: [],
      parts: [],
      status: 99, // z.number() pelón: hoy entra cualquier cosa
      clientBringsParts: false,
      stage: "COTIZACION",
    });
    expect(
      r.status,
      "status 99 no existe en el catálogo de cotizaciones: debe ser 400",
    ).toBeGreaterThanOrEqual(400);
  });

  test("4) ROJO esperado hoy: el status de un diagnóstico fuera de catálogo se rechaza", async ({ request }) => {
    const r = await call(request, "post", `/entries/${entryId}/diagnostics`, {
      generalObservations: "spec BL-1",
      findings: [{ system: "Motor", finding: `Prueba ${S}`, severity: "VERDE" }],
      idMechanic: MECHANIC_ID,
      status: 99,
    });
    expect(
      r.status,
      "status 99 no existe en el catálogo de diagnósticos: debe ser 400",
    ).toBeGreaterThanOrEqual(400);
  });

  test("5) regresión: el PUT de autos ignora isDeleted/createdAt (blindaje del 11-ago sigue firme)", async ({ request }) => {
    const antes = payloadDe(await call(request, "get", `/cars/${carId}`));
    const r = await call(request, "put", `/cars/${carId}`, {
      color: "Rojo",
      isDeleted: true,
      createdAt: 123,
    });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const despues = payloadDe(await call(request, "get", `/cars/${carId}`));
    expect(despues?.isDeleted, "el borrado lógico NO se toca por update").not.toBe(true);
    expect(despues?.createdAt, "createdAt no se reescribe").toBe(antes?.createdAt);
    expect(despues?.color, "el campo legítimo SÍ se actualiza").toBe("Rojo");
  });

  test("6) regresión: clientes — el taller ajeno se corta con 403 y la baja lógica se ignora", async ({ request }) => {
    // Capa 1 (aislamiento multitenant, 11-ago): un idWorkshop ajeno en el
    // body ni siquiera llega a la whitelist — verifyWorkshopAccess rechaza
    // la petición ENTERA. (Primera versión de este caso esperaba "se
    // ignora"; la realidad es más fuerte: se rechaza.)
    const ajeno = await call(request, "put", `/clients/${clientId}`, {
      fullName: `Cliente BL1 ${S} hackeado`,
      idWorkshop: "taller-ajeno-bl1",
    });
    expect(ajeno.status, "el taller ajeno en el body debe dar 403").toBe(403);

    // Capa 2 (whitelist del update): isDeleted no viaja por update.
    const r = await call(request, "put", `/clients/${clientId}`, {
      fullName: `Cliente BL1 ${S} editado`,
      isDeleted: true,
    });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const c = payloadDe(await call(request, "get", `/clients/${clientId}`));
    expect(c?.isDeleted, "la baja lógica no viaja por update").not.toBe(true);
    expect(c?.fullName).toBe(`Cliente BL1 ${S} editado`);
  });

  test("7) regresión: el PUT de la OS descarta sheet y campos desconocidos de dinero", async ({ request }) => {
    const antes = payloadDe(await call(request, "get", `/entries/${entryId}`));
    const r = await call(request, "put", `/entries/${entryId}`, {
      observations: "spec BL-1 editada",
      sheet: "99999", // el número de OS lo asigna el contador, no el cliente
      officialQuoteAdvance: 99999, // foto de dinero: jamás desde el body
    });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const e = payloadDe(await call(request, "get", `/entries/${entryId}`));
    expect(String(e?.sheet ?? ""), "el No. de OS no se pisa").toBe(String(antes?.sheet ?? ""));
    expect(e?.officialQuoteAdvance, "la foto de anticipos no se inyecta").not.toBe(99999);
    expect(e?.observations).toBe("spec BL-1 editada");
  });

  test.afterAll("limpieza: baja lógica de TODO lo del spec, pase lo que pase", async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    for (const id of entriesCreadas.filter(Boolean)) {
      await ctx.delete(`${API}/entries/${id}`, { headers: await authHeaders() }).catch(() => {});
    }
    for (const id of carsCreados.filter(Boolean)) {
      await ctx.delete(`${API}/cars/${id}`, { headers: await authHeaders() }).catch(() => {});
    }
    await ctx.dispose();
  });
});
