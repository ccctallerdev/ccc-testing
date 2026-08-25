/**
 * Helpers compartidos de la carpeta obs16ago (revisión de observaciones del
 * cliente del 16-ago-2026, correcciones del 25-ago). Mismo estilo que
 * direccion/triviales.spec.js para no reinventar nada.
 */
const { authHeaders } = require("#apiToken");

const API = process.env.API || "http://localhost:3001/v1";
const AUTH_EMU = process.env.AUTH_EMU || "http://127.0.0.1:9099";
const PROJECT_ID = process.env.EMU_PROJECT_ID || "ccc-taller-refac";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";
const ADMIN_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const ADMIN_PASSWORD = process.env.SEED_PASSWORD || "prueba123";

const stamp = () => `${String(Date.now()).slice(-6)}`;
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

/** Llamada con el token del admin semilla. Truena si no es 2xx. */
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

/** Llamada con un token dado; NO truena: devuelve status + body. */
async function api(request, token, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json, data: json?.data ?? json };
}

/** idToken del emulador de Auth (la key la ignora el emulador). */
async function tokenFor(request, email, password) {
  const res = await request.post(
    `${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`,
    { data: { email, password, returnSecureToken: true } },
  );
  if (!res.ok()) throw new Error(`signIn ${email} → ${res.status()}: ${await res.text()}`);
  return (await res.json()).idToken;
}

/** Cliente + auto nuevos (afiliados al taller vía with-account, sin correo real). */
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

/** Entrada nueva (OS) con hoja de servicio. */
async function makeEntry(request, { tag = "OBS", withSheet = true } = {}) {
  const s = stamp();
  const { client, car } = await makeClientCar(request, s, tag);
  const entry = await post(request, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId: idOf(client),
    carId: idOf(car),
    assigned_mechanic: MECHANIC_ID,
    status: 1,
    observations: `${tag} ${s}`,
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  });
  const entryId = idOf(entry);
  if (withSheet) {
    await post(request, `/entries/${entryId}/service-sheet`, {
      car_items: ["Documentos"],
      checks: ["Motor"],
      isCheckAll: false,
      observations: `${tag} ${s}`,
      km: 50000,
      fuel_tank: "1/2",
    });
  }
  return { entryId, os: String(entry?.sheet ?? ""), s, client, car };
}

/**
 * OS aprobada con cotización (700 MO + refacción de TEXTO LIBRE a 1450 sin
 * costo de proveedor) — dispara la orden de compra automática "Sin proveedor".
 */
async function makeApprovedOs(request, { tag = "OBS", partName, partCostProveedor } = {}) {
  const e = await makeEntry(request, { tag });
  const part = partName || `Bomba de agua ${tag} ${e.s}`;
  await post(request, `/entries/${e.entryId}/diagnostics`, {
    idMechanic: MECHANIC_ID,
    generalObservations: "Fuga de refrigerante.",
    findings: [
      {
        id: `${tag}-rojo`,
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
  await post(request, `/entries/${e.entryId}/quotes`, {
    diagnostic: "Cambio de bomba de agua",
    labor: [{ description: "Cambio de bomba", count: 1, cost: 700, subtotal: 700 }],
    parts: [
      {
        description: part,
        count: 1,
        cost: 1450,
        subtotal: 1450,
        ...(partCostProveedor != null ? { costProveedor: partCostProveedor } : {}),
      },
    ],
    status: 2,
    stage: "COTIZACION",
  });
  const quotes = (await getJson(request, `/entries/${e.entryId}/quotes?limit=10`))?.quotes ?? [];
  const sheets = (await getJson(request, `/entries/${e.entryId}/service-sheet?limit=10`))?.serviceSheets ?? [];
  await put(request, `/entries/${e.entryId}/approve-selection`, {
    approvedQuoteId: idOf(quotes[0]),
    approvedServiceSheetId: idOf(sheets[0]),
  });
  await put(request, `/entries/${e.entryId}`, { approvalState: "APROBADA" });
  return { ...e, quoteId: idOf(quotes[0]), partName: part };
}

/** Proveedor nuevo. */
async function makeSupplier(request, s, tag) {
  const name = `Refaccionaria ${tag} ${s}`;
  const supplier = await post(request, "/suppliers", {
    idWorkshop: ID_WORKSHOP,
    name,
    contactName: tag,
    phone: `54${s}0000000000`.slice(0, 10),
    email: `${tag.toLowerCase()}.${s}@prov.test`,
  });
  return { supplierId: idOf(supplier), supplierName: name };
}

async function login(page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });
}

/** Lista de clientes del taller (se arma por tokens: incluye tokenId). */
async function clientsOfWorkshop(request, search = "") {
  const q = search ? `&search=${encodeURIComponent(search)}` : "";
  const data = await getJson(request, `/clients?idWorkshop=${ID_WORKSHOP}&limit=100${q}`);
  return Array.isArray(data?.clients) ? data.clients : [];
}

module.exports = {
  API,
  AUTH_EMU,
  PROJECT_ID,
  ID_WORKSHOP,
  MECHANIC_ID,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  stamp,
  idOf,
  call,
  post,
  put,
  getJson,
  api,
  tokenFor,
  makeClientCar,
  makeEntry,
  makeApprovedOs,
  makeSupplier,
  login,
  clientsOfWorkshop,
};
