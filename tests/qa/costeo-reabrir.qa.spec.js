const { test, expect } = require("@playwright/test");
const { modo } = require("../../adminFlex");
const { authHeaders } = require("#apiToken");

/**
 * ─────────────────────────────────────────────────────────────────────────
 * REABRIR Y CORREGIR UN COSTEO  @api
 *
 * Cubre los puntos n17 y n18 del BACKLOG_TECNICO por el lado del API:
 *
 *   n17 — La tarjeta de la OS no tenía chip de Costeo, entre otras cosas
 *         porque no había forma barata de saber si la OS ya estaba costeada
 *         sin abrir la subcolección de cotizaciones. Ahora el backend
 *         denormaliza `hasCosteo` en la entrada al escribir una cotización
 *         en etapa COSTEO.
 *
 *   n18 — Reabrir el Costeo creaba una SEGUNDA cotización para la misma OS
 *         (y con dos, al aprobar salía la pantalla de selección oficial en
 *         vez de aprobar directo). Ahora corregir es un PUT sobre la misma,
 *         y el merge por campo conserva lo que no viene en el body.
 *
 * CÓMO CORRE (igual que los demás gemelos de qa/):
 *   EMULADORES: emuladores + backend local + `node seed_emulator_user.js`
 *     npx playwright test --project=qa tests/qa/costeo-reabrir.qa.spec.js
 *   REFAC: $env:AUTH_REAL="1"; ID_WORKSHOP, SEED_EMAIL, SEED_PASSWORD.
 * ─────────────────────────────────────────────────────────────────────────
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || (modo === "emulador" ? "taller-prueba" : null);
if (!ID_WORKSHOP) {
  throw new Error('Falta ID_WORKSHOP (taller real de refac). Ej: $env:ID_WORKSHOP="05Pf..."');
}
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";

const S = `${String(Date.now()).slice(-7)}`;
const COSTO_PROVEEDOR = 600;
const COSTO_CORREGIDO = 640;
const PRECIO = 850;

let entryId;
let quoteId;

async function call(request, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: await authHeaders(),
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json, data: json?.data ?? json };
}
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

/** Cuántas cotizaciones tiene la OS (lo que delata el duplicado del punto n18). */
async function cuantasCotizaciones(request) {
  const r = await call(request, "get", `/entries/${entryId}/quotes?limit=50`);
  const bloque = r.data?.descripcion && typeof r.data.descripcion === "object" ? r.data.descripcion : r.data;
  return (bloque?.quotes || []).length;
}

// OJO con el nombre: el campo es `costProveedor` (sin la "o" de "costo").
// La misma confusion dejo `costProveedor` fuera de SENSITIVE_FIELDS y por eso
// el Asesor venia viendo el costo de proveedor (backlog n15).
const cuerpoCosteo = (costoProveedor) => ({
  diagnostic: "Frenos: balatas al límite",
  labor: [{ description: "Cambio de balatas", count: 1, unitPrice: "", cost: "", subtotal: 0, state: false }],
  parts: [{
    description: "Balatas delanteras",
    count: 2,
    unitPrice: PRECIO,
    cost: PRECIO,
    subtotal: 2 * PRECIO,
    state: true,
    costProveedor: costoProveedor,
    utilidad: 41.67,
    supplierId: `SUP-${S}`,
    supplierName: "Refaccionaria ACME",
    availability: "VERDE",
  }],
  status: 2,
  clientBringsParts: false,
  stage: "COSTEO",
});

test.describe.configure({ mode: "serial" });

