const { test, expect } = require("@playwright/test");

/**
 * CORE #52 (Q19) — Garantías ligadas a la OS de origen:
 *   - API: crear con entryId denormaliza osSheet; resolver marca resolvedAt;
 *     el resumen (abiertas/por origen) se mueve por deltas.
 *   - UI: desde el expediente ENTREGADO se levanta la garantía ya ligada,
 *     aparece con su chip "OS <n>" y se puede resolver.
 *
 * El taller de pruebas es compartido: los conteos se verifican por DELTAS.
 *
 * PRERREQUISITOS: emuladores + backend + frontend (global-setup siembra admin).
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC = "mecanico-prueba";
const ADMIN_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const ADMIN_PASSWORD = process.env.SEED_PASSWORD || "prueba123";

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

const listWarranties = (r) => getJson(r, `/warranties?idWorkshop=${ID_WORKSHOP}`);

let seq = 50;
/** OS aprobada, con diagnóstico, ENTREGADA (el flujo real de una garantía). */
async function makeDeliveredOs(request, tag) {
  const s = `${String(Date.now()).slice(-6)}${seq++}`;
  const client = await post(request, "/clients", {
    fullName: `Cliente G ${tag} ${s}`,
    email: `g.${tag}.${s}@test.com`,
    phone: `62${s}`,
    idWorkshop: ID_WORKSHOP,
    createdBy: MECHANIC,
  });
  const car = await post(request, "/cars", {
    clientId: idOf(client),
    brand: "Chevrolet",
    model: `Aveo ${tag}`,
    year: 2022,
    vin: `GA${tag}${s}000000000`.slice(0, 17),
    codeCar: `GA${tag}${s.slice(-4)}`.slice(0, 8),
    color: "Blanco",
    fuel: "Gasolina",
    transmition: "Manual",
    km: 50000,
  });
  const entry = await post(request, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId: idOf(client),
    carId: idOf(car),
    assigned_mechanic: MECHANIC,
    status: 1,
    observations: `Garantía ${tag}`,
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  });
  const entryId = idOf(entry);
  await post(request, `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos"],
    checks: ["Servicio de Frenos"],
    isCheckAll: false,
    observations: `Garantía ${tag}`,
    km: 50000,
    fuel_tank: "1/2",
  });
  await post(request, `/entries/${entryId}/quotes`, {
    diagnostic: `Garantía ${tag}`,
    labor: [{ description: "Cambio de balatas", count: 1, cost: 900, subtotal: 900 }],
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
  await post(request, `/entries/${entryId}/diagnostics`, {
    generalObservations: `Diagnóstico garantía ${tag}`,
    findings: [{ system: "Frenos", finding: "Balatas gastadas", severity: "ROJO" }],
  });
  await put(request, `/entries/${entryId}`, { statusService: "ENTREGADO" });
  return { entryId, os: entry?.sheet };
}

// ── API ──────────────────────────────────────────────────────────────────────

test("Q19 API: garantía ligada a la OS (osSheet), resumen por deltas y resolución", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const { entryId, os } = await makeDeliveredOs(request, "A");

  const base = (await listWarranties(request))?.summary;

  const w = await post(request, "/warranties", {
    idWorkshop: ID_WORKSHOP,
    origin: "MANO_DE_OBRA",
    description: "Regresó con el mismo ruido al frenar",
    system: "Frenos",
    entryId,
  });
  // Denormalización del número de OS.
  expect(w.osSheet).toBe(String(os));
  expect(w.status).toBe("OPEN");

  let s = (await listWarranties(request))?.summary;
  expect(s.open).toBe(base.open + 1);
  expect(s.byOrigin.MANO_DE_OBRA).toBe(base.byOrigin.MANO_DE_OBRA + 1);

  // Resolver con nota → resolvedAt.
  const resolved = await put(request, `/warranties/${w.id}`, {
    status: "RESOLVED",
    resolutionNote: "Se rectificaron discos y se ajustó sin costo.",
  });
  expect(resolved.status).toBe("RESOLVED");
  expect(resolved.resolvedAt).toBeGreaterThan(0);
  expect(resolved.resolutionNote).toMatch(/rectificaron/);

  s = (await listWarranties(request))?.summary;
  expect(s.open).toBe(base.open);
  expect(s.resolved).toBe(base.resolved + 1);
});

// ── UI ───────────────────────────────────────────────────────────────────────

test("Q19 UI: levantar garantía desde el expediente entregado y resolverla", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const { entryId, os } = await makeDeliveredOs(request, "B");

  await page.goto("/login");
  await page.locator("#email").fill(ADMIN_EMAIL);
  await page.locator("#password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });

  // Expediente entregado → botón de garantía.
  await page.goto(`/expediente/${entryId}`);
  await expect(page.getByText(/expediente cerrado/i)).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: /levantar garantía/i }).click();

  // El formulario abre solo, ligado a la OS.
  await page.waitForURL(/\/garantias\?entryId=/, { timeout: 15000 });
  await expect(page.getByText(new RegExp(`ligada a la\\s+OS ${os}`, "i"))).toBeVisible({
    timeout: 15000,
  });
  await page
    .getByPlaceholder(/qué falló y en qué condiciones/i)
    .fill("Regresó con vibración al frenar en autopista.");
  // Scoped al modal: el encabezado de la página tiene otro botón igual.
  await page
    .locator(".ant-modal")
    .getByRole("button", { name: /registrar garantía/i })
    .click();
  await expect(
    page.locator("[data-sonner-toaster]").getByText(/garantía registrada/i).first(),
  ).toBeVisible({ timeout: 15000 });

  // La tarjeta trae el chip de su OS.
  const card = page
    .locator("div.rounded-xl.border", { hasText: /vibración al frenar/i })
    .first();
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.getByRole("button", { name: `OS ${os}` })).toBeVisible();

  // Resolver desde la lista.
  await card.getByRole("button", { name: /resolver/i }).click();
  await expect(
    page.locator("[data-sonner-toaster]").getByText(/garantía actualizada/i).first(),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    page
      .locator("div.rounded-xl.border", { hasText: /vibración al frenar/i })
      .first()
      .getByText(/resuelta/i),
  ).toBeVisible({ timeout: 15000 });
});
