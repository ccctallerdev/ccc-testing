const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * M2 — Anticipos: SALDO PENDIENTE (PDF #34 / respuesta D2 del cliente, 14-ago).
 *
 * "Saldo pendiente = total de la cotización oficial aprobada (con sus
 * actualizaciones) − total abonado", mostrado en el mismo modal de Anticipos.
 *
 * Preparación por API (rápida): OS aprobada con cotización de $1,200 y dos
 * abonos ($500 + $300). Verificación por UI: en Registro → Aprobados, el botón
 * "Anticipos" abre el modal y muestra Total abonado $800.00 y Saldo pendiente
 * $400.00. Luego se registra el tercer abono ($400) DESDE el modal y el saldo
 * pasa a $0.00 · liquidado.
 *
 * PRERREQUISITOS: emuladores + backend :3001 + frontend :3000. Cuenta semilla
 * vía #apiToken (prueba@ccc.test / taller-prueba).
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";
const ADMIN_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const ADMIN_PASSWORD = process.env.SEED_PASSWORD || "prueba123";

async function call(request, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: await authHeaders(),
    ...(body ? { data: body } : {}),
  });
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

/** Dinero es-MX: "$400.00" (con o sin espacio/nbsp tras el símbolo). */
const money = (n) => new RegExp(`\\$\\s?${n.toLocaleString("en-US", { minimumFractionDigits: 2 }).replace(/,/g, ",?")}`);

