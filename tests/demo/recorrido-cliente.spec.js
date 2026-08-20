const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * DEMO DAY — recorrido de cliente (login + navegación) para que corra SOLO
 * y se vea en vivo, en vez de hacerlo a mano durante la presentación.
 *
 * A propósito NO es un test de regresión: solo cubre el camino feliz, y va
 * deliberadamente lento — el project "demo" en playwright.config.js le pone
 * slowMo entre acciones y siempre graba video. Ajusta el ritmo sin tocar
 * este archivo:
 *
 *   DEMO_SLOWMO=600 DEMO_PAUSE_MS=2000 npm run test:demo
 *
 * DEMO_SLOWMO   → ms de pausa que Playwright mete entre cada acción (click,
 *                 fill, etc). Default 400.
 * DEMO_PAUSE_MS → ms de "silencio" entre secciones del recorrido, para que
 *                 el presentador hable antes de que siga solo. Default 1500.
 *
 * CONTRA EMULADORES (default de hoy): solo `npm run test:demo`, con
 * emuladores + backend + frontend arriba (igual que el resto de la suite,
 * ver tests/README.md).
 *
 * CONTRA PRODUCCIÓN (cuando ya tengas la cuenta de prueba real): exporta
 * BASE_URL/API/SEED_EMAIL/SEED_PASSWORD/ID_WORKSHOP + SKIP_SEED=1 — ver
 * tests/README.md, sección "Correr demo contra producción". No hace falta
 * tocar este archivo, todo lo lee de variables de entorno.
 *
 * Para tener SIEMPRE algo real que enseñar (sin depender de qué haya
 * quedado sembrado de antes), el propio spec arma DOS vehículos por API
 * antes de navegar: uno recién entregado (para "Entregados" + buscador) y
 * otro que se queda ACTIVO en el taller (para el panel de Registro). Esa
 * parte es rápida y silenciosa a propósito; lo que se ve lento y en cámara
 * es la navegación como la vería un cliente/taller usando la app.
 *
 * OJO: /registro filtra en el front los que ya están ENTREGADO (ver
 * Entrada.jsx) — por eso el vehículo entregado NO puede ser el mismo que
 * se usa para mostrar el panel de Registro; necesitan ser dos.
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";
const EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const PASSWORD = process.env.SEED_PASSWORD || "prueba123";
const PAUSE_MS = Number(process.env.DEMO_PAUSE_MS) || 1500;

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
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

/** Pausa narrativa (no es una espera técnica de sincronización): le da
 * tiempo al presentador de hablar de lo que se acaba de ver antes de que
 * el recorrido siga solo. */
const beat = (page) => page.waitForTimeout(PAUSE_MS);

/** Crea cliente + auto + OS con hoja de servicio (status 1, sin diagnóstico
 * todavía) — la base común para los dos vehículos de la demo. */
