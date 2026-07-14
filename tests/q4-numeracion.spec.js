const { test, expect } = require("@playwright/test");
const { authHeaders } = require("../apiToken");

/**
 * Q4 / CORE #31 (Documento Unificado): numeración de cotizaciones por OS.
 *   - Solo cotizaciones CON PRECIOS reciben número (el costeo no genera folio).
 *   - Secuencia por OS: 1, 2, 3… (en UI se muestra OS154-01, 02…).
 *   - Reinicia con cada OS.
 *   - El número no cambia al re-editar la cotización.
 *
 * Pruebas de API (sin navegador), contra los emuladores.
 *
 * PRERREQUISITOS:
 *   1) Emuladores:  cd ccc-backend && npm run serve
 *   2) Backend:     cd ccc-backend && npm run backend
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";

// ── Helpers de API ───────────────────────────────────────────────────────────

async function post(request, path, body) {
  const res = await request.post(`${API}${path}`, { data: body, headers: await authHeaders() });
  if (!res.ok()) {
    throw new Error(`POST ${path} → ${res.status()}: ${await res.text()}`);
  }
  const json = await res.json().catch(() => null);
  return json?.data ?? json;
}

async function put(request, path, body) {
  const res = await request.put(`${API}${path}`, { data: body, headers: await authHeaders() });
  if (!res.ok()) {
    throw new Error(`PUT ${path} → ${res.status()}: ${await res.text()}`);
  }
  const json = await res.json().catch(() => null);
  return json?.data ?? json;
}

async function getJson(request, path) {
  const res = await request.get(`${API}${path}`, { headers: await authHeaders() });
  if (!res.ok()) {
    throw new Error(`GET ${path} → ${res.status()}: ${await res.text()}`);
  }
  const json = await res.json().catch(() => null);
  return json?.data ?? json;
}

const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

/** OS mínima (cliente + auto + entrada). */
async function createOs(request) {
  const suffix = `${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;

  const client = await post(request, "/clients", {
    fullName: `Cliente Q4 ${suffix}`,
    email: `q4.${suffix}@test.com`,
    phone: `57${suffix}`,
    idWorkshop: ID_WORKSHOP,
    createdBy: MECHANIC_ID,
  });

  const car = await post(request, "/cars", {
    clientId: idOf(client),
    brand: "Kia",
    model: "Rio",
    year: 2021,
    vin: `Q4VIN${suffix}00000000`.slice(0, 17),
    codeCar: `Q4-${suffix.slice(-5)}`,
    color: "Negro",
    fuel: "Gasolina",
    transmition: "Manual",
    km: 30000,
  });

  const entry = await post(request, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId: idOf(client),
    carId: idOf(car),
    assigned_mechanic: MECHANIC_ID,
    status: 1,
    observations: "Fixture Q4 (numeración)",
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  });

  return { entryId: idOf(entry), os: entry?.sheet };
}

const costeoBody = () => ({
  diagnostic: "Costeo Q4 (sin precios)",
  labor: [{ description: "Trabajo por cotizar", count: 1, cost: "", subtotal: 0 }],
  parts: [],
  status: 2,
  stage: "COSTEO",
});

const pricedBody = (n) => ({
  diagnostic: `Cotización Q4 #${n}`,
  labor: [{ description: `Mano de obra ${n}`, count: 1, cost: 700, subtotal: 700 }],
  parts: [],
  status: 2,
  stage: "COTIZACION",
});

// ── Tests ────────────────────────────────────────────────────────────────────

test("Q4: el costeo no genera número; al convertirse en cotización recibe el 01", async ({
  request,
}) => {
  const { entryId } = await createOs(request);

  // Costeo (sin precios): NO debe tener número.
  const costeo = await post(request, `/entries/${entryId}/quotes`, costeoBody());
  const costeoId = idOf(costeo);
  expect(costeo?.quoteNumber ?? null).toBeNull();

  // Se convierte en cotización (editor manda stage COTIZACION + precios): número 1.
  const converted = await put(request, `/entries/${entryId}/quotes/${costeoId}`, {
    labor: [{ description: "Mano de obra", count: 1, cost: 900, subtotal: 900 }],
    status: 2,
    stage: "COTIZACION",
  });
  expect(converted?.quoteNumber).toBe(1);

  // Re-editarla NO cambia su número ni avanza la secuencia.
  const reedited = await put(request, `/entries/${entryId}/quotes/${costeoId}`, {
    labor: [{ description: "Mano de obra ajustada", count: 1, cost: 950, subtotal: 950 }],
    status: 2,
    stage: "COTIZACION",
  });
  expect(reedited?.quoteNumber).toBe(1);

  const entry = await getJson(request, `/entries/${entryId}`);
  expect(Number(entry?.quoteSeq)).toBe(1);
});

test("Q4: la secuencia avanza por cotización con precios (01, 02) e ignora costeos intermedios", async ({
  request,
}) => {
  const { entryId } = await createOs(request);

  const q1 = await post(request, `/entries/${entryId}/quotes`, pricedBody(1));
  expect(q1?.quoteNumber).toBe(1);

  // Un costeo en medio no consume número.
  const c = await post(request, `/entries/${entryId}/quotes`, costeoBody());
  expect(c?.quoteNumber ?? null).toBeNull();

  const q2 = await post(request, `/entries/${entryId}/quotes`, pricedBody(2));
  expect(q2?.quoteNumber).toBe(2);
});

test("Q4: la numeración reinicia con cada OS", async ({ request }) => {
  const osA = await createOs(request);
  const osB = await createOs(request);

  const qa = await post(request, `/entries/${osA.entryId}/quotes`, pricedBody(1));
  const qa2 = await post(request, `/entries/${osA.entryId}/quotes`, pricedBody(2));
  const qb = await post(request, `/entries/${osB.entryId}/quotes`, pricedBody(1));

  expect(qa?.quoteNumber).toBe(1);
  expect(qa2?.quoteNumber).toBe(2);
  // La OS B arranca en 1 otra vez, sin importar lo emitido en la OS A.
  expect(qb?.quoteNumber).toBe(1);
});
