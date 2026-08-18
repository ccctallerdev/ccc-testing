const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * MEDIANOS del backlog (13-ago) — respuestas de Roberto del 14-ago ("Correcto"
 * a todas las propuestas). Un `test` por fix, todos con la etiqueta @medianos:
 *
 *   npx playwright test --project=direccion --grep "@medianos"
 *
 *   M1 · Agenda: azul = prometidos del día, rojo = promesa vencida sin
 *        ENTREGADO, contador por día (PDF #4–5 / D1).
 *   M2 · Anticipos: línea "Saldo pendiente" = total cotización oficial
 *        aprobada − abonado (PDF #34 / D2).
 *   M3 · Abastecimiento: activos (vehículos en el taller) vs Histórico con
 *        filtros por proveedor/OS/fechas + cumplimiento por proveedor en
 *        Mejora Continua (PDF #41 / D3).
 *   M4 · Garantías: histórico consultable en vez de "Eliminar del historial"
 *        + garantías por proveedor en Mejora Continua (PDF #56 / D4).
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
    phone: `55${s}`,
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
    phone: `54${s}`,
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

// ═════════════════════════════════ M1 ══════════════════════════════════════
test(
  "M1 / D1: Agenda pinta azul los prometidos del día, rojo las promesas vencidas y muestra el contador por día",
  { tag: ["@medianos", "@ui", "@lento"] },
  async ({ page, request }) => {
    test.setTimeout(240_000);
    const now = Date.now();
    // Prometido HOY (vigente): dentro de 1 h, salvo que cruce medianoche → +5 min.
    let dueMs = now + 60 * 60 * 1000;
    if (new Date(dueMs).getDate() !== new Date(now).getDate()) dueMs = now + 5 * 60 * 1000;
    // Vencida: hace 3 h (con hora explícita → el límite es ese instante).
    const overdueMs = now - 3 * 60 * 60 * 1000;

    const due = await makeApprovedOs(request, { tag: "PROM", promiseDate: dueMs });
    const late = await makeApprovedOs(request, { tag: "REZ", promiseDate: overdueMs });

    // ── API: el endpoint clasifica bien ──
    const data = await getJson(request, `/entries/promises?idWorkshop=${ID_WORKSHOP}`);
    const list = data?.promises ?? [];
    const pDue = list.find((p) => p.id === due.entryId);
    const pLate = list.find((p) => p.id === late.entryId);
    expect(pDue, "la OS prometida hoy aparece").toBeTruthy();
    expect(pDue.overdue, "prometida hoy NO está vencida").toBe(false);
    expect(pLate, "la OS con promesa pasada aparece").toBeTruthy();
    expect(pLate.overdue, "promesa pasada sin ENTREGADO = rezago").toBe(true);

    // ── UI: Agenda ──
    await login(page);
    await page.goto("/agenda");
    const resumen = page.getByTestId("agenda-promesas-resumen");
    await expect(resumen).toBeVisible({ timeout: 20000 });
    await expect(resumen).toContainText(/promesas de entrega hoy/i);
    await expect(resumen).toContainText(/\d+ prometid/i);
    await expect(resumen).toContainText(/\d+ rezago/i);

    // Contador por día en la celda de hoy ("N prometidos · M rezagos") — vista Mes.
    const todayCell = page.locator(".fc-daygrid-day.fc-day-today");
    await expect(todayCell.getByTestId("agenda-day-counter")).toContainText(/prometid|rezago/i, { timeout: 20000 });

    // Eventos coloreados: azul (fc-promise-due) y rojo (fc-promise-overdue) con su OS.
    // Se comprueban en la vista Lista (la de Mes colapsa en "+N más" cuando hay
    // muchos eventos el mismo día; las clases/colores son los mismos).
    // El botón de la vista lista se llama "Agenda" (petición del cliente); se
    // toma por su clase de FullCalendar para no confundirlo con el menú lateral.
    await page.locator(".fc-listMonth-button").click();
    const evDue = page.locator(".fc-promise-due", { hasText: `OS ${due.os}` }).first();
    const evLate = page.locator(".fc-promise-overdue", { hasText: `OS ${late.os}` }).first();
    await expect(evDue, "evento azul del prometido de hoy").toBeVisible({ timeout: 20000 });
    await expect(evLate, "evento rojo de la promesa vencida").toBeVisible();

    // Clic en una promesa → expediente de la OS (no es una cita editable).
    await evDue.click();
    await page.waitForURL(new RegExp(`/expediente/${due.entryId}`), { timeout: 15000 });
  },
);

// ═══════════════════════════════ M1-b ══════════════════════════════════════
test(
  "M1-b: en la Agenda, '+N más' abre TODOS los eventos del día en un popover con scroll (como Google Calendar)",
  { tag: ["@medianos", "@ui", "@lento"] },
  async ({ page, request }) => {
    test.setTimeout(180_000);
    // Limpieza: borra las citas "Cita Popover …" de corridas anteriores para no
    // llenar la agenda del emulador (y al final, las de esta corrida).
    const cleanup = async () => {
      const res = await request.get(`${AGENDA_API}/getevents?idw=${ID_WORKSHOP}`, { headers: await authHeaders() });
      const events = res.ok() ? await res.json() : [];
      for (const ev of Array.isArray(events) ? events : []) {
        if (String(ev?.title ?? "").startsWith("Cita Popover ")) {
          await request.delete(`${AGENDA_API}/delete`, { headers: await authHeaders(), data: { id: ev.id } });
        }
      }
    };
    await cleanup();
    // Citas con horas distintas (06:00, 06:45, 07:30, …) en DOS días: hoy (14) y
    // otro día del mismo mes (12) — mañana, o ayer si mañana ya cae en otro mes.
    const marker = `Cita Popover ${String(Date.now()).slice(-6)}`;
    const today = new Date();
    today.setHours(6, 0, 0, 0);
    const other = new Date(today);
    other.setDate(other.getDate() + 1);
    if (other.getMonth() !== today.getMonth()) other.setDate(today.getDate() - 1);
    const addDay = async (base, n, tag) => {
      for (let i = 0; i < n; i += 1) {
        const start = new Date(base.getTime() + i * 45 * 60 * 1000);
        const res = await request.post(`${AGENDA_API}/addevent`, {
          headers: await authHeaders(),
          data: {
            idWorkshop: ID_WORKSHOP,
            title: `${marker} ${tag} #${i + 1}`,
            description: "prueba popover",
            phone: "5512345678",
            start,
            end: new Date(start.getTime() + 30 * 60 * 1000),
            allDay: false,
            createdBy: "asesor-prueba",
            createdByName: "Asesor Prueba",
          },
        });
        expect(res.ok(), `alta de cita ${tag} #${i + 1}`).toBe(true);
      }
    };
    const N = 14;
    const N2 = 12;
    await addDay(today, N, "HOY");
    await addDay(other, N2, "OTRO");

    await login(page);
    await page.goto("/agenda");
    const todayCell = page.locator(".fc-daygrid-day.fc-day-today");
    await expect(todayCell).toBeVisible({ timeout: 20000 });
    // La celda colapsa el exceso en "+N más".
    const more = todayCell.locator(".fc-daygrid-more-link");
    await expect(more, "enlace '+N más' en la celda de hoy").toBeVisible({ timeout: 20000 });
    await expect(more).toContainText(/más/i);
    await more.click();

    // Popover con TODOS los eventos del día (primera y última cita creadas).
    const pop = page.locator(".fc-more-popover");
    await expect(pop).toBeVisible({ timeout: 10000 });
    // Exacto: "#1" también está contenido en "#10"…"#14".
    await expect(pop.getByText(`${marker} HOY #1`, { exact: true })).toBeVisible();
    await expect(pop.getByText(`${marker} HOY #${N}`, { exact: true })).toBeVisible();
    const count = await pop.locator(".fc-daygrid-event").filter({ hasText: `${marker} HOY` }).count();
    expect(count, "todas las citas de HOY están en el popover").toBe(N);
    // Encabezado del popover de HOY: azul principal con texto blanco.
    await expect(pop).toHaveClass(/fc-day-today/);
    const headerBg = await pop.locator(".fc-popover-header").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(headerBg, "encabezado azul (#2563eb)").toBe("rgb(37, 99, 235)");

    // Con tantos eventos, el cuerpo del popover hace scroll (no se sale de la pantalla).
    const scrollable = await pop.locator(".fc-popover-body").evaluate((el) => el.scrollHeight > el.clientHeight + 4);
    expect(scrollable, "el popover tiene scroll interno").toBe(true);

    // PAUSA MANUAL: con PAUSA=1 el test se detiene aquí (popover abierto, 14 citas
    // de hoy cargadas) y abre el Inspector de Playwright para que pruebes a mano
    // (Mes / Semana / Agenda, scroll del popover, tarjetas). Al darle "Resume"
    // en el Inspector el test sigue y borra sus citas de prueba.
    //   PowerShell:  $env:PAUSA="1"; npx playwright test --project=direccion --grep "M1-b" --headed --timeout=0
    //   Bash:        PAUSA=1 npx playwright test --project=direccion --grep "M1-b" --headed --timeout=0
    if (process.env.PAUSA) await page.pause();

    // Se cierra con la X.
    await pop.locator(".fc-popover-close").click();
    await expect(pop).toHaveCount(0);

    // El OTRO día también colapsa y su popover trae sus 12 (y NO lleva el azul de hoy).
    const otherKey = `${other.getFullYear()}-${String(other.getMonth() + 1).padStart(2, "0")}-${String(other.getDate()).padStart(2, "0")}`;
    const otherCell = page.locator(`.fc-daygrid-day[data-date="${otherKey}"]`);
    await otherCell.locator(".fc-daygrid-more-link").click();
    const pop2 = page.locator(".fc-more-popover");
    await expect(pop2).toBeVisible({ timeout: 10000 });
    const count2 = await pop2.locator(".fc-daygrid-event").filter({ hasText: `${marker} OTRO` }).count();
    expect(count2, "todas las citas del OTRO día están en su popover").toBe(N2);
    await expect(pop2).not.toHaveClass(/fc-day-today/);
    await pop2.locator(".fc-popover-close").click();

    await cleanup();
  },
);

// ═════════════════════════════════ M2 ══════════════════════════════════════
test(
  "M2 / D2: Anticipos muestra 'Saldo pendiente' = total cotización oficial aprobada − abonado",
  { tag: ["@medianos", "@ui", "@lento"] },
  async ({ page, request }) => {
    test.setTimeout(180_000);
    const os = await makeApprovedOs(request, { tag: "ANT" });
    // Abono de $500 sobre los $2,150 de la cotización oficial → saldo $1,650.
    await post(request, `/entries/${os.entryId}/quotes/${os.quoteId}/advances`, {
      amount: 500,
      note: "Anticipo M2",
    });

    await login(page);
    await page.goto("/registro?tab=aprobados");
    const search = page.getByRole("search", { name: /buscar orden de servicio/i });
    await search.getByRole("textbox").fill(os.os);
    await search.getByRole("textbox").press("Enter");
    // La fila de la OS buscada trae el botón "Anticipos".
    await page.getByRole("button", { name: /^anticipos$/i }).first().click({ timeout: 20000 });

    const saldo = page.getByTestId("anticipos-saldo-pendiente");
    await expect(saldo).toBeVisible({ timeout: 15000 });
    await expect(saldo).toContainText(/saldo pendiente/i);
    await expect(saldo).toContainText(/1,?650/);
    // Y el total abonado sigue mostrando la base ("$500 de $2,150").
    await expect(page.locator(".ant-modal").last()).toContainText(/2,?150/);
  },
);

// ═════════════════════════════════ M3 ══════════════════════════════════════
test(
  "M3 / D3: Abastecimiento separa activos (en taller) de histórico (entregados) con filtros, y Mejora Continua muestra el cumplimiento por proveedor",
  { tag: ["@medianos", "@ui", "@lento"] },
  async ({ page, request }) => {
    test.setTimeout(240_000);
    const os = await makeApprovedOs(request, { tag: "ABH" });
    const sup = await makeSupplier(request, os.s, "ABH");
    const poId = await makeReceivedPo(request, { entryId: os.entryId, supplierId: sup.supplierId, partName: os.partName });

    // Mientras el auto está en el taller: la orden es ACTIVA.
    let active = await getJson(request, `/purchase-orders?idWorkshop=${ID_WORKSHOP}`);
    expect((active?.orders ?? []).some((o) => o.id === poId), "orden visible en activos con el auto en taller").toBe(true);

    // Se entrega el vehículo → la orden pasa al histórico.
    await put(request, `/entries/${os.entryId}`, { statusService: "ENTREGADO" });
    active = await getJson(request, `/purchase-orders?idWorkshop=${ID_WORKSHOP}`);
    expect((active?.orders ?? []).some((o) => o.id === poId), "orden YA NO aparece en activos").toBe(false);

    const hist = await getJson(
      request,
      `/purchase-orders?idWorkshop=${ID_WORKSHOP}&scope=history&supplierId=${sup.supplierId}&sheet=${os.os}`,
    );
    expect((hist?.orders ?? []).some((o) => o.id === poId), "orden en histórico filtrando por proveedor y OS").toBe(true);
    const perf = (hist?.suppliers ?? []).find((s) => s.supplierId === sup.supplierId);
    expect(perf, "cumplimiento por proveedor incluye al proveedor").toBeTruthy();
    expect(perf.orders).toBeGreaterThanOrEqual(1);
    expect(perf.onTime, "recibida antes de la fecha esperada = a tiempo").toBeGreaterThanOrEqual(1);
    expect(perf.pctNotFound).toBe(0);

    // Un filtro que NO coincide deja el histórico vacío para esa OS.
    const none = await getJson(request, `/purchase-orders?idWorkshop=${ID_WORKSHOP}&scope=history&sheet=${os.os}&supplierId=no-existe`);
    expect(none?.orders ?? []).toHaveLength(0);

    // ── UI: pestaña Histórico + filtro por OS ──
    await login(page);
    await page.goto("/abastecimiento");
    await page.getByRole("tab", { name: /histórico/i }).click({ timeout: 20000 });
    const historico = page.getByTestId("abastecimiento-historico");
    await expect(historico).toBeVisible();
    await historico.getByLabel(/filtrar por número de os/i).fill(os.os);
    const card = historico.getByTestId("historico-orden").filter({ hasText: `OS ${os.os}` }).first();
    await expect(card).toBeVisible({ timeout: 20000 });
    await expect(card).toContainText(new RegExp(sup.supplierName, "i"));
    await expect(historico.getByTestId("supplier-performance")).toContainText(new RegExp(sup.supplierName, "i"));

    // ── UI: Mejora Continua — evaluación de proveedores ──
    await page.goto("/mejora");
    const tabla = page.getByTestId("supplier-performance");
    await expect(tabla).toBeVisible({ timeout: 20000 });
    await expect(tabla).toContainText(new RegExp(sup.supplierName, "i"));
  },
);

// ═════════════════════════════════ M4 ══════════════════════════════════════
test(
  "M4 / D4: las garantías resueltas pasan a un histórico consultable (ya no se eliminan) y cuentan por proveedor en Mejora Continua",
  { tag: ["@medianos", "@ui", "@lento"] },
  async ({ page, request }) => {
    test.setTimeout(240_000);
    const os = await makeApprovedOs(request, { tag: "GAH" });
    const sup = await makeSupplier(request, os.s, "GAH");
    await makeReceivedPo(request, { entryId: os.entryId, supplierId: sup.supplierId, partName: os.partName });
    await put(request, `/entries/${os.entryId}`, { statusService: "ENTREGADO" });

    const w = await post(request, "/warranties", {
      idWorkshop: ID_WORKSHOP,
      origin: "REFACCION",
      description: `Bomba con fuga a los 3 días (${os.s})`,
      system: "Enfriamiento",
      component: "Bomba de agua",
      entryId: os.entryId,
      supplierId: sup.supplierId,
      cost: 980,
    });
    const wId = idOf(w);
    await put(request, `/warranties/${wId}`, { status: "RESOLVED" });

    // API: activas no la traen; histórico sí (con filtros); indicador por proveedor la cuenta.
    const act = await getJson(request, `/warranties?idWorkshop=${ID_WORKSHOP}&scope=active`);
    expect((act?.warranties ?? []).some((x) => x.id === wId), "resuelta fuera de activas").toBe(false);
    const hist = await getJson(
      request,
      `/warranties?idWorkshop=${ID_WORKSHOP}&scope=history&supplierId=${sup.supplierId}&sheet=${os.os}&origin=REFACCION`,
    );
    expect((hist?.warranties ?? []).some((x) => x.id === wId), "resuelta en histórico con filtros").toBe(true);
    const ind = (hist?.suppliers ?? []).find((s) => s.supplierId === sup.supplierId);
    expect(ind, "garantías por proveedor incluye al proveedor").toBeTruthy();
    expect(ind.total).toBeGreaterThanOrEqual(1);
    expect(ind.resolved).toBeGreaterThanOrEqual(1);

    // Mejora Continua (API): la tabla de proveedores suma sus garantías.
    const mc = await getJson(request, `/improvement?idWorkshop=${ID_WORKSHOP}`);
    const row = (mc?.suppliers ?? []).find((s) => s.supplierId === sup.supplierId);
    expect(row, "Mejora Continua trae al proveedor").toBeTruthy();
    expect(row.warranties).toBeGreaterThanOrEqual(1);

    // ── UI ──
    await login(page);
    await page.goto("/garantias");
    await expect(page.getByRole("heading", { level: 1, name: /garantías/i })).toBeVisible({ timeout: 20000 });
    // Ya no existe "Eliminar del historial".
    await expect(page.getByRole("button", { name: /eliminar del historial/i })).toHaveCount(0);
    await page.getByRole("tab", { name: /histórico/i }).click();
    const historico = page.getByTestId("garantias-historico");
    await expect(historico).toBeVisible();
    await historico.getByLabel(/filtrar por número de os/i).fill(os.os);
    const card = historico.getByTestId("historico-garantia").filter({ hasText: new RegExp(`OS ${os.os}`) }).first();
    await expect(card).toBeVisible({ timeout: 20000 });
    await expect(card).toContainText(/resuelta/i);
    await expect(card).toContainText(new RegExp(sup.supplierName, "i"));
    await expect(historico.getByTestId("garantias-por-proveedor")).toContainText(new RegExp(sup.supplierName, "i"));

    await page.goto("/mejora");
    const tabla = page.getByTestId("supplier-performance");
    await expect(tabla).toBeVisible({ timeout: 20000 });
    await expect(tabla.locator("tr", { hasText: new RegExp(sup.supplierName, "i") })).toBeVisible();
  },
);
