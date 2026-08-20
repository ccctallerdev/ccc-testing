const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * CORE Q31/Q12 — Aprobación por CONCEPTOS + cotizaciones ANEXAS + DEFINITIVA:
 *   - El cliente aprueba línea por línea: la oficial se genera SOLO con lo
 *     aprobado (respeta "una oficial por OS") y lo rechazado va a
 *     Seguimientos con su hallazgo de origen (findingId).
 *   - Sobre una OS aprobada, las cotizaciones nuevas nacen ANEXAS a la
 *     oficial vigente; "integrar" produce la DEFINITIVA (oficial + anexas)
 *     sobre la que se cobra.
 *
 * PRERREQUISITOS: emuladores + backend + frontend (global-setup siembra admin).
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC = "mecanico-prueba";
const ADMIN_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const ADMIN_PASSWORD = process.env.SEED_PASSWORD || "prueba123";

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

let seq = 60;
/** OS con hoja y una cotización de 3 conceptos (2 labor + 1 part), EN ESPERA. */
async function makeOsWithQuote(request, tag) {
  const s = `${String(Date.now()).slice(-6)}${seq++}`;
  const client = (await post(request, "/clients", {
    fullName: `Cliente Q31 ${tag} ${s}`,
    email: `q31.${tag}.${s}@test.com`,
    phone: `83${s.slice(-8)}0000000000`.slice(0, 10),
    createdBy: MECHANIC,
  })).data;
  const car = (await post(request, "/cars", {
    clientId: idOf(client),
    brand: "Seat",
    model: `Ibiza ${tag}`,
    year: 2021,
    vin: `QT${tag}${s}000000000`.slice(0, 17),
    codeCar: `QT${tag}${s.slice(-4)}`.slice(0, 8),
    color: "Negro",
    fuel: "Gasolina",
    transmition: "Manual",
    km: 42000,
  })).data;
  const entry = (await post(request, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId: idOf(client),
    carId: idOf(car),
    assigned_mechanic: MECHANIC,
    status: 1,
    observations: `Q31 ${tag}`,
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  })).data;
  const entryId = idOf(entry);
  await post(request, `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos"],
    checks: ["Servicio de Frenos"],
    isCheckAll: false,
    observations: `Q31 ${tag}`,
    km: 42000,
    fuel_tank: "1/2",
  });
  const quote = (await post(request, `/entries/${entryId}/quotes`, {
    diagnostic: `Q31 ${tag}`,
    labor: [
      { description: "Cambio de balatas", count: 2, cost: 600, subtotal: 1200, findingId: `f-${s}-1` },
      { description: "Alineación y balanceo", count: 1, cost: 500, subtotal: 500, findingId: `f-${s}-2` },
    ],
    parts: [
      { description: "Balatas delanteras", count: 1, cost: 850, subtotal: 850 },
    ],
    status: 2,
    stage: "COTIZACION",
    advance: 300,
  })).data;
  return { entryId, os: entry?.sheet, quoteId: idOf(quote), clientId: idOf(client) };
}

const getQuote = (r, entryId, quoteId) => getJson(r, `/entries/${entryId}/quotes/${quoteId}`);
const getEntry = (r, entryId) => getJson(r, `/entries/${entryId}`);

// ── 1. Aprobación por conceptos (parcial) ────────────────────────────────────

test("Q31 API: aprobar 2 de 3 conceptos genera la oficial recortada, aprueba la OS y manda el resto a Seguimientos", { tag: ["@api"] }, async ({
  request,
}) => {
  test.setTimeout(90_000);
  const { entryId, quoteId } = await makeOsWithQuote(request, "A");

  // Aprueba la refacción (part 0) + primera mano de obra (labor 0);
  // rechaza "Alineación y balanceo" (labor 1, con findingId).
  const resp = (await post(request, `/entries/${entryId}/quotes/${quoteId}/approve-concepts`, {
    approvedParts: [0],
    approvedLabor: [0],
  })).data;

  expect(resp.officialQuoteId).toBeTruthy();
  expect(resp.officialQuoteId).not.toBe(quoteId); // oficial NUEVA (recortada)
  expect(resp.approvedCount).toBe(2);
  expect(resp.rejectedCount).toBe(1);
  expect(resp.followupsCreated).toBe(1);

  // La oficial recortada: 1 labor + 1 part, con folio propio y rastro del origen.
  const official = await getQuote(request, entryId, resp.officialQuoteId);
  expect(official.labor).toHaveLength(1);
  expect(official.labor[0].description).toBe("Cambio de balatas");
  expect(official.parts).toHaveLength(1);
  expect(official.quoteNumber).toBeGreaterThan(0);
  expect(official.conceptsFromQuoteId).toBe(quoteId);
  expect(Number(official.advance)).toBe(300);

  // La entrada quedó APROBADA con la selección oficial nueva y en cola (Q5).
  const entry = await getEntry(request, entryId);
  expect(entry.approvalState).toBe("APROBADA");
  expect(entry.approvedSelection?.quoteId).toBe(resp.officialQuoteId);
  // Observ. 20-Jul: la aprobación genera la orden de compra automática de lo
  // aprobado ⇒ Q5 avanza a REFACCIONES de inmediato (antes quedaba EN ESPERA).
  expect(entry.statusService).toBe("REFACCIONES");
  // Total oficial denormalizado = solo lo aprobado (1200 + 850).
  expect(entry.officialQuoteTotal).toBe(2050);

  // El concepto rechazado quedó en Seguimientos con su hallazgo.
  const fu = await getJson(
    request,
    `/followups?idWorkshop=${ID_WORKSHOP}&entryId=${entryId}`,
  );
  const items = fu?.followups ?? [];
  expect(items).toHaveLength(1);
  expect(items[0].description).toMatch(/alineación y balanceo/i);
  expect(items[0].findingId).toMatch(/^f-/);
  expect(items[0].status).toBe("PENDING");
});

// ── 2. Anexas + definitiva ───────────────────────────────────────────────────

test("Q31 API: la anexa se integra con la oficial en la DEFINITIVA (líneas y anticipos sumados)", { tag: ["@api"] }, async ({
  request,
}) => {
  test.setTimeout(90_000);
  const { entryId, quoteId } = await makeOsWithQuote(request, "B");

  // Aprobación total (sin recorte): la oficial es la misma cotización.
  const approve = (await post(request, `/entries/${entryId}/quotes/${quoteId}/approve-concepts`, {
    approvedParts: [0],
    approvedLabor: [0, 1],
  })).data;
  expect(approve.officialQuoteId).toBe(quoteId);
  expect(approve.rejectedCount).toBe(0);

  // Nuevas evidencias → cotización ANEXA a la oficial vigente.
  const annex = (await post(request, `/entries/${entryId}/quotes`, {
    diagnostic: "Nueva evidencia: fuga en bomba de agua",
    labor: [{ description: "Cambio de bomba de agua", count: 3, cost: 400, subtotal: 1200 }],
    parts: [{ description: "Bomba de agua", count: 1, cost: 950, subtotal: 950 }],
    status: 2,
    stage: "COTIZACION",
    advance: 200,
    isAnnex: true,
    annexToQuoteId: quoteId,
  })).data;
  const annexId = idOf(annex);

  // Integrar → DEFINITIVA con las líneas de ambas y anticipos sumados.
  const integrated = (await post(request, `/entries/${entryId}/quotes/integrate-definitive`)).data;
  expect(integrated.definitiveQuoteId).toBeTruthy();
  expect(integrated.integratedFrom).toEqual([quoteId, annexId]);

  const definitive = await getQuote(request, entryId, integrated.definitiveQuoteId);
  expect(definitive.isDefinitive).toBe(true);
  expect(definitive.labor).toHaveLength(3); // 2 oficiales + 1 anexa
  expect(definitive.parts).toHaveLength(2); // 1 oficial + 1 anexa
  expect(Number(definitive.advance)).toBe(500); // 300 + 200
  expect(definitive.quoteNumber).toBeGreaterThan(0);

  // La definitiva es la nueva oficial; la anexa quedó marcada como integrada.
  const entry = await getEntry(request, entryId);
  expect(entry.approvedSelection?.quoteId).toBe(integrated.definitiveQuoteId);
  expect(entry.officialQuoteTotal).toBe(1200 + 500 + 850 + 1200 + 950);
  const annexAfter = await getQuote(request, entryId, annexId);
  expect(annexAfter.integratedIntoQuoteId).toBe(integrated.definitiveQuoteId);

  // Integrar de nuevo sin anexas pendientes → error controlado.
  const again = await post(
    request,
    `/entries/${entryId}/quotes/integrate-definitive`,
    undefined,
    { allowFail: true },
  );
  expect(again.status).toBeGreaterThanOrEqual(400);
});

// ── 3. UI: modal de conceptos ────────────────────────────────────────────────

test("Q31 UI: el modal de conceptos desmarca uno, aprueba y muestra la oficial recortada", { tag: ["@ui"] }, async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const { entryId, quoteId } = await makeOsWithQuote(request, "C");
  // Selección oficial previa (el flujo del puente la exige antes de confirmar).
  const sheets = (await getJson(request, `/entries/${entryId}/service-sheet?limit=10`))?.serviceSheets ?? [];
  await put(request, `/entries/${entryId}/approve-selection`, {
    approvedQuoteId: quoteId,
    approvedServiceSheetId: idOf(sheets[0]),
  });

  await page.goto("/login");
  await page.locator("#email").fill(ADMIN_EMAIL);
  await page.locator("#password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });

  await page.goto(`/cotizacion-vista/${entryId}?quoteId=${quoteId}`);
  await page.getByRole("button", { name: /cliente confirmó/i }).click();

  const modal = page.locator(".ant-modal");
  await expect(modal.getByText(/qué conceptos aprobó/i)).toBeVisible({ timeout: 15000 });
  // Desmarcar "Alineación y balanceo".
  await modal
    .locator("label", { hasText: /alineación y balanceo/i })
    .locator('input[type="checkbox"]')
    .uncheck();
  await modal.getByRole("button", { name: /confirmar aprobación/i }).click();

  await expect(
    page
      .locator("[data-sonner-toaster]")
      .getByText(/aprobados 2 conceptos; 1 se fueron a seguimientos/i)
      .first(),
  ).toBeVisible({ timeout: 15000 });

  // La vista queda en la oficial recortada (sin el concepto rechazado).
  await expect(page.getByText(/cambio de balatas/i).first()).toBeVisible({ timeout: 15000 });

  // Fondo: OS aprobada y seguimiento creado.
  const entry = await getEntry(request, entryId);
  expect(entry.approvalState).toBe("APROBADA");
  const fu = await getJson(request, `/followups?idWorkshop=${ID_WORKSHOP}&entryId=${entryId}`);
  expect((fu?.followups ?? []).some((f) => /alineación/i.test(f.description))).toBe(true);
});
