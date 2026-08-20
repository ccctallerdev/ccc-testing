const { test, expect } = require("@playwright/test");
const { getApiToken, authHeaders } = require("#apiToken");

/**
 * PDF #47 — "Los vehículos entregados no se actualizan cuando se entregan."
 *
 * Reproduce el reporte del cliente de PUNTA A PUNTA y verifica que, al marcar
 * una OS como ENTREGADO, el vehículo aparece en "Vehículos entregados":
 *
 *   cliente → auto → OS → hoja → diagnóstico → cotización → aprobar →
 *   (producción) → ENTREGADO → ¿aparece en la lista de entregados?
 *
 * La verificación de API usa EXACTAMENTE la consulta de la página
 * (useDeliveredEntriesPage.js):
 *   GET /entries?idWorkshop&statusService=ENTREGADO&limit=10&page=1  ← paginado
 *   GET /entries?…&search=<placas>                                  ← búsqueda
 *
 * D9 (respuesta del cliente 14-ago): la página YA NO filtra por
 * approvalState=APROBADA. Una OS entregada SIN cotización aprobada (el
 * cliente rechazó y se llevó el auto) también debe aparecer, con la etiqueta
 * "Entregado sin reparación". Ese era el hueco que producía "entregué y no
 * se actualiza" en el PDF #47. El test 3 lo cubre.
 *
 * CUENTA: la semilla estándar de la suite (#apiToken → prueba@ccc.test /
 * prueba123, ADMIN de taller-prueba; global-setup la siembra solo). La cuenta
 * test@test.com/admin123 vive en QA, no en los emuladores — para correr este
 * flujo contra QA está `ccc-backend/brunoPayloads` o exportar SEED_EMAIL/
 * SEED_PASSWORD/API/ID_WORKSHOP apuntando a ese entorno bajo tu propio riesgo.
 *
 * PRERREQUISITOS (como el resto de operacion/):
 *   1) Emuladores   2) Backend :3001   3) Frontend :3000 (solo el test @ui)
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";
const ADMIN_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const ADMIN_PASSWORD = process.env.SEED_PASSWORD || "prueba123";
// Espejo de ccc-frontend/src/apis/entries.js → PAGE_SIZE_ENTRIES.
const PAGE_SIZE_ENTRIES = 10;

// ── Helpers de API (mismo estilo que jornada-entrega/ciclo-completo) ─────────

async function call(request, method, path, body, { allowFail = false } = {}) {
  // Q20: la API blindada exige el token firmado en CADA llamada.
  const res = await request[method](`${API}${path}`, {
    headers: await authHeaders(),
    ...(body ? { data: body } : {}),
  });
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

const statusOf = async (request, entryId) =>
  (await getJson(request, `/entries/${entryId}`))?.statusService;

/** El idWorkshop REAL de la cuenta, leído del claim del token (defensa por si
 *  la semilla cambia de taller; cae a ID_WORKSHOP si el claim no viene). */
async function workshopFromToken() {
  try {
    const payload = (await getApiToken()).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    return claims.idWorkshop || ID_WORKSHOP;
  } catch {
    return ID_WORKSHOP;
  }
}

let seq = 40;

/**
 * Flujo completo hasta ENTREGADO. Devuelve los datos con los que la página
 * de entregados podría encontrar (o no) al vehículo.
 */
