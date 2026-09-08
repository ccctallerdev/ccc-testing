const { test, expect } = require("@playwright/test");
const { modo } = require("../../adminFlex");
const { authHeaders } = require("#apiToken");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OBS31-03 — "Ingreso Parcial" (anticipos) siempre en ceros
 * SPEC DE REPRODUCCIÓN (nuevo): primero demuestra el bug, luego valida el fix.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lo que reportó Roberto (31-ago): todos los autos del taller dieron anticipo
 * y el KPI "Ingreso parcial (anticipos)" del Centro de Control marca $0.
 *
 * Hipótesis A VERIFICAR con este spec (leída del código, no confirmada aún):
 *   - El dashboard suma `entries.officialQuoteAdvance`, una FOTO que solo se
 *     escribe al APROBAR (applyApprovedSelection) con el `quote.advance` de
 *     ese momento.
 *   - Registrar un anticipo después (POST /entries/:id/quotes/:qid/advances →
 *     addQuoteAdvancePayment) actualiza `quote.advance` pero NUNCA la foto.
 *   - Flujo operativo real: se aprueba sin anticipo y los anticipos se
 *     registran después → la foto queda en 0 → KPI en ceros.
 *
 * CONTRA EL CÓDIGO DE HOY se espera: caso 2 VERDE (la foto funciona) y
 * caso 3 ROJO (el anticipo posterior no se refleja) = bug reproducido.
 * Tras el fix, los 4 casos deben quedar en verde.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"
 *   $env:AUTH_REAL="1"; $env:SKIP_SEED="1"
 *   $env:ID_WORKSHOP="G85FhlhedkD4L4CEDWvW"
 *   $env:SEED_EMAIL="rsv_gpa@outlook.com"; $env:SEED_PASSWORD="..."
 *   npx playwright test --project=qa tests/qa/OBS31-03_anticipos-dashboard.api.spec.js
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || (modo === "emulador" ? "taller-prueba" : null);
if (!ID_WORKSHOP) throw new Error('Falta ID_WORKSHOP. Ej: $env:ID_WORKSHOP="G85F..."');
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";
const S = `${String(Date.now()).slice(-7)}`;

const ANTICIPO_EN_COTIZACION = 500; // capturado ANTES de aprobar (la foto)
const ANTICIPO_POSTERIOR = 300;     // registrado DESPUÉS de aprobar (el bug)

let entryId, quoteId, base = null;

async function call(request, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: await authHeaders(),
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json, data: json?.data ?? json };
}
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

async function ingresoParcial(request) {
  const r = await call(request, "get", `/dashboard?idWorkshop=${ID_WORKSHOP}`);
  expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
  const v = Number(r.data?.finance?.partialIncome);
  expect(Number.isFinite(v), "finance.partialIncome debe existir en el dashboard").toBe(true);
  return v;
}

test.describe.configure({ mode: "serial" });

test.describe("OBS31-03 · el KPI de anticipos refleja lo cobrado @api", () => {
  test("0) línea base del KPI y OS nueva con cotización (anticipo capturado en la cotización)", async ({ request }) => {
    base = await ingresoParcial(request);

    const cliente = await call(request, "post", "/clients", {
      fullName: `Cliente obs31-03 ${S}`,
      email: `obs3103.${S}@test.com`,
      phone: `57${S}00`.slice(0, 10),
      idWorkshop: ID_WORKSHOP,
      createdBy: MECHANIC_ID,
    });
    const clientId = idOf(cliente.data);
    const auto = await call(request, "post", "/cars", {
      clientId, brand: "Kia", model: "Rio", year: 2021,
      vin: `O33VIN${S}00000000`.slice(0, 17), codeCar: `O33-${S.slice(-5)}`,
      color: "Blanco", fuel: "Gasolina", transmition: "Manual", km: 30000,
    });
    const os = await call(request, "post", "/entries", {
      idWorkshop: ID_WORKSHOP, clientId, carId: idOf(auto.data),
      assigned_mechanic: MECHANIC_ID, status: 1,
      observations: "spec OBS31-03 (anticipos vs dashboard)",
      registerDate: Date.now(), approvalState: "EN ESPERA",
    });
    expect(os.status, JSON.stringify(os.body)).toBeLessThan(300);
    entryId = idOf(os.data);

    const hoja = await call(request, "post", `/entries/${entryId}/service-sheet`, {
      car_items: ["Documentos"], checks: ["Servicio general"], isCheckAll: false,
      observations: "spec OBS31-03", km: 30000, fuel_tank: "1/2",
    });
    expect(hoja.status, JSON.stringify(hoja.body)).toBeLessThan(300);

    const cot = await call(request, "post", `/entries/${entryId}/quotes`, {
      diagnostic: "Servicio general",
      labor: [{ description: "Mano de obra general", count: 2, unitPrice: 400, cost: 400, subtotal: 800, state: true }],
      parts: [],
      status: 2, clientBringsParts: false, stage: "COTIZACION",
      advance: ANTICIPO_EN_COTIZACION,
    });
    expect(cot.status, JSON.stringify(cot.body)).toBeLessThan(300);
    quoteId = idOf(cot.data);
  });

  test("1) antes de aprobar, el KPI no cambia (solo cuentan OS aprobadas)", async ({ request }) => {
    const v = await ingresoParcial(request);
    expect(v, "una OS sin aprobar no debe sumar al KPI").toBeCloseTo(base, 1);
  });

  test("2) al aprobar, el anticipo capturado en la cotización SÍ entra al KPI (la foto)", async ({ request }) => {
    const ap = await call(request, "post", `/entries/${entryId}/quotes/${quoteId}/approve-concepts`, {
      approvedParts: [], approvedLabor: [0],
    });
    expect(ap.status, JSON.stringify(ap.body)).toBeLessThan(300);

    const v = await ingresoParcial(request);
    expect(v, `el KPI debe subir ${ANTICIPO_EN_COTIZACION} al aprobar`).toBeCloseTo(base + ANTICIPO_EN_COTIZACION, 1);
  });

  test("3) EL CASO DE ROBERTO: un anticipo registrado DESPUÉS de aprobar también entra al KPI", async ({ request }) => {
    const pago = await call(request, "post", `/entries/${entryId}/quotes/${quoteId}/advances`, {
      amount: ANTICIPO_POSTERIOR,
      note: "spec OBS31-03: anticipo posterior a la aprobación",
    });
    expect(pago.status, JSON.stringify(pago.body)).toBeLessThan(300);
    // El anticipo quedó registrado en la cotización:
    expect(Number(pago.data?.quote?.advance)).toBeCloseTo(ANTICIPO_EN_COTIZACION + ANTICIPO_POSTERIOR, 1);

    // …y el KPI del Centro de Control debe reflejarlo:
    const v = await ingresoParcial(request);
    expect(
      v,
      `KPI esperado ${base + ANTICIPO_EN_COTIZACION + ANTICIPO_POSTERIOR}, marcó ${v} — el anticipo posterior no llegó al dashboard (OBS31-03)`,
    ).toBeCloseTo(base + ANTICIPO_EN_COTIZACION + ANTICIPO_POSTERIOR, 1);
  });
});