/** OS aprobada con cotización oficial de $1,200 (mano de obra) + 2 abonos por API. */
async function makeApprovedOsWithAdvances(request) {
  const s = `${String(Date.now()).slice(-6)}`;
  const plates = `M2${s.slice(-5)}`;
  const client = await post(request, "/clients", {
    fullName: `Cliente M2 ${s}`,
    email: `m2.${s}@test.com`,
    phone: `55${s}0000000000`.slice(0, 10),
    idWorkshop: ID_WORKSHOP,
    createdBy: MECHANIC_ID,
  });
  const car = await post(request, "/cars", {
    clientId: idOf(client),
    brand: "Honda",
    model: "Civic M2",
    year: 2020,
    vin: `M2${s}0000000000000`.slice(0, 17),
    codeCar: plates,
    color: "Azul",
    fuel: "Gasolina",
    transmition: "Automática",
    km: 41000,
  });
  const entry = await post(request, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId: idOf(client),
    carId: idOf(car),
    assigned_mechanic: MECHANIC_ID,
    status: 1,
    observations: `M2 ${s}: saldo pendiente de anticipos`,
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  });
  const entryId = idOf(entry);
  await post(request, `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos"],
    checks: ["Frenos"],
    isCheckAll: false,
    observations: `M2 ${s}`,
    km: 41000,
    fuel_tank: "1/2",
  });
  await post(request, `/entries/${entryId}/diagnostics`, {
    idMechanic: MECHANIC_ID,
    generalObservations: "Balatas al límite.",
    findings: [
      {
        id: "m2-rojo",
        system: "Frenos",
        component: "Balatas",
        finding: "Metal-metal.",
        severity: "ROJO",
        recommendation: "Cambio de balatas.",
        commercialDescription: "Frenos al límite.",
        consequence: "Riesgo al frenar.",
      },
    ],
  });
  const quote = await post(request, `/entries/${entryId}/quotes`, {
    diagnostic: "Cambio de balatas",
    labor: [{ description: "Cambio de balatas", count: 1, cost: 1200, subtotal: 1200 }],
    parts: [],
    status: 2,
    stage: "COTIZACION",
  });
  const quoteId = idOf(quote);
  const sheets = (await getJson(request, `/entries/${entryId}/service-sheet?limit=10`))?.serviceSheets ?? [];
  await put(request, `/entries/${entryId}/approve-selection`, {
    approvedQuoteId: quoteId,
    approvedServiceSheetId: idOf(sheets[0]),
  });
  await put(request, `/entries/${entryId}`, { approvalState: "APROBADA" });

  // Dos abonos por API (el modal los lista y suma).
  await post(request, `/entries/${entryId}/quotes/${quoteId}/advances`, { amount: 500, note: "Apartado" });
  await post(request, `/entries/${entryId}/quotes/${quoteId}/advances`, { amount: 300, note: "Segundo abono" });

  return { entryId, quoteId, os: entry?.sheet, plates };
}

test(
  "M2 / PDF #34: el modal de Anticipos muestra el Saldo pendiente (total aprobado − abonado) y baja a $0 al liquidar",
  { tag: ["@ui", "@lento"] },
  async ({ page, request }) => {
    test.setTimeout(180_000);
    const { entryId, quoteId, os, plates } = await makeApprovedOsWithAdvances(request);

    // Sanidad por API: 2 abonos = $800 sobre $1,200.
    const q = await getJson(request, `/entries/${entryId}/quotes/${quoteId}`);
    const advanced = (q?.advancePayments ?? []).reduce((a, p) => a + Number(p.amount || 0), 0);
    expect(advanced, "abonos por API").toBe(800);

    // UI: login → Registro → pestaña Aprobados → botón Anticipos de ESTA OS.
    await page.goto("/login");
    await page.locator("#email").fill(ADMIN_EMAIL);
    await page.locator("#password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /iniciar sesión/i }).click();
    await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });

    await page.goto("/registro?tab=aprobados");
    // La tarjeta de la OS se ubica por sus placas (únicas). Registro pinta
    // tarjetas de escritorio Y móvil (CardsLarge/CardsSmall, una oculta por
    // CSS) → quedarse con el botón VISIBLE. aria-label="Anticipos".
    await expect(
      page.getByText(new RegExp(plates, "i")).filter({ visible: true }).first(),
      `la OS ${os} aparece en Aprobados`,
    ).toBeVisible({ timeout: 20000 });
    const card = page
      .locator("div", { has: page.getByText(new RegExp(plates, "i")) })
      .filter({ has: page.getByRole("button", { name: /anticipos?/i }) })
      .filter({ visible: true })
      .last();
    await card.getByRole("button", { name: /anticipos?/i }).filter({ visible: true }).first().click();

    const modal = page.locator(".ant-modal").filter({ hasText: /anticipos/i }).last();
    await expect(modal).toBeVisible({ timeout: 15000 });

    // Total abonado $800.00 · de $1,200.00
    await expect(modal.getByText(/total abonado/i)).toBeVisible();
    await expect(modal.getByText(money(800)).first()).toBeVisible({ timeout: 10000 });
    await expect(modal.getByText(/de\s+\$\s?1,?200\.00/)).toBeVisible();

    // Saldo pendiente $400.00 (D2)
    const saldo = modal.getByTestId("anticipos-saldo-pendiente");
    await expect(saldo, "línea de Saldo pendiente").toBeVisible();
    await expect(saldo).toContainText(/saldo pendiente/i);
    await expect(saldo).toContainText(money(400));

    // Registrar el 3er abono DESDE el modal → saldo $0.00 · liquidado
    await modal.getByPlaceholder(/^monto$/i).fill("400");
    await modal.getByPlaceholder(/nota/i).fill("Liquidación");
    await modal.getByRole("button", { name: /registrar abono/i }).click();
    await expect(
      page.locator("[data-sonner-toaster]").getByText(/anticipo registrado/i).first(),
    ).toBeVisible({ timeout: 15000 });

    await expect(saldo).toContainText(money(0), { timeout: 15000 });
    await expect(saldo).toContainText(/liquidado/i);
    await expect(modal.getByText(money(1200)).first(), "total abonado ya es $1,200.00").toBeVisible();

    // Y el backend coincide: 3 abonos = $1,200.
    const q2 = await getJson(request, `/entries/${entryId}/quotes/${quoteId}`);
    const advanced2 = (q2?.advancePayments ?? []).reduce((a, p) => a + Number(p.amount || 0), 0);
    expect(advanced2).toBe(1200);
  },
);