async function deliverNewOs(request, tag, { approve = true } = {}) {
  const idWorkshop = await workshopFromToken();
  const s = `${String(Date.now()).slice(-6)}${seq++}`;
  const fullName = `Cliente PDF47 ${tag} ${s}`;
  const plates = `P47${s.slice(-5)}`; // placas únicas → búsqueda inequívoca

  // 1. Cliente + auto
  const client = (await post(request, "/clients", {
    fullName,
    email: `pdf47.${tag}.${s}@test.com`,
    phone: `57${s}0000000000`.slice(0, 10),
    idWorkshop,
    createdBy: MECHANIC_ID,
  })).data;
  const car = (await post(request, "/cars", {
    clientId: idOf(client),
    brand: "Nissan",
    model: `Versa P47-${tag}`,
    year: 2023,
    vin: `P47${tag}${s}00000000000`.slice(0, 17),
    codeCar: plates,
    color: "Gris",
    fuel: "Gasolina",
    transmition: "Automática",
    km: 18000,
  })).data;

  // 2. OS + hoja de servicio
  const entry = (await post(request, "/entries", {
    idWorkshop,
    clientId: idOf(client),
    carId: idOf(car),
    assigned_mechanic: MECHANIC_ID,
    status: 1,
    observations: `PDF47 ${tag}: no actualiza entregados`,
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  })).data;
  const entryId = idOf(entry);
  await post(request, `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos"],
    checks: ["Afinación"],
    isCheckAll: false,
    observations: `PDF47 ${tag}`,
    km: 18000,
    fuel_tank: "3/4",
  });

  // 3. Diagnóstico (obligatorio: sin él la entrega se bloquea con 409 — Q11)
  await post(request, `/entries/${entryId}/diagnostics`, {
    idMechanic: MECHANIC_ID,
    generalObservations: "Afinación mayor requerida.",
    findings: [
      {
        id: "p47-verde",
        system: "Motor",
        component: "Bujías",
        finding: "Desgaste normal.",
        severity: "VERDE",
        recommendation: "Afinación mayor.",
        commercialDescription: "Afinación para mantener el rendimiento.",
        consequence: "Mayor consumo de gasolina.",
      },
    ],
  });

  // 4. Cotización con precio (solo mano de obra: sin compras de por medio)
  await post(request, `/entries/${entryId}/quotes`, {
    diagnostic: "Afinación mayor",
    labor: [{ description: "Afinación mayor", count: 1, cost: 1200, subtotal: 1200 }],
    parts: [],
    status: 2,
    stage: "COTIZACION",
  });

  if (approve) {
    // 5. Aprobación (selección oficial + estado APROBADA, como la app)
    const quotes = (await getJson(request, `/entries/${entryId}/quotes?limit=10`))?.quotes ?? [];
    const sheets = (await getJson(request, `/entries/${entryId}/service-sheet?limit=10`))?.serviceSheets ?? [];
    const realQuote = quotes.find((q) => q?.stage !== "COSTEO") ?? quotes[0];
    await put(request, `/entries/${entryId}/approve-selection`, {
      approvedQuoteId: idOf(realQuote),
      approvedServiceSheetId: idOf(sheets[0]),
    });
    await put(request, `/entries/${entryId}`, { approvalState: "APROBADA" });

    // 6. Ciclo hacia la entrega. Los pasos intermedios son tolerantes
    //    (allowFail): la máquina de estados ya tiene sus propios specs
    //    (q5-maquina-estados); aquí lo que se vigila es la ENTREGA y su lista.
    await put(request, `/entries/${entryId}`, { repairReadiness: "COMPLETO" }, { allowFail: true });
    await post(request, `/entries/${entryId}/production/start`, null, { allowFail: true });
    await post(request, `/entries/${entryId}/production/finish`, null, { allowFail: true });
    await put(request, `/entries/${entryId}`, { statusService: "LAVADO" }, { allowFail: true });
    await put(request, `/entries/${entryId}`, { statusService: "FINALIZADO" }, { allowFail: true });
  } else {
    // 5'. D9: el cliente RECHAZA la cotización y se lleva el auto sin reparar.
    await put(request, `/entries/${entryId}`, { approvalState: "NO APROBADA" });
  }

  // 7. ENTREGAR — este PUT sí debe proceder (hay diagnóstico; la aprobación
  //    NO es requisito para entregar, decisión D9).
  const delivered = await put(request, `/entries/${entryId}`, { statusService: "ENTREGADO" });
  expect(delivered.status, "el PUT de entrega debe responder OK").toBeLessThan(300);
  expect(await statusOf(request, entryId)).toBe("ENTREGADO");

  return { entryId, idWorkshop, os: entry?.sheet, fullName, plates };
}

/** La MISMA consulta que hace useDeliveredEntriesPage (sin approvalState, D9). */
async function deliveredPage(request, idWorkshop, extra = "") {
  const qs =
    `idWorkshop=${encodeURIComponent(idWorkshop)}` +
    `&statusService=${encodeURIComponent("ENTREGADO")}` +
    (extra || `&limit=${PAGE_SIZE_ENTRIES}&page=1`);
  const data = await getJson(request, `/entries?${qs}`);
  return data?.entries ?? data ?? [];
}

const hasEntry = (rows, entryId) => (rows || []).some((e) => idOf(e) === entryId);

// ── 1. API: la consulta de la página debe traer la OS recién entregada ───────

test(
  "PDF #47 (API): entregar una OS la hace aparecer en la consulta de Vehículos entregados",
  { tag: ["@api", "@lento"] },
  async ({ request }) => {
    test.setTimeout(120_000);
    const { entryId, idWorkshop, os, plates } = await deliverNewOs(request, "A");

    // Modo paginado — página 1, igual que la pantalla al abrir.
    const page1 = await deliveredPage(request, idWorkshop);
    expect(
      hasEntry(page1, entryId),
      `OS ${os} (${entryId}) entregada pero AUSENTE en la página 1 de entregados ` +
        "(revisar qué escribe el PUT statusService=ENTREGADO / getEntries).",
    ).toBe(true);

    // Modo búsqueda — como cuando el asesor teclea las placas en la página.
    const porBusqueda = await deliveredPage(request, idWorkshop, `&search=${encodeURIComponent(plates)}`);
    expect(
      hasEntry(porBusqueda, entryId),
      `OS ${os}: la búsqueda por placas "${plates}" en entregados no la encuentra.`,
    ).toBe(true);
  },
);

// ── 2. UI: la pantalla "Vehículos entregados" la muestra de verdad ───────────

test(
  "PDF #47 (UI): la página Vehículos entregados muestra la OS recién entregada",
  { tag: ["@ui", "@lento"] },
  async ({ page, request }) => {
    test.setTimeout(240_000);
    const { os, fullName, plates } = await deliverNewOs(request, "B");

    // Login con la cuenta semilla (misma que usa toda la suite).
    await page.goto("/login");
    await page.locator("#email").fill(ADMIN_EMAIL);
    await page.locator("#password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /iniciar sesión/i }).click();
    await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });

    // Página de entregados: la entrega recién hecha debe estar en la lista.
    // La página pinta tarjetas de escritorio Y de móvil (una queda oculta por
    // CSS responsivo) → filtrar a las VISIBLES para no agarrar la gemela oculta.
    await page.goto("/servicios-entregados");
    await expect(
      page
        .getByText(new RegExp(plates, "i"))
        .or(page.getByText(fullName))
        .filter({ visible: true })
        .first(),
      `La OS ${os} entregada no se ve en /servicios-entregados (PDF #47).`,
    ).toBeVisible({ timeout: 20000 });

    // Y la búsqueda de la página también la encuentra (modo search del hook).
    await page.getByPlaceholder(/nombre, email, tel/i).fill(plates);
    await expect(
      page.getByText(new RegExp(plates, "i")).filter({ visible: true }).first(),
      `La búsqueda "${plates}" dentro de Vehículos entregados no la encuentra.`,
    ).toBeVisible({ timeout: 20000 });
  },
);

