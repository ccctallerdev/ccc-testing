const { test, expect } = require("@playwright/test");
const { modo } = require("../../adminFlex");
const { authHeaders } = require("#apiToken");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OBS21-04 — "Hacer pedido": la alerta usa la fecha de la REFACCIÓN, no la del auto
 * PRUEBAS DE API (nuevas, no recicladas) — ESCRITAS PARA FALLAR ANTES DEL FIX
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Roberto, 21-sep (punto 5, "paso extra"): la ventana de "Cambio de proveedor"
 * pasa a "Hacer pedido", con el proveedor ya elegido desde Costeo; la fecha u
 * horas de entrega de la refacción van a la alerta de entrega, "porque ahorita
 * se pone la fecha de entrega del auto"; "Cambiar proveedor" se conserva como
 * paso secundario. D31 (25-sep) = (b): "Solicitado" lo marca a mano el
 * responsable, NO se pone solo al hacer el pedido.
 *
 * Causa del bug (lectura de código): al aprobar, `applyApprovedSelection`
 * genera la orden automática con `expectedDate: quote.promiseDate` — la fecha
 * en que se promete ENTREGAR EL AUTO —, y `poTimeAlert` mide el % de tiempo
 * contra esa fecha. Además no existe forma de capturar la fecha de la
 * refacción en la MISMA orden: "Otro proveedor" crea una orden nueva y marca
 * la original "No encontrada" (así se duplican pedidos).
 *
 * Contrato nuevo que fija este spec:
 *   POST /purchase-orders/:id/place  { expectedDate: ms, supplierId?: string }
 *   → actualiza ESA orden (no crea otra): expectedDate, orderedAt y, si viene,
 *     supplierId/supplierName. No toca sourcingStatus (D31 = b). Solo órdenes
 *     abiertas; fecha en el pasado → 400.
 *
 * Casos:
 *   A  al aprobar, la orden automática NO hereda la fecha de entrega del auto
 *   B  "Hacer pedido" actualiza la MISMA orden: fecha, orderedAt, sin duplicar,
 *      y sigue "En espera" (Solicitado es manual, D31)
 *   C  "Hacer pedido" con proveedor en una orden sin proveedor → lo asigna con nombre
 *   D  "Hacer pedido" sobre una orden ya recibida → 409
 *   E  "Hacer pedido" sin fecha o con fecha pasada → 400
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"   (o http://localhost:3001/v1)
 *   $env:AUTH_REAL="1"; $env:SKIP_SEED="1"
 *   $env:ID_WORKSHOP="G85FhlhedkD4L4CEDWvW"
 *   $env:SEED_EMAIL="rsv_gpa@outlook.com"; $env:SEED_PASSWORD="<contraseña>"
 *   npx playwright test --project=qa tests/qa/OBS21-04_hacer-pedido.api.spec.js
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

async function ordenesDeLaOS(request, entryId) {
  const r = await call(request, "get", `/purchase-orders?idWorkshop=${ID_WORKSHOP}&scope=all`);
  return (r.data?.orders || []).filter((o) => o.entryId === entryId && o.status !== "CANCELLED");
}

/** Proveedor real del catálogo (para que la orden tenga supplierName). */
async function crearProveedor(request, S) {
  const r = await call(request, "post", "/suppliers", {
    idWorkshop: ID_WORKSHOP,
    name: `Refacciones OBS21-04 ${S}`,
  });
  ok(r, "alta del proveedor");
  return { id: idOf(r.data), name: `Refacciones OBS21-04 ${S}` };
}

/**
 * OS con una partida de PROVEEDOR (con proveedor desde Costeo) y la promesa
 * de entrega del AUTO a 3 días. La aprueba por conceptos → orden automática.
 */
