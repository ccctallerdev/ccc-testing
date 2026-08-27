const { test, expect } = require("@playwright/test");
// adminFlex decide solo: API en localhost -> EMULADORES; otra cosa -> refac.
const { auth: qaAuth, modo } = require("../../adminFlex");
const { headersFor } = require("../../qaAuth");
const { authHeaders } = require("#apiToken");

/**
 * ─────────────────────────────────────────────────────────────────────────
 * COSTEO -> COTIZACION: el guardado del Asesor no borra el costo de
 * proveedor ni el proveedor  @api
 *
 * Cierra BACKLOG_TECNICO punto 15 y las observaciones 19/20 de Roberto, que
 * son el MISMO bug:
 *
 *   1. `sanitizeResponse` le borraba `cost` al Asesor porque
 *      SENSITIVE_FIELDS lo tenia como costo de proveedor — pero en una
 *      cotizacion `cost` es el precio AL CLIENTE. El Asesor veia el subtotal
 *      y el precio unitario vacio, y `isQuotePartsValid` no lo dejaba guardar.
 *      Arreglo: el precio al cliente se llama `unitPrice` (CAN_VIEW_SELL_PRICE).
 *
 *   2. `UpdateQuoteSchema` solo declaraba description/count/cost/subtotal/
 *      state/inventoryId, asi que cada PUT tiraba `costProveedor`, `utilidad`,
 *      `supplierId`, `supplierName`, `availability` y `findingId`. La orden de
 *      compra nacia en $0 (punto 15) y agrupada en "Sin proveedor" (obs 19/20).
 *      Arreglo: el PUT reusa el mismo `partItem` que el POST y el servicio hace
 *      merge por campo (helpers/quoteLines.js).
 *
 * La aserción que de verdad importa esta al final: despues de que el Asesor
 * guarda, `procurement` de la OS debe traer unitCost 600 y el proveedor —
 * que es lo que alimenta la orden de compra.
 *
 * CÓMO CORRE (igual que los demás gemelos de qa/):
 *
 *   EMULADORES:  emuladores + backend local + `node seed_emulator_user.js`
 *     npx playwright test --project=qa tests/qa/cotizacion-costeo.qa.spec.js
 *
 *   REFAC:
 *     $env:AUTH_REAL="1"
 *     $env:ID_WORKSHOP="<taller refac>"; $env:SEED_EMAIL=...; $env:SEED_PASSWORD=...
 *     npx playwright test --project=qa tests/qa/cotizacion-costeo.qa.spec.js
 *
 * Reparto de roles (regla del 26-ago: cada llamada con el token de SU rol):
 *   · Dueño (authHeaders del usuario semilla) -> costea: captura costo de
 *     proveedor, utilidad y proveedor.
 *   · Asesor (usuario efímero, claim ASESOR)  -> pone precio y guarda.
 * El Asesor se crea con el Admin SDK y se borra al final: sembrar
 * precondiciones por Admin SDK sí está permitido; lo que se PRUEBA viaja
 * siempre por la API.
 * ─────────────────────────────────────────────────────────────────────────
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || (modo === "emulador" ? "taller-prueba" : null);
if (!ID_WORKSHOP) {
  throw new Error('Falta ID_WORKSHOP (taller real de refac). Ej: $env:ID_WORKSHOP="05Pf..."');
}
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";

const suffix = `${String(Date.now()).slice(-7)}`;
const ASESOR_EMAIL = `asesor.costeo.${suffix}@ccc.test`;
const PASSWORD = "Prueba1234!";

// Los números del backlog, para que el spec hable el mismo idioma que el ticket.
const COSTO_PROVEEDOR = 600;
const PRECIO_CLIENTE = 850;
const PRECIO_NUEVO = 900;
const CANTIDAD = 2;

const creados = { uids: [] };
let asesorHeaders;
let entryId;
let quoteId;
let sheetId;

async function call(request, method, path, { body, headers } = {}) {
  const res = await request[method](`${API}${path}`, {
    headers: { ...(headers || (await authHeaders())) },
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json, data: json?.data ?? json };
}

const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

/** Precio unitario al cliente: canónico `unitPrice`, respaldo legacy `cost`. */
const precioDe = (l) => Number(l?.unitPrice !== undefined && l?.unitPrice !== "" ? l.unitPrice : l?.cost);