// ── 3. D9: entregada SIN aprobación → aparece, con "Entregado sin reparación" ─

test(
  "PDF #47 / D9: una OS entregada SIN cotización aprobada aparece en Vehículos entregados con la etiqueta 'Entregado sin reparación'",
  { tag: ["@ui", "@lento"] },
  async ({ page, request }) => {
    test.setTimeout(240_000);
    const { entryId, idWorkshop, os, plates } = await deliverNewOs(request, "N", { approve: false });

    // API: la consulta de la página (sin filtro de aprobación) la trae.
    const page1 = await deliveredPage(request, idWorkshop);
    expect(
      hasEntry(page1, entryId),
      `OS ${os} entregada SIN aprobación no sale en la consulta de entregados — ` +
        "¿volvió el filtro approvalState=APROBADA al hook? (D9)",
    ).toBe(true);
    const found = page1.find((e) => idOf(e) === entryId);
    expect(found?.approvalState, "la entrada debe seguir NO APROBADA").not.toBe("APROBADA");

    // UI: se ve en la lista y lleva la etiqueta de deslinde.
    await page.goto("/login");
    await page.locator("#email").fill(ADMIN_EMAIL);
    await page.locator("#password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /iniciar sesión/i }).click();
    await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });

    await page.goto("/servicios-entregados");
    await page.getByPlaceholder(/nombre, email, tel/i).fill(plates);
    await expect(
      page.getByText(new RegExp(plates, "i")).filter({ visible: true }).first(),
      `La OS ${os} (sin aprobación) no se ve en /servicios-entregados.`,
    ).toBeVisible({ timeout: 20000 });
    await expect(
      page.getByText(/entregado sin reparaci[oó]n/i).filter({ visible: true }).first(),
      `Falta la etiqueta "Entregado sin reparación" en la OS ${os}.`,
    ).toBeVisible({ timeout: 10000 });
  },
);
