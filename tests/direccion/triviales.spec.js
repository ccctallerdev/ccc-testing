const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * TRIVIALES del backlog (13-ago) — un `test` por fix, etiqueta @triviales:
 *
 *   npx playwright test --project=direccion --grep "@triviales"
 *
 *   T2 · Configuración: texto de ayuda (ⓘ) en cada concepto del Modelo
 *        Operativo (PDF #62 / D6). Roberto valida los textos.
 *   T3 · Hoja de servicio: numeración subsecuente dentro de la OS y folio
 *        OS154-H1, H2… (PDF #14 / D8).
 *   T4 · Abastecimiento: al pedir a "Otro proveedor", el pedido original queda
 *        "No encontrada" (PDF #35).
 *
 * PRERREQUISITOS: emuladores + backend :3001 + frontend :3000. Cuenta semilla
 * vía #apiToken (prueba@ccc.test / taller-prueba, rol ADMIN).
 */

const API = process.env.API || "http://localhost:3001/v1";
const AGENDA_API = process.env.AGENDA_API || "http://localhost:3001/agenda";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";
const ADMIN_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const ADMIN_PASSWORD = process.env.SEED_PASSWORD || "prueba123";

// ───────────────────────────── helpers de API ─────────────────────────────
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
const stamp = () => `${String(Date.now()).slice(-6)}`;

/** Cliente + auto nuevos. */
async function makeClientCar(request, s, tag) {
  const client = await post(request, "/clients", {
    fullName: `Cliente ${tag} ${s}`,
    email: `${tag.toLowerCase()}.${s}@test.com`,
    phone: `55${s}0000000000`.slice(0, 10),
    idWorkshop: ID_WORKSHOP,
    createdBy: MECHANIC_ID,
  });
  const car = await post(request, "/cars", {
    clientId: idOf(client),
    brand: "Honda",
    model: `Civic ${tag}`,
    year: 2020,
    vin: `${tag}${s}00000000000000000`.slice(0, 17),
    codeCar: `${tag.slice(0, 2)}${s.slice(-5)}`,
    color: "Gris",
    fuel: "Gasolina",
    transmition: "Manual",
    km: 50000,
  });
  return { client, car };
}

/**
 * OS con hoja + diagnóstico + cotización (700 MO + 1450 refacción = 2150),
 * selección oficial y APROBADA. `promiseDate` (ms) opcional se guarda en la
 * cotización y se denormaliza a la entrada al aprobar la selección.
 */
async function makeApprovedOs(request, { tag, promiseDate, partName } = {}) {
  const s = stamp();
  const t = tag || "MED";
  const part = partName || `Bomba de agua ${t} ${s}`;
  const { client, car } = await makeClientCar(request, s, t);
  const entry = await post(request, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId: idOf(client),
    carId: idOf(car),
    assigned_mechanic: MECHANIC_ID,
    status: 1,
    observations: `${t} ${s}`,
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  });
  const entryId = idOf(entry);
  await post(request, `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos"],
    checks: ["Motor"],
    isCheckAll: false,
    observations: `${t} ${s}`,
    km: 50000,
    fuel_tank: "1/2",
  });
  await post(request, `/entries/${entryId}/diagnostics`, {
    idMechanic: MECHANIC_ID,
    generalObservations: "Fuga de refrigerante.",
    findings: [
      {
        id: `${t}-rojo`,
        system: "Enfriamiento",
        component: "Bomba de agua",
        finding: "Fuga.",
        severity: "ROJO",
        recommendation: "Reemplazo.",
        commercialDescription: "Bomba dañada.",
        consequence: "Sobrecalentamiento.",
      },
    ],
  });
  await post(request, `/entries/${entryId}/quotes`, {
    diagnostic: "Cambio de bomba de agua",
    labor: [{ description: "Cambio de bomba", count: 1, cost: 700, subtotal: 700 }],
    parts: [{ description: part, count: 1, cost: 1450, subtotal: 1450 }],
    status: 2,
    stage: "COTIZACION",
    ...(typeof promiseDate === "number" ? { promiseDate } : {}),
  });
  const quotes = (await getJson(request, `/entries/${entryId}/quotes?limit=10`))?.quotes ?? [];
  const sheets = (await getJson(request, `/entries/${entryId}/service-sheet?limit=10`))?.serviceSheets ?? [];
  const quoteId = idOf(quotes[0]);
  await put(request, `/entries/${entryId}/approve-selection`, {
    approvedQuoteId: quoteId,
    approvedServiceSheetId: idOf(sheets[0]),
  });
  await put(request, `/entries/${entryId}`, { approvalState: "APROBADA" });
  return { entryId, quoteId, os: String(entry?.sheet ?? ""), partName: part, s, tag: t };
}

/** Proveedor nuevo. */
async function makeSupplier(request, s, tag) {
  const supplier = await post(request, "/suppliers", {
    idWorkshop: ID_WORKSHOP,
    name: `Refaccionaria ${tag} ${s}`,
    contactName: tag,
    phone: `54${s}0000000000`.slice(0, 10),
    email: `${tag.toLowerCase()}.${s}@prov.test`,
  });
  return { supplierId: idOf(supplier), supplierName: `Refaccionaria ${tag} ${s}` };
}

/** OC al proveedor ligada a la OS y RECIBIDA (a tiempo: esperada en 48h). */
async function makeReceivedPo(request, { entryId, supplierId, partName }) {
  const po = await post(request, "/purchase-orders", {
    idWorkshop: ID_WORKSHOP,
    entryId,
    supplierId,
    expectedDate: Date.now() + 48 * 3600 * 1000,
    items: [{ description: partName, qty: 1, unitCost: 980 }],
  });
  await post(request, `/purchase-orders/${idOf(po)}/receive`, { items: [{ index: 0, received: 1 }] });
  return idOf(po);
}

async function login(page) {
  await page.goto("/login");
  await page.locator("#email").fill(ADMIN_EMAIL);
  await page.locator("#password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });
}


// ═════════════════════════════════ T2 ══════════════════════════════════════
test(
  "T2 / D6: cada concepto del Modelo Operativo tiene su ícono ⓘ con texto de ayuda (accesible con teclado)",
  { tag: ["@triviales", "@ui"] },
  async ({ page }) => {
    await login(page);
    await page.goto("/configuracion");
    await expect(page.getByText(/modelo operativo/i).first()).toBeVisible({ timeout: 20000 });
    const icons = page.getByTestId("help-icon");
    // 12 campos numéricos → 12 íconos.
    await expect(icons).toHaveCount(12, { timeout: 15000 });
    // Cada ícono es un botón con aria-label "Ayuda: <campo>".
    const first = page.getByRole("button", { name: /^ayuda: número inicial de os$/i });
    await expect(first).toBeVisible();
    // Con teclado (foco) o hover se muestra el texto.
    await first.focus();
    await expect(page.locator(".ant-tooltip").filter({ hasText: /primera orden de servicio/i })).toBeVisible({ timeout: 5000 });
    // Y el texto también existe en el DOM para lectores de pantalla (aria-describedby).
    const input = page.locator("#om-osStart");
    await expect(input).toHaveAttribute("aria-describedby", "om-help-osStart");
    await expect(page.locator("#om-help-osStart")).toContainText(/OS154-H1/);
  },
);

// ═════════════════════════════════ T3 ══════════════════════════════════════
test(
  "T3 / D8: las hojas de servicio se numeran de forma subsecuente dentro de la OS (OSn-H1, OSn-H2) y el folio se ve en el expediente",
  { tag: ["@triviales", "@api", "@ui"] },
  async ({ page, request }) => {
    test.setTimeout(180_000);
    const s = stamp();
    const { client, car } = await makeClientCar(request, s, "HOJ");
    const entry = await post(request, "/entries", {
      idWorkshop: ID_WORKSHOP,
      clientId: idOf(client),
      carId: idOf(car),
      assigned_mechanic: MECHANIC_ID,
      status: 1,
      observations: `HOJ ${s}`,
      registerDate: Date.now(),
      approvalState: "EN ESPERA",
    });
    const entryId = idOf(entry);
    const os = String(entry?.sheet ?? "");
    expect(os, "la OS tiene número").not.toBe("");

    for (const km of [50000, 50120]) {
      await post(request, `/entries/${entryId}/service-sheet`, {
        car_items: ["Documentos"],
        checks: ["Motor"],
        isCheckAll: false,
        observations: `Hoja ${km} ${s}`,
        km,
        fuel_tank: "1/2",
      });
    }
    const sheets = (await getJson(request, `/entries/${entryId}/service-sheet?limit=10`))?.serviceSheets ?? [];
    const nums = sheets.map((x) => x.sheetNumber).sort((a, b) => a - b);
    expect(nums, "números subsecuentes 1 y 2").toEqual([1, 2]);
    const folios = sheets.map((x) => x.folio).sort();
    expect(folios).toEqual([`OS${os}-H1`, `OS${os}-H2`]);

    // UI: el listado de hojas del expediente muestra el folio.
    await login(page);
    await page.goto(`/hoja-servicio-vista/${entryId}`);
    await expect(page.getByTestId("sheet-folio").filter({ hasText: `OS${os}-H1` })).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("sheet-folio").filter({ hasText: `OS${os}-H2` })).toBeVisible();
  },
);

// ═════════════════════════════════ T4 ══════════════════════════════════════
test(
  "T4 / PDF #35: al pedir a 'Otro proveedor', el pedido original queda 'No encontrada' y el nuevo lleva el seguimiento",
  { tag: ["@triviales", "@ui", "@lento"] },
  async ({ page, request }) => {
    test.setTimeout(240_000);
    const os = await makeApprovedOs(request, { tag: "OTP" });
    const supA = await makeSupplier(request, os.s, "OTPA");
    const supB = await makeSupplier(request, `${os.s}b`, "OTPB");
    const poA = await post(request, "/purchase-orders", {
      idWorkshop: ID_WORKSHOP,
      entryId: os.entryId,
      supplierId: supA.supplierId,
      expectedDate: Date.now() + 24 * 3600 * 1000,
      items: [{ description: os.partName, qty: 1, unitCost: 900 }],
    });
    const poAId = idOf(poA);

    await login(page);
    await page.goto("/abastecimiento");
    // Tarjeta del pedido original (proveedor A).
    const cardA = page.locator(".rounded-xl", { hasText: supA.supplierName }).filter({ hasText: `OS ${os.os}` }).first();
    await expect(cardA).toBeVisible({ timeout: 20000 });
    await cardA.getByRole("button", { name: /otro proveedor/i }).click();

    // El formulario nace con las partidas de la OS; elegir proveedor B y crear.
    const modal = page.locator(".ant-modal").last();
    await expect(modal).toBeVisible();
    await expect(modal.getByPlaceholder(/bomba de gasolina/i).first(), "partida precargada en el formulario").toHaveValue(os.partName);
    await modal.locator("select").first().selectOption(supB.supplierId);
    await modal.getByRole("button", { name: /crear orden/i }).click();
    await expect(page.getByText(/quedó como "No encontrada"/i)).toBeVisible({ timeout: 15000 });

    // API: el original en NO_ENCONTRADA; el nuevo existe con proveedor B, misma OS y partida.
    const list = await getJson(request, `/purchase-orders?idWorkshop=${ID_WORKSHOP}&scope=all`);
    const orders = list?.orders ?? [];
    const a = orders.find((o) => o.id === poAId);
    expect(a?.sourcingStatus, "pedido original marcado No encontrada").toBe("NO_ENCONTRADA");
    const b = orders.find((o) => o.supplierId === supB.supplierId && o.entryId === os.entryId);
    expect(b, "pedido nuevo con el otro proveedor").toBeTruthy();
    expect(b.items?.[0]?.description).toBe(os.partName);
    expect(b.sourcingStatus).not.toBe("NO_ENCONTRADA");

    // UI: la tarjeta original muestra el semáforo rojo "No encontrada" (el badge,
    // no la opción del <select>, que siempre contiene ese texto).
    await expect(cardA.locator("span.rounded-full").filter({ hasText: /^\s*no encontrada\s*$/i })).toBeVisible({ timeout: 15000 });
  },
);
