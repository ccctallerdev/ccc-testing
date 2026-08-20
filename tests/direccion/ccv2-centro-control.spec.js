const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * Centro de Control v2 (respuestas del cliente 10-jul):
 *   - P7: ingreso potencial del día = facturado − anticipos.
 *   - Valor Atrapado: $ por bucket de salud.
 *   - Promesas cumplidas del día (entregado hoy con promesa de hoy).
 *   - P4: BLOQUEADO = horas sin avance de etapa (configurable).
 *   - P5/P6: Índice CCC y Comandante visibles en el dashboard.
 *
 * El taller de pruebas es compartido: verificación por DELTAS.
 *
 * PRERREQUISITOS: emuladores + backend + frontend (global-setup siembra admin).
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC = "mecanico-prueba";
const ADMIN_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const ADMIN_PASSWORD = process.env.SEED_PASSWORD || "prueba123";

async function call(request, method, path, body) {
  // Q20: la API blindada exige el token firmado en CADA llamada.
  const res = await request[method](`${API}${path}`, { headers: await authHeaders(), ...(body ? { data: body } : {}) });
  if (!res.ok()) {
    throw new Error(`${method.toUpperCase()} ${path} → ${res.status()}: ${await res.text()}`);
  }
  const json = await res.json().catch(() => null);
  return json?.data ?? json;
}
const post = (r, p, b) => call(r, "post", p, b);
const put = (r, p, b) => call(r, "put", p, b);
const getJson = (r, p) => call(r, "get", p);
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

const dashboard = (r) => getJson(r, `/dashboard?idWorkshop=${ID_WORKSHOP}`);

