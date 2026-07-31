const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * CORE Q11 + Obs#10 — Paquete de expediente:
 *   1. Bitácora statusHistory: cada cambio de etapa queda con timestamp.
 *   2. Expediente cerrado: OS ENTREGADA rechaza cambios al diagnóstico (409)
 *      y la UI muestra el candado / oculta edición.
 *   3. Historial de cotizaciones visible tras la aprobación (oficial marcada).
 *   4. Índice de OS del vehículo con acceso a cada expediente.
 *
 * PRERREQUISITOS: emuladores + backend + frontend (global-setup siembra admin).
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC = "mecanico-prueba";
const ADMIN_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const ADMIN_PASSWORD = process.env.SEED_PASSWORD || "prueba123";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function call(request, method, path, body, { allowFail = false } = {}) {
  // Q20: la API blindada exige el token firmado en CADA llamada.
  const res = await request[method](`${API}${path}`, { headers: await authHeaders(), ...(body ? { data: body } : {}) });
  if (!res.ok() && !allowFail) {
    throw new Error(`${method.toUpperCase()} ${path} → ${res.status()}: ${await res.text()}`);
  }
  const json = await res.json().catch(() => null);
  return { status: res.status(), data: json?.data ?? json };
}
const post = async (r, p, b, o) => (await call(r, "post", p, b, o));
const put = async (r, p, b, o) => (await call(r, "put", p, b, o));
const getJson = async (r, p) => (await call(r, "get", p)).data;
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

let seq = 10;
async function makeCarWithClient(request, tag) {
  const s = `${String(Date.now()).slice(-6)}${seq++}`;
  const client = (await post(request, "/clients", {
    fullName: `Cliente Q11 ${tag} ${s}`,
    email: `q11.${tag}.${s}@test.com`,
    phone: `57${s}`,
    idWorkshop: ID_WORKSHOP,
    createdBy: MECHANIC,
  })).data;
  const car = (await post(request, "/cars", {
    clientId: idOf(client),
    brand: "Toyota",
    model: `Corolla ${tag}`,
    year: 2023,
    vin: `QO${tag}${s}000000000`.slice(0, 17),
    codeCar: `QO${tag}${s.slice(-4)}`.slice(0, 8),
    color: "Gris",
    fuel: "Gasolina",
    transmition: "Automática",
    km: 20000,
  })).data;
  return { clientId: idOf(client), carId: idOf(car), s };
}