async function crearOsBase(request, { tag, plates, model }) {
  const s = `${String(Date.now()).slice(-6)}`;
  const fullName = `Cliente Demo ${tag} ${s}`;

  const client = await call(request, "post", "/clients", {
    fullName,
    email: `demo.${tag}.${s}@test.com`,
    phone: `55${s}`,
    idWorkshop: ID_WORKSHOP,
    createdBy: MECHANIC_ID,
  });
  const car = await call(request, "post", "/cars", {
    clientId: idOf(client),
    brand: "Nissan",
    model,
    year: 2023,
    vin: `DEMO${tag}${s}00000000000`.slice(0, 17),
    codeCar: plates,
    color: "Blanco",
    fuel: "Gasolina",
    transmition: "Automática",
    km: 12000,
  });
  const entry = await call(request, "post", "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId: idOf(client),
    carId: idOf(car),
    assigned_mechanic: MECHANIC_ID,
    status: 1,
    observations: `Demo Day: recorrido de cliente (${tag})`,
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  });
  const entryId = idOf(entry);

  await call(request, "post", `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos"],
    checks: ["Afinación"],
    isCheckAll: false,
    observations: "Demo",
    km: 12000,
    fuel_tank: "3/4",
  });

  return { entryId, plates, fullName };
}

/** Vehículo que se queda ACTIVO en el taller (pendiente de diagnóstico) —
 * para mostrar el panel de Registro. */
async function seedVehiculoActivo(request) {
  const s = String(Date.now()).slice(-4);
  return crearOsBase(request, { tag: "A", plates: `DEMOA${s}`, model: "Versa Demo Activo" });
}

/**
 * Vehículo que se lleva HASTA ENTREGADO — para mostrar "Vehículos
 * entregados" y el buscador. Mismo camino que
 * operacion/pdf47-vehiculos-entregados.spec.js, con menos pasos porque
 * aquí no se está probando nada, solo generando datos.
 */
async function seedVehiculoEntregado(request) {
  const s = String(Date.now()).slice(-4);
  const { entryId, plates, fullName } = await crearOsBase(request, {
    tag: "E",
    plates: `DEMOE${s}`,
    model: "Versa Demo Entregado",
  });

  await call(request, "post", `/entries/${entryId}/diagnostics`, {
    idMechanic: MECHANIC_ID,
    generalObservations: "Revisión general para la demo.",
    findings: [
      {
        id: "demo-verde",
        system: "Motor",
        component: "Bujías",
        finding: "Desgaste normal.",
        severity: "VERDE",
        recommendation: "Afinación preventiva.",
        commercialDescription: "Afinación para mantener el rendimiento.",
        consequence: "Mayor consumo de gasolina.",
      },
    ],
  });
  await call(request, "post", `/entries/${entryId}/quotes`, {
    diagnostic: "Afinación preventiva",
    labor: [{ description: "Afinación", count: 1, cost: 900, subtotal: 900 }],
    parts: [],
    status: 2,
    stage: "COTIZACION",
  });

  const quotesResp = await call(request, "get", `/entries/${entryId}/quotes?limit=10`);
  const sheetsResp = await call(request, "get", `/entries/${entryId}/service-sheet?limit=10`);
  const quotes = quotesResp?.quotes ?? [];
  const sheets = sheetsResp?.serviceSheets ?? [];
  const realQuote = quotes.find((q) => q?.stage !== "COSTEO") ?? quotes[0];

  await call(request, "put", `/entries/${entryId}/approve-selection`, {
    approvedQuoteId: idOf(realQuote),
    approvedServiceSheetId: idOf(sheets[0]),
  });
  await call(request, "put", `/entries/${entryId}`, { approvalState: "APROBADA" });
  await call(request, "put", `/entries/${entryId}`, { statusService: "ENTREGADO" });

  return { plates, fullName, entryId };
}

test(
  "Demo Day: recorrido de cliente por la app (login → panel → entregados → buscador)",
  { tag: ["@ui", "@lento"] },
  async ({ page, request }) => {
    test.setTimeout(10 * 60_000);

    const { activo, entregado } = await test.step(
      "Preparar en silencio (por API) un vehículo activo y uno entregado",
      async () => {
        const activo = await seedVehiculoActivo(request);
        const entregado = await seedVehiculoEntregado(request);
        return { activo, entregado };
      },
    );

    await test.step("Iniciar sesión como el taller", async () => {
      await page.goto("/login");
      await page.locator("#email").fill(EMAIL);
      await beat(page);
      await page.locator("#password").fill(PASSWORD);
      await page.getByRole("button", { name: /iniciar sesión/i }).click();
      await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });
      await beat(page);
    });

    await test.step("Ver el panel de Registro (lo que ve el taller cada día)", async () => {
      await page.goto("/registro");
      const card = page.locator("div.rounded-xl.border", { hasText: activo.plates }).first();
      await expect(card).toBeVisible({ timeout: 15000 });
      await beat(page);
    });

    await test.step("Abrir Vehículos entregados (el fix del reporte del cliente)", async () => {
      await page.goto("/servicios-entregados");
      await expect(
        page
          .getByText(new RegExp(entregado.plates, "i"))
          .or(page.getByText(entregado.fullName))
          .filter({ visible: true })
          .first(),
      ).toBeVisible({ timeout: 20000 });
      await beat(page);
    });

    await test.step("Buscar el vehículo recién entregado por placas", async () => {
      await page.getByPlaceholder(/nombre, email, tel/i).fill(entregado.plates);
      await expect(
        page.getByText(new RegExp(entregado.plates, "i")).filter({ visible: true }).first(),
      ).toBeVisible({ timeout: 20000 });
      await beat(page);
    });
  },
);