let seq = 80;
/** OS aprobada con promesa HOY, anticipo y diagnóstico (entregable). */
async function makePromisedOs(request, tag, { advance = 400, total = 1000 } = {}) {
  const s = `${String(Date.now()).slice(-6)}${seq++}`;
  const client = await post(request, "/clients", {
    fullName: `Cliente CC ${tag} ${s}`,
    email: `cc.${tag}.${s}@test.com`,
    phone: `85${s.slice(-8)}0000000000`.slice(0, 10),
    createdBy: MECHANIC,
  });
  const car = await post(request, "/cars", {
    clientId: idOf(client),
    brand: "Renault",
    model: `Kwid ${tag}`,
    year: 2022,
    vin: `CC${tag}${s}000000000`.slice(0, 17),
    codeCar: `CC${tag}${s.slice(-4)}`.slice(0, 8),
    color: "Blanco",
    fuel: "Gasolina",
    transmition: "Manual",
    km: 33000,
  });
  const entry = await post(request, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId: idOf(client),
    carId: idOf(car),
    assigned_mechanic: MECHANIC,
    status: 1,
    observations: `CCv2 ${tag}`,
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  });
  const entryId = idOf(entry);
  await post(request, `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos"],
    checks: ["Servicio de Frenos"],
    isCheckAll: false,
    observations: `CCv2 ${tag}`,
    km: 33000,
    fuel_tank: "1/2",
  });
  // Promesa para HOY (en una hora).
  await post(request, `/entries/${entryId}/quotes`, {
    diagnostic: `CCv2 ${tag}`,
    labor: [{ description: "Servicio", count: 2, cost: total / 2, subtotal: total }],
    parts: [],
    status: 2,
    stage: "COTIZACION",
    advance,
    promiseDate: Date.now() + 60 * 60 * 1000,
  });
  const quotes = (await getJson(request, `/entries/${entryId}/quotes?limit=10`))?.quotes ?? [];
  const sheets = (await getJson(request, `/entries/${entryId}/service-sheet?limit=10`))?.serviceSheets ?? [];
  await put(request, `/entries/${entryId}/approve-selection`, {
    approvedQuoteId: idOf(quotes[0]),
    approvedServiceSheetId: idOf(sheets[0]),
  });
  await put(request, `/entries/${entryId}`, { approvalState: "APROBADA" });
  await post(request, `/entries/${entryId}/diagnostics`, {
    generalObservations: `CCv2 ${tag}`,
    findings: [{ system: "Frenos", finding: "Revisión", severity: "VERDE" }],
  });
  return { entryId };
}

test("CCv2 API: ingreso del día neto de anticipos y promesa CUMPLIDA al entregar hoy", { tag: ["@api"] }, async ({
  request,
}) => {
  test.setTimeout(120_000);
  const base = await dashboard(request);

  const { entryId } = await makePromisedOs(request, "P", { advance: 400, total: 1000 });

  let d = await dashboard(request);
  // P7: facturado +1000, anticipos +400, potencial +600.
  expect(d.execution.totalBilledToday).toBeCloseTo(base.execution.totalBilledToday + 1000, 1);
  expect(d.execution.advancesToday).toBeCloseTo(base.execution.advancesToday + 400, 1);
  expect(d.execution.incomeToday).toBeCloseTo(base.execution.incomeToday + 600, 1);
  // Promesa de hoy registrada, aún sin cumplir.
  expect(d.promises.today).toBe(base.promises.today + 1);
  expect(d.promises.fulfilled).toBe(base.promises.fulfilled);

  // Entregar HOY la promesa de HOY → cumplida.
  await post(request, `/entries/${entryId}/production/start`);
  await post(request, `/entries/${entryId}/production/finish`);
  await put(request, `/entries/${entryId}`, { statusService: "LAVADO" });
  await put(request, `/entries/${entryId}`, { statusService: "ENTREGADO" });

  d = await dashboard(request);
  expect(d.promises.today).toBe(base.promises.today + 1);
  expect(d.promises.fulfilled).toBe(base.promises.fulfilled + 1);
  // El Índice CCC existe y trae desglose auditable.
  expect(d.cccIndex.score).toBeGreaterThanOrEqual(0);
  expect(d.cccIndex.score).toBeLessThanOrEqual(100);
  expect(d.cccIndex.estado).toMatch(/TRANQUILO|BAJO_PRESION|COMPROMETIDO|EMERGENCIA/);
  expect(d.cccIndex.penalties).toBeTruthy();
  // healthValue presente (Valor Atrapado).
  expect(typeof d.healthValue.total).toBe("number");
  // Conteo de clientes para accesos rápidos.
  expect(d.clients.count).toBeGreaterThan(0);
});

test("CCv2 API: sin avance de etapa por más del umbral ⇒ BLOQUEADO con su valor atrapado", { tag: ["@api"] }, async ({
  request,
}) => {
  test.setTimeout(120_000);
  // Umbral de bloqueo bajísimo para simular el estancamiento sin esperar 24h.
  await put(request, `/settings/operating-model?idWorkshop=${ID_WORKSHOP}`, {
    hoursStageBlocked: 0.0001, // ~0.36 s
  });
  try {
    const base = await dashboard(request);
    const { entryId } = await makePromisedOs(request, "B", { advance: 0, total: 2000 });
    // En cola (EN ESPERA) y sin movimiento — supera el umbral en segundos.
    await new Promise((r) => setTimeout(r, 1500));

    const d = await dashboard(request);
    expect(d.health.bloqueado).toBeGreaterThan(base.health.bloqueado);
    expect(d.healthValue.bloqueado).toBeGreaterThanOrEqual(
      base.healthValue.bloqueado + 2000,
    );
    void entryId;
  } finally {
    // Restaurar el umbral para no contaminar otras pruebas.
    await put(request, `/settings/operating-model?idWorkshop=${ID_WORKSHOP}`, {
      hoursStageBlocked: 24,
    });
  }
});

test("CCv2 UI: Comandante, Índice CCC, estado del día y promesas visibles", { tag: ["@ui"] }, async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await makePromisedOs(request, "U");

  await page.goto("/login");
  await page.locator("#email").fill(ADMIN_EMAIL);
  await page.locator("#password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });

  await page.goto("/dashboard");
  // Comandante de Operaciones (P6): saludo + prioridad por reglas.
  await expect(
    page.getByText(/entrega\(s\) comprometida\(s\)/i).first(),
  ).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/prioridad:/i).first()).toBeVisible();
  // Índice CCC (P5) con su estado.
  await expect(page.getByText(/índice ccc \d+/i)).toBeVisible();
  // Estado del día en 3 niveles (P1 propuesta).
  await expect(
    page.getByText(/factible|ajustado|incumplimiento/i).first(),
  ).toBeVisible();
  // Promesas cumplidas del día.
  await expect(page.getByText(/promesas cumplidas hoy/i)).toBeVisible();
  // P7: sublínea de facturado/anticipos.
  await expect(page.getByText(/facturado: .*anticipos:/i)).toBeVisible();
});
