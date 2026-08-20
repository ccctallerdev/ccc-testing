const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * JORNADA HASTA LA ENTREGA (Q11) — cierra el ciclo que jornada-ui deja en la
 * aprobación: diagnóstico y costeo POR UI, y de ahí hasta ENTREGADO.
 *
 * Regla de negocio nueva que este spec vigila:
 *   ⛔ NO se puede entregar una OS sin diagnóstico (había expedientes
 *      entregados sin diagnóstico; el backend ahora responde 409).
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
  return { status: res.status(), data: json?.data ?? json, raw: json };
}
const post = (r, p, b, o) => call(r, "post", p, b, o);
const put = (r, p, b, o) => call(r, "put", p, b, o);
const getJson = async (r, p) => (await call(r, "get", p)).data;
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

let seq = 20;
/** Cliente + auto + OS con hoja (SIN diagnóstico ni cotización). */
async function makeBareOs(request, tag) {
  const s = `${String(Date.now()).slice(-6)}${seq++}`;
  const client = (await post(request, "/clients", {
    fullName: `Cliente JE ${tag} ${s}`,
    email: `je.${tag}.${s}@test.com`,
    phone: `58${s}0000000000`.slice(0, 10),
    idWorkshop: ID_WORKSHOP,
    createdBy: MECHANIC,
  })).data;
  const car = (await post(request, "/cars", {
    clientId: idOf(client),
    brand: "Volkswagen",
    model: `Jetta ${tag}`,
    year: 2022,
    vin: `JE${tag}${s}000000000`.slice(0, 17),
    codeCar: `JE${tag}${s.slice(-4)}`.slice(0, 8),
    color: "Blanco",
    fuel: "Gasolina",
    transmition: "Automática",
    km: 35000,
  })).data;
  const entry = (await post(request, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId: idOf(client),
    carId: idOf(car),
    assigned_mechanic: MECHANIC,
    status: 1,
    observations: `JE ${tag}`,
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  })).data;
  const entryId = idOf(entry);
  await post(request, `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos"],
    checks: ["Servicio de Frenos"],
    isCheckAll: false,
    observations: `JE ${tag}`,
    km: 35000,
    fuel_tank: "1/2",
  });
  return { entryId, os: entry?.sheet };
}

async function approveOs(request, entryId) {
  const quotes = (await getJson(request, `/entries/${entryId}/quotes?limit=10`))?.quotes ?? [];
  const sheets = (await getJson(request, `/entries/${entryId}/service-sheet?limit=10`))?.serviceSheets ?? [];
  const realQuote = quotes.find((q) => q?.stage !== "COSTEO") ?? quotes[0];
  await put(request, `/entries/${entryId}/approve-selection`, {
    approvedQuoteId: idOf(realQuote),
    approvedServiceSheetId: idOf(sheets[0]),
  });
  await put(request, `/entries/${entryId}`, { approvalState: "APROBADA" });
}

const statusOf = async (request, entryId) =>
  (await getJson(request, `/entries/${entryId}`))?.statusService;

async function login(page) {
  await page.goto("/login");
  await page.locator("#email").fill(ADMIN_EMAIL);
  await page.locator("#password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });
}

// ── 1. Regla: sin diagnóstico NO hay entrega ─────────────────────────────────

test("entrega bloqueada: una OS sin diagnóstico no se puede ENTREGAR (API 409 + toast con el motivo)", { tag: ["@ui", "@lento"] }, async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const { entryId } = await makeBareOs(request, "B");
  // Cotización mínima para poder aprobar (pero SIN diagnóstico capturado).
  await post(request, `/entries/${entryId}/quotes`, {
    diagnostic: "Sin diagnóstico formal",
    labor: [{ description: "Mano de obra", count: 1, cost: 700, subtotal: 700 }],
    parts: [],
    status: 2,
    stage: "COTIZACION",
  });
  await approveOs(request, entryId);

  // API: el backend rechaza con 409 y el motivo.
  const res = await put(
    request,
    `/entries/${entryId}`,
    { statusService: "ENTREGADO" },
    { allowFail: true },
  );
  expect(res.status).toBe(409);
  expect(JSON.stringify(res.raw)).toMatch(/diagn[oó]stico/i);
  expect(await statusOf(request, entryId)).not.toBe("ENTREGADO");

  // UI: intentar entregar desde el detalle de servicio muestra el motivo.
  await login(page);
  await page.goto(`/servicio-vista/${entryId}`);
  await page.locator(".ant-select").first().click();
  await page
    .locator(
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="Entregado"]',
    )
    .click();
  // Modal de confirmación de entrega → confirmar.
  await page.getByRole("button", { name: /entregar veh[ií]culo/i }).click();
  await expect(
    page.locator("[data-sonner-toaster]").getByText(/diagn[oó]stico/i).first(),
  ).toBeVisible({ timeout: 15000 });
  expect(await statusOf(request, entryId)).not.toBe("ENTREGADO");
});

// ── 2. Jornada completa: diagnóstico + costeo por UI → … → ENTREGADO ────────

test("jornada a entrega: diagnóstico y costeo por UI, ciclo completo hasta ENTREGADO y expediente cerrado", { tag: ["@ui", "@lento"] }, async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const { entryId } = await makeBareOs(request, "F");

  await login(page);

  // ── Diagnóstico por UI (mismos selectores que jornada-ui) ─────────────────
  await page.goto(`/diagnostico-vista/${entryId}`);
  await page.getByRole("button", { name: /nuevo diagn[oó]stico/i }).click();
  await page.getByPlaceholder(/ej\. frenos/i).first().fill("Frenos");
  await page
    .getByPlaceholder(/ej\. balatas delanteras/i)
    .first()
    .fill("Balatas delanteras");
  await page.getByRole("radio", { name: /rojo/i }).first().click();
  await page
    .getByPlaceholder(/describe lo encontrado/i)
    .fill("Balatas en metal-metal; cambio inmediato.");
  await page
    .getByPlaceholder(/acci[oó]n sugerida/i)
    .fill("Reemplazo de balatas delanteras.");
  await page.getByRole("button", { name: /guardar diagn[oó]stico/i }).click();
  const diagFail = page
    .locator("[data-sonner-toaster]")
    .getByText(/error|no se pudo|completa|falta/i)
    .first();
  await Promise.race([
    page.waitForURL(/diagnostico(-vista)?\//, { timeout: 20000 }),
    diagFail.waitFor({ state: "visible", timeout: 20000 }).then(async () => {
      throw new Error(`Guardar diagnóstico falló: "${await diagFail.textContent()}"`);
    }),
  ]);

  // ── Costeo por UI → cotización con precios ────────────────────────────────
  await page.goto(`/diagnostico-vista/${entryId}`);
  await page.getByRole("button", { name: /^\s*costeo\s*$/i }).first().click();
  await expect(page).toHaveURL(/\/costeo\//);
  await page.getByPlaceholder(/filtro de aceite oem/i).first().fill("Balatas delanteras");
  const partRow = page
    .locator("div.grid", { has: page.getByPlaceholder(/filtro de aceite oem/i) })
    .first();
  await partRow.locator("input").nth(1).fill("2");
  await page.getByRole("button", { name: /guardar costeo/i }).click();

  await page.waitForURL(/cotizacion-vista.*quoteId=/, { timeout: 20000 });
  const quoteId = new URL(page.url()).searchParams.get("quoteId");
  expect(quoteId, "quoteId tras guardar costeo").toBeTruthy();
  await page.goto(`/cotizacion-editar/${entryId}?quoteId=${quoteId}`);
  const priceInputs = page.locator('input[inputmode="numeric"]');
  await priceInputs.first().fill("850");
  if ((await priceInputs.count()) > 1) {
    await priceInputs.nth(1).fill("400");
  }
  await page.getByRole("button", { name: /^guardar$/i }).click();
  await page.waitForURL(/cotizacion-vista/, { timeout: 20000 });

  // ── Aprobar y recorrer el ciclo completo (Q5 automático + manual) ─────────
  await approveOs(request, entryId);
  // Observ. 20-Jul: al aprobar se SOLICITA el material automáticamente (orden
  // de compra desde el costeo) y la máquina Q5 avanza compra→REFACCIONES.
  // EN ESPERA solo queda para OS aprobadas sin nada que pedir.
  expect(await statusOf(request, entryId)).toBe("REFACCIONES");

  // Validador de recepción (Obs 29-jul #5/#6): marcar el abastecimiento listo
  // antes de arrancar reparación (production/start lo exige si hay OC activa).
  await put(request, `/entries/${entryId}`, { repairReadiness: "COMPLETO" });

  await post(request, `/entries/${entryId}/production/start`);
  await post(request, `/entries/${entryId}/production/finish`);
  expect(await statusOf(request, entryId)).toBe("CONTROL DE CALIDAD");

  await put(request, `/entries/${entryId}`, { statusService: "LAVADO" });
  await put(request, `/entries/${entryId}`, { statusService: "FINALIZADO" });
  // CON diagnóstico, la entrega SÍ procede.
  await put(request, `/entries/${entryId}`, { statusService: "ENTREGADO" });
  expect(await statusOf(request, entryId)).toBe("ENTREGADO");

  // ── Expediente final: cerrado, con diagnóstico y línea de tiempo ──────────
  await page.goto(`/expediente/${entryId}`);
  await expect(page.getByText(/expediente cerrado/i)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/balatas en metal-metal/i).first()).toBeVisible();
  // La bitácora registró el ciclo (etiquetas de la línea de tiempo).
  await expect(page.getByText(/control de calidad/i).first()).toBeVisible();
  await expect(page.getByText(/^Entregado$/).first()).toBeVisible();

  // Y el diagnóstico quedó intocable (candado de solo lectura en su vista).
  await page.goto(`/diagnostico-vista/${entryId}`);
  await expect(page.getByText(/solo lectura/i)).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: /nuevo diagn[oó]stico/i })).toHaveCount(0);
});