test.describe("Reabrir y corregir un costeo @api", () => {
  test("crear el costeo marca `hasCosteo` en la OS (punto n17)", async ({ request }) => {
    const cliente = await call(request, "post", "/clients", {
      fullName: `Cliente reabrir ${S}`,
      email: `reabrir.${S}@test.com`,
      phone: `55${S}00`.slice(0, 10),
      idWorkshop: ID_WORKSHOP,
      createdBy: MECHANIC_ID,
    });
    const clientId = idOf(cliente.data);
    const auto = await call(request, "post", "/cars", {
      clientId, brand: "Nissan", model: "March", year: 2019,
      vin: `RBVIN${S}000000`.slice(0, 17), codeCar: `RB-${S.slice(-5)}`,
      color: "Rojo", fuel: "Gasolina", transmition: "Manual", km: 60000,
    });
    const os = await call(request, "post", "/entries", {
      idWorkshop: ID_WORKSHOP, clientId, carId: idOf(auto.data),
      assigned_mechanic: MECHANIC_ID, status: 1,
      observations: "spec costeo-reabrir (backlog n17/n18)",
      registerDate: Date.now(), approvalState: "EN ESPERA",
    });
    expect(os.status, JSON.stringify(os.body)).toBeLessThan(300);
    entryId = idOf(os.data);

    // Recién creada, la OS no está costeada.
    const antes = await call(request, "get", `/entries/${entryId}`);
    expect(Boolean(antes.data?.hasCosteo), "una OS nueva no está costeada").toBe(false);

    const cot = await call(request, "post", `/entries/${entryId}/quotes`, cuerpoCosteo(COSTO_PROVEEDOR));
    expect(cot.status, JSON.stringify(cot.body)).toBeLessThan(300);
    quoteId = idOf(cot.data);

    const despues = await call(request, "get", `/entries/${entryId}`);
    expect(
      despues.data?.hasCosteo,
      "punto n17: el chip de Costeo de la tarjeta se pinta con este dato",
    ).toBe(true);
    expect(await cuantasCotizaciones(request)).toBe(1);
  });

  test("corregir el costeo NO crea una segunda cotización (punto n18)", async ({ request }) => {
    const corregido = await call(request, "put", `/entries/${entryId}/quotes/${quoteId}`, {
      ...cuerpoCosteo(COSTO_CORREGIDO),
    });
    expect(corregido.status, JSON.stringify(corregido.body)).toBeLessThan(300);

    expect(
      await cuantasCotizaciones(request),
      "punto n18: reabrir y guardar dejaba una cotización duplicada",
    ).toBe(1);

    const leida = await call(request, "get", `/entries/${entryId}/quotes/${quoteId}`);
    const [partida] = leida.data.parts;
    expect(Number(partida.costProveedor), "la corrección sí debe aplicarse").toBe(COSTO_CORREGIDO);
    expect(partida.supplierId).toBe(`SUP-${S}`);
    // Sigue siendo un costeo: no se le puso número de cotización.
    expect(leida.data.stage).toBe("COSTEO");
  });

  test("una corrección parcial no borra el proveedor ni la utilidad", async ({ request }) => {
    // Lo que manda la pantalla cuando el rol que edita tiene campos censurados.
    const leida = await call(request, "get", `/entries/${entryId}/quotes/${quoteId}`);
    const partes = leida.data.parts.map((p) => ({
      lineId: p.lineId,
      description: p.description,
      count: 3,
      unitPrice: PRECIO,
      cost: PRECIO,
      subtotal: 3 * PRECIO,
      state: true,
    }));
    const r = await call(request, "put", `/entries/${entryId}/quotes/${quoteId}`, {
      diagnostic: leida.data.diagnostic ?? "",
      labor: leida.data.labor ?? [],
      parts: partes,
      status: 2,
      clientBringsParts: false,
      stage: "COSTEO",
    });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);

    const final = await call(request, "get", `/entries/${entryId}/quotes/${quoteId}`);
    const [partida] = final.data.parts;
    expect(Number(partida.count), "sí se aplica lo que cambió").toBe(3);
    expect(Number(partida.costProveedor)).toBe(COSTO_CORREGIDO);
    expect(partida.supplierId).toBe(`SUP-${S}`);
    expect(Number(partida.utilidad)).toBe(41.67);
    expect(await cuantasCotizaciones(request)).toBe(1);
  });
});