async function makeApprovedOs(request, { clientId, carId }, tag) {
  const entry = (await post(request, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId,
    carId,
    assigned_mechanic: MECHANIC,
    status: 1,
    observations: `Q11 ${tag}`,
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  })).data;
  const entryId = idOf(entry);
  await post(request, `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos"],
    checks: ["Servicio de Frenos"],
    isCheckAll: false,
    observations: `Q11 ${tag}`,
    km: 20000,
    fuel_tank: "1/2",
  });
  await post(request, `/entries/${entryId}/quotes`, {
    diagnostic: `Q11 ${tag}`,
    labor: [{ description: "Mano de obra", count: 1, cost: 500, subtotal: 500 }],
    parts: [],
    status: 2,
    stage: "COTIZACION",
  });
  const quotes = (await getJson(request, `/entries/${entryId}/quotes?limit=10`))?.quotes ?? [];
  const sheets = (await getJson(request, `/entries/${entryId}/service-sheet?limit=10`))?.serviceSheets ?? [];
  await put(request, `/entries/${entryId}/approve-selection`, {
    approvedQuoteId: idOf(quotes[0]),
    approvedServiceSheetId: idOf(sheets[0]),
  });
  await put(request, `/entries/${entryId}`, { approvalState: "APROBADA" });
  // Diagnóstico base: sin él la OS no puede ENTREGARSE (regla Q11).
  await post(request, `/entries/${entryId}/diagnostics`, {
    generalObservations: `Diagnóstico base ${tag}`,
    findings: [
      {
        system: "Frenos",
        finding: "Revisión general",
        severity: "VERDE",
      },
    ],
  });
  return { entryId, os: entry?.sheet, officialQuoteId: idOf(quotes[0]) };
}

async function login(page, email, password) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });
}

// ── 1. Bitácora de etapas ────────────────────────────────────────────────────

test("Q11 API: statusHistory registra cada etapa con timestamp y en orden", { tag: ["@api"] }, async ({
  request,
}) => {
  test.setTimeout(90_000);
  const base = await makeCarWithClient(request, "H");
  const { entryId } = await makeApprovedOs(request, base, "H");

  await post(request, `/entries/${entryId}/production/start`);
  await post(request, `/entries/${entryId}/production/finish`);
  await put(request, `/entries/${entryId}`, { statusService: "LAVADO" });

  const entry = await getJson(request, `/entries/${entryId}`);
  const history = entry?.statusHistory ?? [];
  const stages = history.map((h) => h.status);
  expect(stages).toEqual([
    "EN ESPERA",
    "EN REPARACION",
    "CONTROL DE CALIDAD",
    "LAVADO",
  ]);
  // Timestamps presentes y no decrecientes.
  for (let i = 0; i < history.length; i++) {
    expect(history[i].at, `timestamp de ${stages[i]}`).toBeGreaterThan(0);
    if (i > 0) expect(history[i].at).toBeGreaterThanOrEqual(history[i - 1].at);
  }
});

// ── 2. Expediente cerrado (ENTREGADO = solo lectura) ─────────────────────────

test("Q11: OS entregada rechaza cambios al diagnóstico (API 409) y la UI muestra el candado", { tag: ["@ui"] }, async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const base = await makeCarWithClient(request, "C");
  const { entryId } = await makeApprovedOs(request, base, "C");

  // Diagnóstico creado ANTES de entregar (flujo normal).
  const diag = (await post(request, `/entries/${entryId}/diagnostics`, {
    generalObservations: "Diagnóstico previo a la entrega",
    findings: [
      {
        system: "Frenos",
        component: "Balatas",
        finding: "Desgaste visible",
        severity: "AMARILLO",
        recommendation: "Reemplazo preventivo",
      },
    ],
  })).data;
  const diagnosticId = idOf(diag);

  // Entregar el vehículo cierra el expediente.
  await put(request, `/entries/${entryId}`, { statusService: "ENTREGADO" });

  // API: editar, crear o borrar diagnósticos debe rechazarse con 409.
  const putRes = await put(
    request,
    `/entries/${entryId}/diagnostics/${diagnosticId}`,
    { generalObservations: "Intento de edición tras entrega" },
    { allowFail: true },
  );
  expect(putRes.status).toBe(409);

  const postRes = await post(
    request,
    `/entries/${entryId}/diagnostics`,
    {
      findings: [
        { system: "Motor", finding: "Nuevo hallazgo", severity: "ROJO" },
      ],
    },
    { allowFail: true },
  );
  expect(postRes.status).toBe(409);

  // También cotizaciones y hojas de servicio quedan intocables.
  const newQuote = await post(
    request,
    `/entries/${entryId}/quotes`,
    {
      diagnostic: "Intento post-entrega",
      labor: [{ description: "Extra", count: 1, cost: 100, subtotal: 100 }],
      parts: [],
      status: 2,
      stage: "COTIZACION",
    },
    { allowFail: true },
  );
  expect(newQuote.status).toBe(409);

  const newSheet = await post(
    request,
    `/entries/${entryId}/service-sheet`,
    {
      car_items: ["Documentos"],
      checks: ["Servicio de Frenos"],
      isCheckAll: false,
      observations: "Intento post-entrega",
      km: 20001,
      fuel_tank: "1/2",
    },
    { allowFail: true },
  );
  expect(newSheet.status).toBe(409);

  // El diagnóstico original sigue intacto.
  const fresh = await getJson(request, `/entries/${entryId}/diagnostics/${diagnosticId}`);
  expect(fresh?.generalObservations).toBe("Diagnóstico previo a la entrega");

  // UI: expediente con candado y diagnóstico sin botones de edición.
  await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`/expediente/${entryId}`);
  await expect(page.getByText(/expediente cerrado/i)).toBeVisible({ timeout: 15000 });

  await page.goto(`/diagnostico-vista/${entryId}`);
  await expect(page.getByText(/solo lectura/i)).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: /nuevo diagnóstico/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^editar$/i })).toHaveCount(0);
  // Las acciones de lectura siguen disponibles.
  await expect(page.getByRole("button", { name: /cliente/i }).first()).toBeVisible();
});

// ── 3. Historial de cotizaciones tras aprobación ─────────────────────────────

test("Q11 UI: tras aprobar se ve el historial de cotizaciones con la oficial marcada", { tag: ["@ui"] }, async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const base = await makeCarWithClient(request, "Q");
  const { entryId, officialQuoteId } = await makeApprovedOs(request, base, "Q");

  // Segunda cotización (no oficial) para que el historial tenga más de una.
  await post(request, `/entries/${entryId}/quotes`, {
    diagnostic: "Alternativa con refacción original",
    labor: [{ description: "Mano de obra premium", count: 1, cost: 900, subtotal: 900 }],
    parts: [],
    status: 2,
    stage: "COTIZACION",
  });

  await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`/cotizacion-vista/${entryId}?quoteId=${officialQuoteId}`);

  await expect(
    page.getByText(/historial de cotizaciones de esta os/i),
  ).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/^Oficial$/).first()).toBeVisible({ timeout: 15000 });
});

// ── 4. Índice de OS del vehículo ─────────────────────────────────────────────

test("Q11 UI: el expediente lista todas las OS del vehículo con acceso a cada una", { tag: ["@ui"] }, async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const base = await makeCarWithClient(request, "I");
  const os1 = await makeApprovedOs(request, base, "I1");
  // La primera se entrega para que el mismo auto pueda abrir otra OS.
  await put(request, `/entries/${os1.entryId}`, { statusService: "ENTREGADO" });
  const os2 = await makeApprovedOs(request, base, "I2");

  await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`/expediente/${os2.entryId}`);

  await expect(page.getByText(/índice de órdenes del vehículo/i)).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByText(`OS ${os1.os}`).first()).toBeVisible();
  await expect(page.getByText(`OS ${os2.os}`).first()).toBeVisible();
  await expect(page.getByText(/estás aquí/i)).toBeVisible();

  // Saltar al expediente de la otra OS.
  await page.getByRole("button", { name: /ver expediente/i }).first().click();
  await page.waitForURL((u) => u.pathname === `/expediente/${os1.entryId}`, {
    timeout: 15000,
  });
  await expect(page.getByText(/expediente cerrado/i)).toBeVisible({ timeout: 15000 });
});
