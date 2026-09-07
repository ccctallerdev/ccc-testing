const { test, expect } = require("@playwright/test");
const { modo } = require("../../adminFlex");
const { authHeaders } = require("#apiToken");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OBS31-01 — El auto aprobado queda EN ESPERA, no salta a REFACCIONES
 * PRUEBAS DE API (nuevas, no recicladas)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La REGRESIÓN que valida (reportada por Roberto el 31-ago, "esto ya
 * funcionaba"): al autorizar la cotización el auto saltaba directo a
 * REFACCIONES. Causa: la generación automática de órdenes de compra al aprobar
 * avanzaba el estado, y la máquina "solo hacia adelante" descartaba el
 * EN_ESPERA que ponía el endpoint.
 *
 * La especificación de Roberto (doc del 2-sep):
 *   autorizar cotización        → EN ESPERA        (automático)
 *   abastecimiento parcial/completo → REFACCIONES  (automático)
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"
 *   $env:AUTH_REAL="1"; $env:SKIP_SEED="1"
 *   $env:ID_WORKSHOP="<taller de pruebas de refac>"
 *   $env:SEED_EMAIL="<correo del Dueño>"; $env:SEED_PASSWORD="<contraseña>"
 *   npx playwright test --project=qa tests/qa/OBS31-01_flujo-refacciones.api.spec.js
 *
 * Requiere el backend de la rama fix/obs31-01-flujo-refacciones-api desplegado.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || (modo === "emulador" ? "taller-prueba" : null);
if (!ID_WORKSHOP) {
  throw new Error('Falta ID_WORKSHOP (taller real de refac). Ej: $env:ID_WORKSHOP="05Pf..."');
}
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";
const S = `${String(Date.now()).slice(-7)}`;
const PRECIO = 850;

let entryId, quoteId, poId;

async function call(request, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: await authHeaders(),
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json, data: json?.data ?? json };
}
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

async function ordenesDeLaOS(request) {
  // scope=all + filtro por entryId del lado del cliente (el listado activo
  // ignora el filtro entryId). Devuelve las órdenes NO canceladas de la OS.
  const r = await call(request, "get", `/purchase-orders?idWorkshop=${ID_WORKSHOP}&scope=all`);
  const orders = (r.data?.orders || []).filter((o) => o.entryId === entryId && o.status !== "CANCELLED");
  return orders;
}

async function recibirTodoPendiente(request) {
  const orders = await ordenesDeLaOS(request);
  for (const o of orders) {
    const items = (o.items || [])
      .map((it, index) => ({ index, faltan: (Number(it.qty) || 0) - (Number(it.qtyReceived) || 0) }))
      .filter((x) => x.faltan > 0)
      .map((x) => ({ index: x.index, received: x.faltan }));
    if (items.length) {
      const rec = await call(request, "post", `/purchase-orders/${o.id}/receive`, { items });
      expect(rec.status, JSON.stringify(rec.body)).toBeLessThan(300);
    }
  }
}

async function estadoDeLaOS(request) {
  const r = await call(request, "get", `/entries/${entryId}`);
  const e = r.data?.descripcion && typeof r.data.descripcion === "object" ? r.data.descripcion : r.data;
  return { statusService: e?.statusService ?? null, repairReadiness: e?.repairReadiness ?? null, raw: e };
}

test.describe.configure({ mode: "serial" });

