const { test, expect } = require("@playwright/test");
const { modo } = require("../../adminFlex");
const { authHeaders } = require("#apiToken");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-62 — quitar el vínculo de una partida con el inventario
 * PRUEBAS DE API (nuevas, no recicladas) — ESCRITAS PARA FALLAR ANTES DEL FIX
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Enrique, 29-sep-2026 (prueba manual de OBS21-01): una línea tomada del
 * Inventario conservaba `inventoryId` aunque se borrara o cambiara la
 * descripción; la cotización seguía reservando stock y generando la orden de
 * INVENTARIO de una pieza que ya no se quería.
 *
 * Causa en el back: `mergeQuoteLines` (punto 15) tiene `inventoryId` entre los
 * campos protegidos: un "" o la ausencia de la clave RESTAURA el almacenado.
 * Por eso el front solo no lo resuelve.
 *
 * Contrato nuevo que fija este spec (ccc-backend, rama fix/bl62-…-api):
 *   PUT /entries/:id/quotes/:qid  parts[i].inventoryId = null
 *   → la partida queda SIN inventoryId (ni null escrito). "" / ausente siguen
 *     conservando el almacenado. Otro tipo (número) → 400.
 *
 * Casos:
 *   A  control: "" y ausente conservan el vínculo (regla del punto 15 intacta)
 *   B  null quita el vínculo: GET regresa la partida sin inventoryId
 *   C  fila vaciada (sin lineId) con la MISMA descripción y null → sin vínculo
 *   D  inventoryId numérico → 400
 *   E  efecto de negocio: desvinculada y aprobada → no compromete stock ni
 *      genera orden origin INVENTORY
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"   (o http://localhost:3001/v1)
 *   $env:AUTH_REAL="1"; $env:SKIP_SEED="1"
 *   $env:ID_WORKSHOP="G85FhlhedkD4L4CEDWvW"
 *   $env:SEED_EMAIL="rsv_gpa@outlook.com"; $env:SEED_PASSWORD="<contraseña>"
 *   npx playwright test --project=qa tests/qa/BL-62_desvincular-linea.api.spec.js
 *
 * ── ROJO ESPERADO sin el fix ──────────────────────────────────────────────
 *   B/C/E: el GET sigue trayendo inventoryId (o el PUT responde 400 por el null).
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || (modo === "emulador" ? "taller-prueba" : null);
if (!ID_WORKSHOP) {
  throw new Error('Falta ID_WORKSHOP (taller real de refac). Ej: $env:ID_WORKSHOP="G85F..."');
}
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";
const HORA = 3600 * 1000;

let contador = 0;
const unico = () => String(Date.now() + contador++).slice(-7);

async function call(request, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: await authHeaders(),
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json, data: json?.data ?? json };
}
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;
const ok = (r, msg) => expect(r.status, `${msg}: ${JSON.stringify(r.body)}`).toBeLessThan(300);

async function crearArticulo(request, S) {
  const r = await call(request, "post", "/inventory", {
    idWorkshop: ID_WORKSHOP, name: `Filtro BL-62 ${S}`, sku: `BL62-${S}`,
    cost: 180, price: 243, stock: 10,
  });
  ok(r, "alta del artículo de inventario");
  return { id: idOf(r.data), name: `Filtro BL-62 ${S}` };
}