/** La partida tal como la deja el Dueño en el Costeo. */
const partidaDelCosteo = () => ({
  description: "Balatas delanteras",
  count: CANTIDAD,
  unitPrice: PRECIO_CLIENTE,
  cost: PRECIO_CLIENTE, // espejo deprecado (app móvil)
  subtotal: CANTIDAD * PRECIO_CLIENTE,
  state: true,
  costProveedor: COSTO_PROVEEDOR,
  utilidad: 41.67,
  supplierId: `SUP-${suffix}`,
  supplierName: "Refaccionaria ACME",
  availability: "VERDE",
});

test.describe.configure({ mode: "serial" });

test.describe("Costeo -> Cotización: el Asesor no borra el costo del Dueño @api", () => {
  test.beforeAll(async ({ }) => {
    const user = await qaAuth().createUser({ email: ASESOR_EMAIL, password: PASSWORD });
    await qaAuth().setCustomUserClaims(user.uid, { role: "ASESOR", idWorkshop: ID_WORKSHOP });
    creados.uids.push(user.uid);
    asesorHeaders = await headersFor(ASESOR_EMAIL, PASSWORD);
  });

  test.afterAll(async () => {
    for (const uid of creados.uids) await qaAuth().deleteUser(uid).catch(() => {});
  });

  test("el Dueño costea: la partida guarda costo de proveedor, utilidad y proveedor", async ({ request }) => {
    const cliente = await call(request, "post", "/clients", {
      body: {
        fullName: `Cliente costeo ${suffix}`,
        email: `costeo.${suffix}@test.com`,
        phone: `55${suffix}000`.slice(0, 10),
        idWorkshop: ID_WORKSHOP,
        createdBy: MECHANIC_ID,
      },
    });
    expect(cliente.status, JSON.stringify(cliente.body)).toBeLessThan(300);
    const clientId = idOf(cliente.data);

    const auto = await call(request, "post", "/cars", {
      body: {
        clientId, brand: "Nissan", model: "March", year: 2019,
        vin: `CQVIN${suffix}0000000`.slice(0, 17),
        codeCar: `CQ-${suffix.slice(-5)}`,
        color: "Rojo", fuel: "Gasolina", transmition: "Manual", km: 60000,
      },
    });
    const carId = idOf(auto.data);

    const os = await call(request, "post", "/entries", {
      body: {
        idWorkshop: ID_WORKSHOP, clientId, carId,
        assigned_mechanic: MECHANIC_ID,
        status: 1,
        observations: "spec cotizacion-costeo (backlog 15 / obs 19-20)",
        registerDate: Date.now(),
        approvalState: "EN ESPERA",
      },
    });
    expect(os.status, JSON.stringify(os.body)).toBeLessThan(300);
    entryId = idOf(os.data);

    const hoja = await call(request, "post", `/entries/${entryId}/service-sheet`, {
      body: {
        car_items: ["Documentos", "Llave"],
        checks: ["Servicio de Frenos"],
        isCheckAll: false,
        observations: "spec cotizacion-costeo",
        km: 60000,
        fuel_tank: "1/2",
      },
    });
    sheetId = idOf(hoja.data);

    // El Costeo del Dueño: refacción con costo de proveedor y proveedor.
    const cot = await call(request, "post", `/entries/${entryId}/quotes`, {
      body: {
        diagnostic: "Frenos: balatas al límite",
        labor: [{ description: "Cambio de balatas", count: 1, unitPrice: "", cost: "", subtotal: 0, state: false }],
        parts: [partidaDelCosteo()],
        status: 2,
        clientBringsParts: false,
        stage: "COSTEO",
      },
    });
    expect(cot.status, JSON.stringify(cot.body)).toBeLessThan(300);
    quoteId = idOf(cot.data);

    // Como Dueño se ve TODO.
    const leido = await call(request, "get", `/entries/${entryId}/quotes/${quoteId}`);
    const [partida] = leido.data.parts;
    expect(Number(partida.costProveedor)).toBe(COSTO_PROVEEDOR);
    expect(partida.supplierId).toBe(`SUP-${suffix}`);
    expect(partida.supplierName).toBe("Refaccionaria ACME");
    expect(precioDe(partida)).toBe(PRECIO_CLIENTE);
    // El POST sella un id estable por partida: es lo que permite el merge.
    expect(partida.lineId, "el POST debe sellar lineId a cada partida").toBeTruthy();
  });

  test("al Asesor SÍ le llega el precio al cliente, y NO el costo de proveedor", async ({ request }) => {
    const comoAsesor = await call(request, "get", `/entries/${entryId}/quotes/${quoteId}`, {
      headers: asesorHeaders,
    });
    expect(comoAsesor.status).toBe(200);
    const [partida] = comoAsesor.data.parts;

    // Bug 1 del punto 15: antes llegaba vacío y no podía guardar nunca.
    expect(precioDe(partida), "el Asesor debe ver el precio al cliente").toBe(PRECIO_CLIENTE);
    expect(Number(partida.subtotal)).toBe(CANTIDAD * PRECIO_CLIENTE);

    // Y sigue sin ver lo que no le toca (esto además tapa una fuga: el campo
    // real se llama `costProveedor` y no estaba en SENSITIVE_FIELDS).
    expect(partida.costProveedor, "el Asesor NO debe ver el costo de proveedor").toBeUndefined();
    expect(partida.utilidad, "el Asesor NO debe ver la utilidad").toBeUndefined();
  });

  test("el Asesor guarda su precio y NO borra el costo de proveedor ni el proveedor", async ({ request }) => {
    // Round-trip idéntico al de QuoteEdit: lee lo que le dejaron ver y manda
    // el arreglo `parts` COMPLETO. Ahí es donde antes se perdía todo.
    const leido = await call(request, "get", `/entries/${entryId}/quotes/${quoteId}`, {
      headers: asesorHeaders,
    });
    const partes = leido.data.parts.map((p) => ({
      ...p,
      unitPrice: PRECIO_NUEVO,
      cost: PRECIO_NUEVO,
      subtotal: CANTIDAD * PRECIO_NUEVO,
    }));

    const guardado = await call(request, "put", `/entries/${entryId}/quotes/${quoteId}`, {
      body: {
        diagnostic: leido.data.diagnostic ?? "",
        labor: leido.data.labor ?? [],
        parts: partes,
        status: 2,
        clientBringsParts: false,
        stage: "COTIZACION",
      },
      headers: asesorHeaders,
    });
    expect(guardado.status, JSON.stringify(guardado.body)).toBeLessThan(300);

    // Y ahora, como Dueño, TODO debe seguir ahí.
    const verificado = await call(request, "get", `/entries/${entryId}/quotes/${quoteId}`);
    const [partida] = verificado.data.parts;

    expect(Number(partida.costProveedor),
      "punto 15: el guardado del Asesor borraba el costo de proveedor").toBe(COSTO_PROVEEDOR);
    expect(partida.supplierId,
      "obs 19/20: el guardado del Asesor borraba el proveedor").toBe(`SUP-${suffix}`);
    expect(partida.supplierName).toBe("Refaccionaria ACME");
    expect(Number(partida.utilidad)).toBe(41.67);
    expect(partida.availability).toBe("VERDE");
    // Y sí se aplicó lo que el Asesor sí cambió.
    expect(precioDe(partida)).toBe(PRECIO_NUEVO);
    expect(Number(partida.subtotal)).toBe(CANTIDAD * PRECIO_NUEVO);
  });

  test("al aprobar, la orden de compra nace con 600 y CON proveedor (no en $0 ni 'Sin proveedor')", async ({ request }) => {
    const aprobada = await call(request, "put", `/entries/${entryId}/approve-selection`, {
      body: { approvedServiceSheetId: sheetId, approvedQuoteId: quoteId },
    });
    expect(aprobada.status, JSON.stringify(aprobada.body)).toBeLessThan(300);

    const os = await call(request, "get", `/entries/${entryId}`);
    const procurement = os.data?.procurement ?? [];
    const linea = procurement.find((p) => /balatas/i.test(p.description || ""));
    expect(linea, "la refacción debe generar compra").toBeTruthy();

    // Éste es el número que importa: antes nacía en 0 porque el PUT del Asesor
    // había borrado `costProveedor`.
    expect(Number(linea.unitCost),
      "la orden de compra debe nacer con el costo de proveedor, no en $0").toBe(COSTO_PROVEEDOR);
    expect(linea.supplierId,
      "todo caía en la etiqueta 'Sin proveedor' (obs 19/20)").toBe(`SUP-${suffix}`);
    expect(linea.supplierName).toBe("Refaccionaria ACME");
    expect(Number(linea.qty)).toBe(CANTIDAD);
  });
});
