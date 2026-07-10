const { test, expect } = require("@playwright/test");

/**
 * CORE #32–#38 (Q14/Q8) — Contadores por fase mutuamente excluyentes:
 *   - Un auto vive en UNA fase: al entrar a producción sale de "Aprobados";
 *     al ENTREGARSE sale de todos los contadores activos.
 *   - "Entradas" = solo las de hoy (entries.hoy en dashboard).
 *   - Bug #34: getEntries con excludeDelivered no cuenta entregados en
 *     totalDocs/paginación.
 *
 * El taller de pruebas es compartido entre specs, así que TODO se verifica
 * por DELTAS (antes/después), nunca por números absolutos.
 *
 * PRERREQUISITOS: emuladores + backend + frontend (global-setup siembra admin).
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC = "mecanico-prueba";
const ADMIN_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const ADMIN_PASSWORD = process.env.SEED_PASSWORD || "prueba123";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function call(request, method, path, body) {
  const res = await request[method](`${API}${path}`, body ? { data: body } : undefined);
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

let seq = 30;
async function makeApprovedOs(request, tag, { withDiagnostic = true } = {}) {
  const s = `${String(Date.now()).slice(-6)}${seq++}`;
  const client = await post(request, "/clients", {
    fullName: `Cliente Q14 ${tag} ${s}`,
    email: `q14.${tag}.${s}@test.com`,
    phone: `59${s}`,
    idWorkshop: ID_WORKSHOP,
    createdBy: MECHANIC,
  });
  const car = await post(request, "/cars", {
    clientId: idOf(client),
    brand: "Kia",
    model: `Rio ${tag}`,
    year: 2023,
    vin: `QC${tag}${s}000000000`.slice(0, 17),
    codeCar: `QC${tag}${s.slice(-4)}`.slice(0, 8),
    color: "Negro",
    fuel: "Gasolina",
    transmition: "Manual",
    km: 15000,
  });
  const entry = await post(request, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId: idOf(client),
    carId: idOf(car),
    assigned_mechanic: MECHANIC,
    status: 1,
    observations: `Q14 ${tag}`,
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  });
  const entryId = idOf(entry);
  await post(request, `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos"],
    checks: ["Servicio de Frenos"],
    isCheckAll: false,
    observations: `Q14 ${tag}`,
    km: 15000,
    fuel_tank: "1/2",
  });
  await post(request, `/entries/${entryId}/quotes`, {
    diagnostic: `Q14 ${tag}`,
    labor: [{ description: "Mano de obra", count: 1, cost: 650, subtotal: 650 }],
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
  if (withDiagnostic) {
    await post(request, `/entries/${entryId}/diagnostics`, {
      generalObservations: `Diagnóstico Q14 ${tag}`,
      findings: [{ system: "Frenos", finding: "Revisión", severity: "VERDE" }],
    });
  }
  return { entryId };
}

// ── 1. Dashboard: fases mutuamente excluyentes ───────────────────────────────

test("Q14 dashboard: aprobado cuenta UNA vez; sale de Aprobados al producir y de todo al entregar", async ({
  request,
}) => {
  test.setTimeout(120_000);

  const base = await dashboard(request);
  const { entryId } = await makeApprovedOs(request, "D");

  // Recién aprobada: +1 aprobados, +1 EN ESPERA, +1 activos, +1 hoy.
  let d = await dashboard(request);
  expect(d.entries.approval.APROBADA).toBe(base.entries.approval.APROBADA + 1);
  expect(d.entries.activos).toBe(base.entries.activos + 1);
  expect(d.entries.hoy).toBe(base.entries.hoy + 1);

  // Entra a producción: SALE de Aprobados (exclusividad Q14).
  await post(request, `/entries/${entryId}/production/start`);
  d = await dashboard(request);
  expect(d.entries.approval.APROBADA).toBe(base.entries.approval.APROBADA);
  expect(d.entries.statusService["EN REPARACION"] ?? 0).toBe(
    (base.entries.statusService["EN REPARACION"] ?? 0) + 1,
  );
  expect(d.entries.activos).toBe(base.entries.activos + 1);

  // Se entrega: sale de TODOS los contadores activos.
  await post(request, `/entries/${entryId}/production/finish`);
  await put(request, `/entries/${entryId}`, { statusService: "LAVADO" });
  await put(request, `/entries/${entryId}`, { statusService: "ENTREGADO" });
  d = await dashboard(request);
  expect(d.entries.activos).toBe(base.entries.activos);
  expect(d.entries.approval.APROBADA).toBe(base.entries.approval.APROBADA);
  expect(d.entries.statusService["ENTREGADO"] ?? 0).toBe(
    (base.entries.statusService["ENTREGADO"] ?? 0) + 1,
  );
});

// ── 2. Bug #34: totalDocs sin entregados ─────────────────────────────────────

test("bug #34: getEntries excludeDelivered no cuenta entregados en el total/paginación", async ({
  request,
}) => {
  test.setTimeout(120_000);

  const q = (flags = "") =>
    getJson(
      request,
      `/entries?idWorkshop=${ID_WORKSHOP}&approvalState=APROBADA&status=1&limit=10&page=1${flags}`,
    );

  const baseSin = (await q("&excludeDelivered=true"))?.totalDocs ?? 0;
  const baseCon = (await q())?.totalDocs ?? 0;

  // Dos OS aprobadas nuevas; una se entrega.
  const a = await makeApprovedOs(request, "X");
  const b = await makeApprovedOs(request, "Y");
  await post(request, `/entries/${b.entryId}/production/start`);
  await post(request, `/entries/${b.entryId}/production/finish`);
  await put(request, `/entries/${b.entryId}`, { statusService: "LAVADO" });
  await put(request, `/entries/${b.entryId}`, { statusService: "ENTREGADO" });

  // Sin entregados: solo suma la activa. Con todo: suman las dos.
  expect((await q("&excludeDelivered=true"))?.totalDocs).toBe(baseSin + 1);
  expect((await q())?.totalDocs).toBe(baseCon + 2);

  // La entregada no viene en las páginas del listado filtrado.
  const firstPage = (await q("&excludeDelivered=true"))?.entries ?? [];
  expect(firstPage.some((e) => e.id === b.entryId)).toBe(false);
  void a;
});

// ── 3. UI: "Hoy" por defecto en Entradas y KPI de hoy en el dashboard ────────

test("Q14 UI: Entradas abre filtrada a Hoy y el dashboard muestra las entradas de hoy", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await makeApprovedOs(request, "U");

  await page.goto("/login");
  await page.locator("#email").fill(ADMIN_EMAIL);
  await page.locator("#password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });

  // Entradas: el filtro de fecha arranca en "Hoy" (pill activa, azul).
  await page.goto("/registro");
  const hoyPill = page.getByRole("button", { name: "Hoy", exact: true });
  await expect(hoyPill).toBeVisible({ timeout: 15000 });
  await expect(hoyPill).toHaveClass(/text-blue-700/);

  // Dashboard: el KPI de autos en taller desglosa en servicio / por aprobar / hoy.
  await page.goto("/dashboard");
  await expect(
    page.getByText(/\d+ en servicio · \d+ por aprobar · \d+ hoy/i),
  ).toBeVisible({ timeout: 15000 });
});