async function osAprobadaConPedido(request, S, proveedor) {
  const cliente = await call(request, "post", "/clients", {
    fullName: `Cliente obs21-04 ${S}`, email: `obs2104.${S}@test.com`,
    phone: `55${S}4`, idWorkshop: ID_WORKSHOP, createdBy: MECHANIC_ID,
  });
  ok(cliente, "cliente");
  const auto = await call(request, "post", "/cars", {
    clientId: idOf(cliente.data), brand: "Nissan", model: "Versa", year: 2021,
    vin: `O24VIN${S}0000000`.slice(0, 17), codeCar: `O24-${S.slice(-4)}`,
    color: "Gris", fuel: "Gasolina", transmition: "Manual", km: 40000,
  });
  ok(auto, "auto");
  const os = await call(request, "post", "/entries", {
    idWorkshop: ID_WORKSHOP, clientId: idOf(cliente.data), carId: idOf(auto.data),
    assigned_mechanic: MECHANIC_ID, status: 1, observations: "spec OBS21-04",
    registerDate: Date.now(), approvalState: "EN ESPERA",
  });
  ok(os, "OS");
  const entryId = idOf(os.data);
  ok(await call(request, "post", `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos"], checks: ["Servicio de Frenos"], isCheckAll: false,
    observations: "spec OBS21-04", km: 40000, fuel_tank: "1/2",
  }), "hoja");
  const promesaAuto = Date.now() + 72 * HORA;
  const cot = await call(request, "post", `/entries/${entryId}/quotes`, {
    diagnostic: "Frenos", promiseDate: promesaAuto,
    labor: [{ description: "Mano de obra", count: 1, unitPrice: 300, cost: 300, subtotal: 300, state: true }],
    parts: [{
      description: `Balatas OBS21-04 ${S}`, count: 2, unitPrice: 500, cost: 500, subtotal: 1000,
      state: true, costProveedor: 300, utilidad: 40, availability: "VERDE",
      supplierId: proveedor.id, supplierName: proveedor.name,
    }],
    status: 2, clientBringsParts: false, stage: "COTIZACION",
  });
  ok(cot, "cotización");
  ok(await call(request, "post", `/entries/${entryId}/quotes/${idOf(cot.data)}/approve-concepts`, {
    approvedParts: [0], approvedLabor: [0],
  }), "approve-concepts");
  const ordenes = await ordenesDeLaOS(request, entryId);
  const auto0 = ordenes.find((o) => o.origin !== "INVENTORY");
  expect(auto0, `al aprobar debe generarse la orden al proveedor. Órdenes: ${JSON.stringify(ordenes)}`).toBeTruthy();
  return { entryId, promesaAuto, orden: auto0, totalOrdenes: ordenes.length };
}

test.describe("OBS21-04 · Hacer pedido: la alerta usa la fecha de la refacción @api", () => {
  test("A) al aprobar, la orden automática NO hereda la fecha de entrega del AUTO", async ({ request }) => {
    const S = unico();
    const prov = await crearProveedor(request, S);
    const { orden, promesaAuto } = await osAprobadaConPedido(request, S, prov);

    expect(
      Number(orden.expectedDate) || null,
      `la fecha esperada de la refacción no se conoce hasta "Hacer pedido"; hoy trae la promesa del auto (${promesaAuto})`,
    ).not.toBe(promesaAuto);
    expect(orden.expectedDate ?? null, "sin pedido hecho, la orden no tiene fecha esperada").toBeNull();
    expect(orden.supplierName, "la orden automática trae el proveedor elegido en Costeo").toBe(prov.name);
  });

  test("B) 'Hacer pedido' actualiza la MISMA orden (fecha + orderedAt), sin duplicar, y sigue En espera", async ({ request }) => {
    const S = unico();
    const prov = await crearProveedor(request, S);
    const { entryId, orden, totalOrdenes } = await osAprobadaConPedido(request, S, prov);

    const antes = Date.now();
    const fecha = antes + 6 * HORA;
    const r = await call(request, "post", `/purchase-orders/${orden.id}/place`, { expectedDate: fecha });
    ok(r, "POST /purchase-orders/:id/place");

    const despues = await call(request, "get", `/purchase-orders/${orden.id}`);
    const o = despues.data;
    expect(Number(o.expectedDate), "la alerta toma la fecha de la REFACCIÓN").toBe(fecha);
    expect(Number(o.orderedAt), "queda registrada la hora del pedido (inicio de la alerta)").toBeGreaterThanOrEqual(antes - 60_000);
    expect(o.sourcingStatus, "D31 = (b): 'Solicitado' lo marca el responsable a mano").toBe("EN_ESPERA");
    expect(o.supplierId, "el proveedor de Costeo se conserva").toBe(prov.id);

    const ordenes = await ordenesDeLaOS(request, entryId);
    expect(ordenes.length, "Hacer pedido NO crea otra orden").toBe(totalOrdenes);
  });

  test("C) 'Hacer pedido' con proveedor en una orden SIN proveedor → lo asigna con su nombre", async ({ request }) => {
    const S = unico();
    const prov = await crearProveedor(request, S);
    const po = await call(request, "post", "/purchase-orders", {
      idWorkshop: ID_WORKSHOP, supplierId: "", notes: "spec OBS21-04 C",
      items: [{ description: `Pieza sin proveedor ${S}`, qty: 1, unitCost: 100 }],
    });
    ok(po, "orden sin proveedor");
    const id = idOf(po.data);

    ok(await call(request, "post", `/purchase-orders/${id}/place`, {
      expectedDate: Date.now() + 24 * HORA, supplierId: prov.id,
    }), "place con proveedor");
    const o = (await call(request, "get", `/purchase-orders/${id}`)).data;
    expect(o.supplierId).toBe(prov.id);
    expect(o.supplierName, "el nombre sale del catálogo, no queda 'Sin proveedor'").toBe(prov.name);
  });

  test("D) 'Hacer pedido' sobre una orden ya RECIBIDA → rechazado", async ({ request }) => {
    const S = unico();
    const po = await call(request, "post", "/purchase-orders", {
      idWorkshop: ID_WORKSHOP, supplierId: "", notes: "spec OBS21-04 D",
      items: [{ description: `Pieza recibida ${S}`, qty: 1, unitCost: 100 }],
    });
    ok(po, "orden");
    const id = idOf(po.data);
    ok(await call(request, "post", `/purchase-orders/${id}/receive`, { items: [{ index: 0, received: 1 }] }), "recepción");

    const r = await call(request, "post", `/purchase-orders/${id}/place`, { expectedDate: Date.now() + 6 * HORA });
    // 409 exacto: un 404 (endpoint inexistente) NO debe contar como "rechazado".
    expect(r.status, `no se puede pedir lo que ya llegó: ${JSON.stringify(r.body)}`).toBe(409);
  });

  test("E) 'Hacer pedido' sin fecha o con fecha pasada → 400", async ({ request }) => {
    const S = unico();
    const po = await call(request, "post", "/purchase-orders", {
      idWorkshop: ID_WORKSHOP, supplierId: "", notes: "spec OBS21-04 E",
      items: [{ description: `Pieza E ${S}`, qty: 1, unitCost: 100 }],
    });
    ok(po, "orden");
    const id = idOf(po.data);

    const sinFecha = await call(request, "post", `/purchase-orders/${id}/place`, {});
    expect(sinFecha.status, JSON.stringify(sinFecha.body)).toBe(400);
    const pasada = await call(request, "post", `/purchase-orders/${id}/place`, { expectedDate: Date.now() - HORA });
    expect(pasada.status, JSON.stringify(pasada.body)).toBe(400);
  });
});