/** OS con una cotización de UNA partida vinculada al artículo. */
async function osConPartidaVinculada(request, S, articulo) {
  const cliente = await call(request, "post", "/clients", {
    fullName: `Cliente bl62 ${S}`, email: `bl62.${S}@test.com`,
    phone: `55${S}2`, idWorkshop: ID_WORKSHOP, createdBy: MECHANIC_ID,
  });
  ok(cliente, "cliente");
  const auto = await call(request, "post", "/cars", {
    clientId: idOf(cliente.data), brand: "Nissan", model: "March", year: 2020,
    vin: `B62VIN${S}0000000`.slice(0, 17), codeCar: `B62-${S.slice(-4)}`,
    color: "Rojo", fuel: "Gasolina", transmition: "Manual", km: 30000,
  });
  ok(auto, "auto");
  const os = await call(request, "post", "/entries", {
    idWorkshop: ID_WORKSHOP, clientId: idOf(cliente.data), carId: idOf(auto.data),
    assigned_mechanic: MECHANIC_ID, status: 1, observations: "spec BL-62",
    registerDate: Date.now(), approvalState: "EN ESPERA",
  });
  ok(os, "OS");
  const entryId = idOf(os.data);
  ok(await call(request, "post", `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos"], checks: ["Servicio de Frenos"], isCheckAll: false,
    observations: "spec BL-62", km: 30000, fuel_tank: "1/2",
  }), "hoja");
  const cot = await call(request, "post", `/entries/${entryId}/quotes`, {
    diagnostic: "Servicio", promiseDate: Date.now() + 72 * HORA,
    labor: [{ description: "Mano de obra", count: 1, unitPrice: 300, cost: 300, subtotal: 300, state: true }],
    parts: [{
      description: articulo.name, count: 1, unitPrice: 243, cost: 243, subtotal: 243,
      state: true, costProveedor: 180, utilidad: 26, inventoryId: articulo.id,
    }],
    status: 2, clientBringsParts: false, stage: "COTIZACION",
  });
  ok(cot, "cotización");
  const quoteId = idOf(cot.data);
  const q = (await call(request, "get", `/entries/${entryId}/quotes/${quoteId}`)).data;
  expect(q.parts?.[0]?.inventoryId, "precondición: la partida nace vinculada").toBe(articulo.id);
  expect(q.parts?.[0]?.lineId, "precondición: el back selló lineId").toBeTruthy();
  return { entryId, quoteId, linea: q.parts[0] };
}

const partidaBase = (linea, extra) => ({
  lineId: linea.lineId, description: linea.description, count: 1,
  unitPrice: 243, cost: 243, subtotal: 243, state: true, ...extra,
});
const putParts = (request, entryId, quoteId, parts) =>
  call(request, "put", `/entries/${entryId}/quotes/${quoteId}`, { parts });
const getParts = async (request, entryId, quoteId) =>
  (await call(request, "get", `/entries/${entryId}/quotes/${quoteId}`)).data.parts;

test.describe("BL-62 · quitar el vínculo de una partida con el inventario @api", () => {
  test("A) control: inventoryId \"\" o ausente CONSERVAN el vínculo (punto 15)", async ({ request }) => {
    const S = unico();
    const art = await crearArticulo(request, S);
    const { entryId, quoteId, linea } = await osConPartidaVinculada(request, S, art);

    ok(await putParts(request, entryId, quoteId, [partidaBase(linea, { inventoryId: "" })]), "PUT con \"\"");
    expect((await getParts(request, entryId, quoteId))[0].inventoryId, "\"\" no borra").toBe(art.id);

    ok(await putParts(request, entryId, quoteId, [partidaBase(linea)]), "PUT sin la clave");
    expect((await getParts(request, entryId, quoteId))[0].inventoryId, "ausente no borra (Asesor censurado)").toBe(art.id);
  });

  test("B) inventoryId: null QUITA el vínculo y no se escribe null", async ({ request }) => {
    const S = unico();
    const art = await crearArticulo(request, S);
    const { entryId, quoteId, linea } = await osConPartidaVinculada(request, S, art);

    const r = await putParts(request, entryId, quoteId, [partidaBase(linea, { inventoryId: null })]);
    expect(r.status, `el PUT debe aceptar null: ${JSON.stringify(r.body)}`).toBeLessThan(300);

    const [p] = await getParts(request, entryId, quoteId);
    expect(p.description, "la línea sigue ahí como texto libre").toBe(art.name);
    expect(p.lineId, "conserva su lineId").toBe(linea.lineId);
    expect("inventoryId" in p ? p.inventoryId : undefined, "sin inventoryId (ni null)").toBeUndefined();
    expect(p.costProveedor, "los otros campos protegidos siguen intactos").toBe(180);
  });

  test("C) fila vaciada (sin lineId) con la misma descripción y null → sin vínculo", async ({ request }) => {
    const S = unico();
    const art = await crearArticulo(request, S);
    const { entryId, quoteId, linea } = await osConPartidaVinculada(request, S, art);

    // El front, al borrar la única fila, la deja sin lineId; el usuario vuelve a
    // escribir la misma descripción. El fallback por descripción NO debe devolver el vínculo.
    const { lineId, ...sinId } = partidaBase(linea, { inventoryId: null, unitPrice: 300, cost: 300, subtotal: 300 });
    ok(await putParts(request, entryId, quoteId, [sinId]), "PUT fila vaciada");
    const [p] = await getParts(request, entryId, quoteId);
    expect(p.inventoryId ?? undefined, "no hereda el inventoryId por descripción").toBeUndefined();
  });

  test("D) inventoryId numérico → 400", async ({ request }) => {
    const S = unico();
    const art = await crearArticulo(request, S);
    const { entryId, quoteId, linea } = await osConPartidaVinculada(request, S, art);
    const r = await putParts(request, entryId, quoteId, [partidaBase(linea, { inventoryId: 9 })]);
    expect(r.status, "solo string o null").toBe(400);
  });

  test("E) desvinculada y aprobada: NO compromete stock ni genera orden de INVENTARIO", async ({ request }) => {
    const S = unico();
    const art = await crearArticulo(request, S);
    const { entryId, quoteId, linea } = await osConPartidaVinculada(request, S, art);
    const antes = (await call(request, "get", `/inventory/${art.id}`)).data;

    ok(await putParts(request, entryId, quoteId, [partidaBase(linea, { inventoryId: null })]), "desvincular");
    ok(await call(request, "post", `/entries/${entryId}/quotes/${quoteId}/approve-concepts`, {
      approvedParts: [0], approvedLabor: [0],
    }), "approve-concepts");

    const despues = (await call(request, "get", `/inventory/${art.id}`)).data;
    expect(Number(despues.committed) || 0, "el stock del artículo NO queda comprometido").toBe(Number(antes.committed) || 0);
    expect(Number(despues.stock), "el stock físico no cambia").toBe(Number(antes.stock));

    const r = await call(request, "get", `/purchase-orders?idWorkshop=${ID_WORKSHOP}&scope=all`);
    const deLaOS = (r.data?.orders || []).filter((o) => o.entryId === entryId && o.status !== "CANCELLED");
    expect(deLaOS.some((o) => o.origin === "INVENTORY"), `no debe haber orden de INVENTARIO: ${JSON.stringify(deLaOS)}`).toBe(false);
    // Como texto libre, la pieza se compra completa: sí nace la orden a proveedor.
    expect(deLaOS.some((o) => o.origin !== "INVENTORY"), "la pieza libre sí genera pedido a proveedor").toBe(true);
  });
});
