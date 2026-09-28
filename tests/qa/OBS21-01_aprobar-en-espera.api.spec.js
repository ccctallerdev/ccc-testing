const { test, expect } = require("@playwright/test");
const { modo } = require("../../adminFlex");
const { authHeaders } = require("#apiToken");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OBS21-01 — Al aprobar, el auto cae en "Refacciones" (no en "En espera")
 * PRUEBAS DE API (nuevas, no recicladas) — ESCRITAS PARA FALLAR ANTES DEL FIX
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Síntoma (Roberto, OS 1130, 20-sep): la línea de tiempo marca "Refacciones"
 * a las 20:05, ANTES de "Cotización aprobada 20:05", y no aparece "En espera".
 * La OS traía 3 partidas y una era de INVENTARIO.
 *
 * Causa por lectura de código (este spec la confirma en rojo):
 *   entries.js · approve-concepts → applyApprovedSelection() genera primero la
 *   orden `origin: INVENTORY` (nace RECIBIDA) → PurchaseOrders.create() llama
 *   syncRepairReadinessForEntry → PARCIAL → advanceStatusService(REFACCIONES).
 *   Solo DESPUÉS el endpoint intenta EN_ESPERA, y la máquina "solo hacia
 *   adelante" lo descarta. Además approvedDate se escribe después, así que la
 *   línea de tiempo ordena "Refacciones" antes de "Cotización aprobada".
 *
 * OBS31-01 NO regresó en su causa original (órdenes de PROVEEDOR): el caso C es
 * el control y debe pasar en verde hoy. Su spec no sembraba inventario, por eso
 * nunca vio este camino.
 *
 * Casos:
 *   A1  con 1 pieza de inventario + 2 de proveedor: en la bitácora EN ESPERA va
 *       ANTES que REFACCIONES y REFACCIONES no precede a "Cotización aprobada".
 *       (No depende de la duda D30.)
 *   A2  ese mismo caso: el auto queda EN ESPERA.  → depende de D30 (propuesta a).
 *   B   TODAS las piezas de inventario: puede acabar en REFACCIONES, pero la
 *       bitácora debe mostrar EN ESPERA antes.  (No depende de D30.)
 *   C   CONTROL: solo proveedor → EN ESPERA y sin REFACCIONES en la bitácora.
 *   D   camino del LISTADO (botón "Aprobar" de Entrada.jsx): approve-selection
 *       y DESPUÉS PUT approvalState=APROBADA. Todo de inventario: EN ESPERA
 *       antes que REFACCIONES y nada antes de "Cotización aprobada".
 *   E   approve-selection SIN aprobar (guardar la selección oficial): la OS no
 *       debe llegar a REFACCIONES — sin aprobación no hay abastecimiento que
 *       mueva el auto.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"
 *   $env:AUTH_REAL="1"; $env:SKIP_SEED="1"
 *   $env:ID_WORKSHOP="<taller de pruebas de refac>"
 *   $env:SEED_EMAIL="<correo del Dueño>"; $env:SEED_PASSWORD="<contraseña>"
 *   npx playwright test --project=qa tests/qa/OBS21-01_aprobar-en-espera.api.spec.js
 *
 * Modo `default` (no serial): cada caso arma su propia OS y puede fallar solo.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || (modo === "emulador" ? "taller-prueba" : null);
if (!ID_WORKSHOP) {
  throw new Error('Falta ID_WORKSHOP (taller real de refac). Ej: $env:ID_WORKSHOP="05Pf..."');
}
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";

let contador = 0;
// 7 dígitos únicos por caso y por corrida (teléfono = 10 dígitos exactos).
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

/** Artículo de inventario con existencia suficiente (se surte al aprobar). */
async function crearArticulo(request, S, nombre) {
  const r = await call(request, "post", "/inventory", {
    idWorkshop: ID_WORKSHOP,
    name: `${nombre} ${S}`,
    sku: `O21-${S}`,
    cost: 200,
    price: 350,
    stock: 10,
  });
  ok(r, "alta del artículo de inventario");
  return idOf(r.data);
}

const pieza = (desc, count, extra = {}) => ({
  description: desc,
  count,
  unitPrice: 500,
  cost: 500,
  subtotal: 500 * count,
  state: true,
  costProveedor: 300,
  utilidad: 40,
  availability: "VERDE",
  ...extra,
});

/**
 * Arma cliente + auto + OS + hoja + cotización con las partidas dadas y la
 * APRUEBA completa (approve-concepts). Devuelve el estado final de la OS.
 */
