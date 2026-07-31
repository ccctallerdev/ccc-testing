const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * Obs 8-jul #1 — Vista por mecánico en el Centro de Producción:
 *   - Un MECANICO que inicia sesión ve SOLO sus autos asignados.
 *   - El ADMIN ve la panorámica general (todos los mecánicos).
 *
 * El test crea a SU PROPIO segundo mecánico (con cuenta de Auth, vía
 * POST /users) y dos OS aprobadas con cotización oficial: una para el
 * mecánico semilla (A) y otra para el nuevo (B).
 *
 * PRERREQUISITOS: emuladores + backend + frontend (global-setup siembra
 * al admin y al mecánico A).
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC_A = "mecanico-prueba"; // sembrado por global-setup (sin login)
const ADMIN_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const ADMIN_PASSWORD = process.env.SEED_PASSWORD || "prueba123";

const suffix = `${String(Date.now()).slice(-6)}`;
const MECH_B_EMAIL = `mecb.${suffix}@ccc.test`;
const MECH_B_PASSWORD = "Mecanico_123";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

let seq = 40;
async function approvedOsFor(request, mechanicId, tag) {
  const s = `${String(Date.now()).slice(-6)}${seq++}`;
  const client = await post(request, "/clients", {
    fullName: `Cliente PM ${tag} ${s}`,
    email: `pm.${tag}.${s}@test.com`,
    phone: `54${s}`,
    idWorkshop: ID_WORKSHOP,
    createdBy: mechanicId,
  });
  const car = await post(request, "/cars", {
    clientId: idOf(client),
    brand: "Ford",
    model: `Focus ${tag}`,
    year: 2021,
    vin: `PM${tag}${s}000000000`.slice(0, 17),
    codeCar: `PM${tag}${s.slice(-4)}`.slice(0, 8),
    color: "Azul",
    fuel: "Gasolina",
    transmition: "Manual",
    km: 40000,
  });
  const entry = await post(request, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId: idOf(client),
    carId: idOf(car),
    assigned_mechanic: mechanicId,
    status: 1,
    observations: `PM ${tag}`,
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  });
  const entryId = idOf(entry);
  await post(request, `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos"],
    checks: ["Servicio de Frenos"],
    isCheckAll: false,
    observations: `PM ${tag}`,
    km: 40000,
    fuel_tank: "1/2",
  });
  await post(request, `/entries/${entryId}/quotes`, {
    diagnostic: `PM ${tag}`,
    labor: [{ description: "Mano de obra", count: 1, cost: 600, subtotal: 600 }],
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
  return { entryId, os: entry?.sheet };
}

async function login(page, email, password) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });
}

test("producción por mecánico: cada quien ve solo lo suyo; el admin ve todo", { tag: ["@ui", "@lento"] }, async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  // Mecánico B con cuenta de Auth propia (POST /users crea Auth + perfil).
  await post(request, "/users", {
    idWorkshop: ID_WORKSHOP,
    name: "Mecánico",
    firstSurname: `B${suffix}`,
    email: MECH_B_EMAIL,
    password: MECH_B_PASSWORD,
    rol: "MECANICO",
    country: "México",
    phone: `55${suffix}9`,
    // El backend exige photoURL válida al crear el usuario.
    photoURL: "https://firebasestorage.googleapis.com/v0/b/placeholder/o/user.png?alt=media",
  });

  // Una OS aprobada para cada mecánico.
  const osA = await approvedOsFor(request, MECHANIC_A, "A");
  const bUser = await getJson(request, `/users/email/${encodeURIComponent(MECH_B_EMAIL)}`);
  const mechBId = idOf(bUser);
  expect(mechBId, "uid del mecánico B").toBeTruthy();
  const osB = await approvedOsFor(request, mechBId, "B");

  // ── Como MECÁNICO B: solo su auto ──────────────────────────────────────────
  await login(page, MECH_B_EMAIL, MECH_B_PASSWORD);
  await page.goto("/produccion");
  await expect(page.getByText(/tus autos asignados/i)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(`OS ${osB.os}`).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(`OS ${osA.os}`)).toHaveCount(0);

  // ── Como ADMIN: panorámica con ambos ───────────────────────────────────────
  // Contexto de navegador NUEVO (sesión limpia) para no pelear con el logout.
  const BASE = process.env.BASE_URL || "http://localhost:3000";
  const adminContext = await page.context().browser().newContext();
  const adminPage = await adminContext.newPage();
  await adminPage.goto(`${BASE}/login`);
  await adminPage.locator("#email").fill(ADMIN_EMAIL);
  await adminPage.locator("#password").fill(ADMIN_PASSWORD);
  await adminPage.getByRole("button", { name: /iniciar sesión/i }).click();
  await adminPage.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });
  await adminPage.goto(`${BASE}/produccion`);
  await expect(adminPage.getByText(/panorámica general/i)).toBeVisible({ timeout: 15000 });
  await expect(adminPage.getByText(`OS ${osA.os}`).first()).toBeVisible({ timeout: 15000 });
  await expect(adminPage.getByText(`OS ${osB.os}`).first()).toBeVisible({ timeout: 15000 });
  await adminContext.close();
});