test.describe("OBS31-01 · aprobar deja EN ESPERA; recibir mueve a REFACCIONES @api", () => {
  test("0) se arma la OS con cotización enviada (con faltante de proveedor)", async ({ request }) => {
    const cliente = await call(request, "post", "/clients", {
      fullName: `Cliente obs31-01 ${S}`,
      email: `obs3101.${S}@test.com`,
      phone: `56${S}00`.slice(0, 10),
      idWorkshop: ID_WORKSHOP,
      createdBy: MECHANIC_ID,
    });
    const clientId = idOf(cliente.data);
    const auto = await call(request, "post", "/cars", {
      clientId, brand: "Nissan", model: "Versa", year: 2020,
      vin: `O31VIN${S}00000000`.slice(0, 17), codeCar: `O31-${S.slice(-5)}`,
      color: "Gris", fuel: "Gasolina", transmition: "Manual", km: 45000,
    });
    const os = await call(request, "post", "/entries", {
      idWorkshop: ID_WORKSHOP, clientId, carId: idOf(auto.data),
      assigned_mechanic: MECHANIC_ID, status: 1,
      observations: "spec OBS31-01 (flujo de estados al aprobar)",
      registerDate: Date.now(), approvalState: "EN ESPERA",
    });
    expect(os.status, JSON.stringify(os.body)).toBeLessThan(300);
    entryId = idOf(os.data);

    const hoja = await call(request, "post", `/entries/${entryId}/service-sheet`, {
      car_items: ["Documentos", "Llave"],
      checks: ["Servicio de Frenos"],
      isCheckAll: false,
      observations: "spec OBS31-01",
      km: 45000,
      fuel_tank: "1/2",
    });
    expect(hoja.status, `la hoja de servicio debe crearse: ${JSON.stringify(hoja.body)}`).toBeLessThan(300);

    // Cotización lista para autorizar, con proveedor y sin stock propio:
    // al aprobar debe generar la orden de compra automática (el disparador
    // exacto del bug).
    const cot = await call(request, "post", `/entries/${entryId}/quotes`, {
      diagnostic: "Frenos: balatas al límite",
      labor: [{ description: "Cambio de balatas", count: 1, unitPrice: 300, cost: 300, subtotal: 300, state: true }],
      parts: [{
        description: `Balatas delanteras ${S}`,
        count: 2,
        unitPrice: PRECIO, cost: PRECIO, subtotal: 2 * PRECIO, state: true,
        costProveedor: 600, utilidad: 41.67,
        supplierId: `SUP-${S}`, supplierName: "Refaccionaria ACME",
        availability: "VERDE",
      }],
      status: 2,
      clientBringsParts: false,
      stage: "COTIZACION",
    });
    expect(cot.status, JSON.stringify(cot.body)).toBeLessThan(300);
    quoteId = idOf(cot.data);
  });

  test("1) EL CASO DE ROBERTO: aprobar deja el auto EN ESPERA (no Refacciones)", async ({ request }) => {
    const ap = await call(request, "post", `/entries/${entryId}/quotes/${quoteId}/approve-concepts`, {
      approvedParts: [0],
      approvedLabor: [0],
    });
    expect(ap.status, JSON.stringify(ap.body)).toBeLessThan(300);

    const { statusService } = await estadoDeLaOS(request);
    expect(statusService, "al aprobar, la OS debe quedar EN ESPERA (el bug la mandaba a REFACCIONES)").toBe("EN ESPERA");
  });

  // NOTA: la generación AUTOMÁTICA de órdenes al aprobar necesita inventario
  // sembrado (reserveQuoteParts) y su bloque va envuelto en un try/catch que no
  // bloquea la aprobación. OBS31-01 es sobre la MÁQUINA DE ESTADOS, así que aquí
  // se crea la orden explícitamente por API y se recibe: eso ejercita los dos
  // cambios del fix sin depender del sembrado.
  test("2) crear una orden de compra ligada a la OS NO mueve el estado (sigue EN ESPERA)", async ({ request }) => {
    const po = await call(request, "post", "/purchase-orders", {
      idWorkshop: ID_WORKSHOP,
      supplierId: `SUP-${S}`,
      entryId,
      notes: "spec OBS31-01",
      items: [{ description: `Balatas delanteras ${S}`, qty: 2, unitCost: 600 }],
    });
    expect(po.status, JSON.stringify(po.body)).toBeLessThan(300);
    poId = idOf(po.data);
    expect(poId, "la orden de compra debe crearse").toBeTruthy();

    const { statusService } = await estadoDeLaOS(request);
    expect(statusService, "crear la orden NO debe avanzar la etapa (era el bug)").toBe("EN ESPERA");
  });

  test("3) recepción PARCIAL → REFACCIONES (y repairReadiness PARCIAL)", async ({ request }) => {
    const rec = await call(request, "post", `/purchase-orders/${poId}/receive`, {
      items: [{ index: 0, received: 1 }], // llega 1 de 2
    });
    expect(rec.status, JSON.stringify(rec.body)).toBeLessThan(300);

    const { statusService, repairReadiness } = await estadoDeLaOS(request);
    expect(statusService, "el abastecimiento parcial mueve el auto a REFACCIONES").toBe("REFACCIONES");
    expect(repairReadiness).toBe("PARCIAL");
  });

  test("4) recibir TODO lo pendiente de la OS → readiness COMPLETO, sin retroceder de etapa", async ({ request }) => {
    // La OS puede tener más de una orden (la que se autogeneró al aprobar + la
    // creada a mano). COMPLETO exige que TODAS estén recibidas.
    await recibirTodoPendiente(request);

    const { statusService, repairReadiness } = await estadoDeLaOS(request);
    expect(repairReadiness, "con todas las órdenes recibidas el abastecimiento es COMPLETO").toBe("COMPLETO");
    expect(statusService, "sigue en REFACCIONES (la máquina nunca regresa)").toBe("REFACCIONES");
  });
});