async function armarYAprobar(request, S, partes, via = "conceptos") {
  const cliente = await call(request, "post", "/clients", {
    fullName: `Cliente obs21-01 ${S}`,
    email: `obs2101.${S}@test.com`,
    phone: `55${S}0`,
    idWorkshop: ID_WORKSHOP,
    createdBy: MECHANIC_ID,
  });
  ok(cliente, "alta del cliente");
  const clientId = idOf(cliente.data);
  const auto = await call(request, "post", "/cars", {
    clientId, brand: "Nissan", model: "Versa", year: 2020,
    vin: `O21VIN${S}0000000`.slice(0, 17), codeCar: `O21-${S.slice(-5)}`,
    color: "Gris", fuel: "Gasolina", transmition: "Manual", km: 45000,
  });
  ok(auto, "alta del auto");
  const os = await call(request, "post", "/entries", {
    idWorkshop: ID_WORKSHOP, clientId, carId: idOf(auto.data),
    assigned_mechanic: MECHANIC_ID, status: 1,
    observations: "spec OBS21-01 (aprobar deja EN ESPERA)",
    registerDate: Date.now(), approvalState: "EN ESPERA",
  });
  ok(os, "alta de la OS");
  const entryId = idOf(os.data);
  const hoja = await call(request, "post", `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos", "Llave"], checks: ["Servicio de Frenos"],
    isCheckAll: false, observations: "spec OBS21-01", km: 45000, fuel_tank: "1/2",
  });
  ok(hoja, "hoja de servicio");
  const sheetId = idOf(hoja.data);

  const cot = await call(request, "post", `/entries/${entryId}/quotes`, {
    diagnostic: "Frenos y suspensión",
    labor: [{ description: "Mano de obra", count: 1, unitPrice: 300, cost: 300, subtotal: 300, state: true }],
    parts: partes,
    status: 2, clientBringsParts: false, stage: "COTIZACION",
  });
  ok(cot, "cotización");
  const quoteId = idOf(cot.data);

  if (via === "conceptos") {
    ok(await call(request, "post", `/entries/${entryId}/quotes/${quoteId}/approve-concepts`, {
      approvedParts: partes.map((_, i) => i),
      approvedLabor: [0],
    }), "approve-concepts");
  } else {
    // Botón "Aprobar" del listado (Entrada.jsx): primero la selección oficial…
    ok(await call(request, "put", `/entries/${entryId}/approve-selection`, {
      approvedQuoteId: quoteId,
      approvedServiceSheetId: sheetId,
    }), "approve-selection");
    // …y después la aprobación por PUT, con la fecha que pone el front.
    if (via === "listado") {
      ok(await call(request, "put", `/entries/${entryId}`, {
        approvalState: "APROBADA",
        approvedDate: new Date().toISOString(),
        rejectedDate: "",
      }), "PUT approvalState APROBADA");
    }
  }

  const r = await call(request, "get", `/entries/${entryId}`);
  const e = r.data?.descripcion && typeof r.data.descripcion === "object" ? r.data.descripcion : r.data;
  const hist = (Array.isArray(e?.statusHistory) ? e.statusHistory : []).slice().sort((a, b) => a.at - b.at);
  const idx = (estado) => hist.findIndex((h) => h.status === estado);
  return {
    entryId,
    statusService: e?.statusService ?? null,
    repairReadiness: e?.repairReadiness ?? null,
    approvedAt: e?.approvedDate ? new Date(e.approvedDate).getTime() : null,
    hist,
    iEspera: idx("EN ESPERA"),
    iRefacc: idx("REFACCIONES"),
    resumen: JSON.stringify(hist.map((h) => `${h.status}@${h.at}`)),
  };
}

test.describe("OBS21-01 · aprobar deja EN ESPERA (con piezas de inventario) @api", () => {
  test("A1) mixto (1 de inventario + 2 de proveedor): EN ESPERA va antes que REFACCIONES y REFACCIONES no precede a 'Cotización aprobada'", async ({ request }) => {
    const S = unico();
    const inv = await crearArticulo(request, S, "Filtro de aceite");
    const r = await armarYAprobar(request, S, [
      pieza(`Filtro de aceite ${S}`, 1, { inventoryId: inv }),
      pieza(`Balatas ${S}`, 2, { supplierId: `SUP-${S}`, supplierName: "Refaccionaria ACME" }),
      pieza(`Discos ${S}`, 2, { supplierId: `SUP-${S}`, supplierName: "Refaccionaria ACME" }),
    ]);

    expect(r.iEspera, `la bitácora debe traer EN ESPERA (Roberto: "sin En espera"). Bitácora: ${r.resumen}`).toBeGreaterThanOrEqual(0);
    if (r.iRefacc >= 0) {
      expect(r.iEspera, `EN ESPERA debe ir ANTES que REFACCIONES. Bitácora: ${r.resumen}`).toBeLessThan(r.iRefacc);
      // Línea de tiempo: "Refacciones" nunca antes de "Cotización aprobada".
      const refAt = r.hist[r.iRefacc].at;
      expect(refAt, `REFACCIONES (${refAt}) no puede ser anterior a "Cotización aprobada" (${r.approvedAt})`).toBeGreaterThanOrEqual(r.approvedAt);
    }
  });

  test("A2) mixto: el auto queda EN ESPERA (D30, propuesta a: hasta que llegue TODO lo pedido)", async ({ request }) => {
    // FALLA ESPERADA hasta que Roberto conteste D30 (doc DUDAS_NEGOCIO_2026-09-25).
    // Hoy rige la regla del 2-sep: abastecimiento PARCIAL → REFACCIONES. Si elige
    // (a), se implementa y se quita esta línea; si elige (b), se invierte la aserción.
    test.fail(true, "D30 pendiente: hoy el abastecimiento PARCIAL mueve el auto a REFACCIONES (regla del 2-sep)");
    const S = unico();
    const inv = await crearArticulo(request, S, "Filtro de aire");
    const r = await armarYAprobar(request, S, [
      pieza(`Filtro de aire ${S}`, 1, { inventoryId: inv }),
      pieza(`Bujías ${S}`, 4, { supplierId: `SUP-${S}`, supplierName: "Refaccionaria ACME" }),
    ]);
    expect(r.statusService, `con piezas aún por llegar del proveedor el auto sigue EN ESPERA. Bitácora: ${r.resumen}`).toBe("EN ESPERA");
  });

  test("B) TODO de inventario: puede llegar a REFACCIONES, pero la bitácora muestra EN ESPERA antes", async ({ request }) => {
    const S = unico();
    const inv = await crearArticulo(request, S, "Pastillas");
    const r = await armarYAprobar(request, S, [pieza(`Pastillas ${S}`, 2, { inventoryId: inv })]);

    expect(r.iEspera, `la bitácora debe traer EN ESPERA. Bitácora: ${r.resumen}`).toBeGreaterThanOrEqual(0);
    if (r.iRefacc >= 0) {
      expect(r.iEspera, `EN ESPERA debe ir ANTES que REFACCIONES. Bitácora: ${r.resumen}`).toBeLessThan(r.iRefacc);
      expect(r.hist[r.iRefacc].at).toBeGreaterThanOrEqual(r.approvedAt);
    }
  });

  test("C) CONTROL (OBS31-01): solo proveedor → EN ESPERA y sin REFACCIONES en la bitácora", async ({ request }) => {
    const S = unico();
    const r = await armarYAprobar(request, S, [
      pieza(`Amortiguadores ${S}`, 2, { supplierId: `SUP-${S}`, supplierName: "Refaccionaria ACME" }),
    ]);
    expect(r.statusService, `Bitácora: ${r.resumen}`).toBe("EN ESPERA");
    expect(r.iRefacc, `no debe haber REFACCIONES en la bitácora. Bitácora: ${r.resumen}`).toBe(-1);
  });

  test("D) camino del LISTADO (approve-selection + PUT APROBADA), todo de inventario: EN ESPERA antes que REFACCIONES", async ({ request }) => {
    const S = unico();
    const inv = await crearArticulo(request, S, "Anticongelante");
    const r = await armarYAprobar(request, S, [pieza(`Anticongelante ${S}`, 1, { inventoryId: inv })], "listado");

    expect(r.iEspera, `la bitácora debe traer EN ESPERA. Bitácora: ${r.resumen}`).toBeGreaterThanOrEqual(0);
    expect(r.approvedAt, "el PUT de aprobación debe dejar approvedDate").toBeTruthy();
    if (r.iRefacc >= 0) {
      expect(r.iEspera, `EN ESPERA debe ir ANTES que REFACCIONES. Bitácora: ${r.resumen}`).toBeLessThan(r.iRefacc);
      const refAt = r.hist[r.iRefacc].at;
      expect(refAt, `REFACCIONES (${refAt}) no puede ser anterior a "Cotización aprobada" (${r.approvedAt})`).toBeGreaterThanOrEqual(r.approvedAt);
    }
  });

  test("E) approve-selection SIN aprobar: la OS no llega a REFACCIONES", async ({ request }) => {
    const S = unico();
    const inv = await crearArticulo(request, S, "Banda");
    const r = await armarYAprobar(request, S, [pieza(`Banda ${S}`, 1, { inventoryId: inv })], "solo-seleccion");

    expect(r.statusService, `sin aprobar, el abastecimiento no mueve el auto. Bitácora: ${r.resumen}`).not.toBe("REFACCIONES");
    expect(r.iRefacc, `no debe haber REFACCIONES en la bitácora. Bitácora: ${r.resumen}`).toBe(-1);
  });
});
