const { test, expect } = require("@playwright/test");
const { getApiToken, authHeaders } = require("#apiToken");

/**
 * C5 — Evidencia en Storage AISLADA POR TALLER (backlog técnico #2).
 *
 * Antes la evidencia vivía en `{clientId}/{entryId}/(service|serviceflow|
 * diagnostics)/...` con regla "cualquier autenticado". Ahora el front arma la
 * ruta con el taller como PRIMER segmento (`{idWorkshop}/{clientId}/{entryId}/
 * ...`, leyendo el idWorkshop del claim del token) y storage.rules compara
 * ese segmento contra el claim, igual que el logo.
 *
 * Qué vigila este spec:
 *   1) [@ui] Subir una foto desde el Expediente la deja en la RUTA NUEVA
 *      `taller-prueba/{clientId}/{entryId}/service/…` (y NO en la legada), y
 *      la pantalla la lista.
 *   2) [@api] Aislamiento en las reglas vía REST del emulador de Storage:
 *      con el token del taller A, escribir/leer bajo el taller B → 403;
 *      escribir en la ruta LEGADA → 403 (solo lectura de compatibilidad).
 *
 * El emulador de Storage acepta el idToken del emulador de Auth en el header
 * Authorization (Firebase ...) y aplica storage.rules — por eso el caso 2 no
 * necesita @firebase/rules-unit-testing (esa suite ya vive en
 * ccc-backend/tests/storage.rules.test.js); aquí se prueba el conjunto real
 * front + reglas desplegadas en el emulador.
 *
 * PRERREQUISITOS: emuladores (auth 9099, storage 9199) + backend :3001 +
 * frontend :3000 (solo el @ui). Cuenta semilla vía #apiToken (taller-prueba).
 */

const API = process.env.API || "http://localhost:3001/v1";
const STORAGE_EMU = process.env.STORAGE_EMU || "http://127.0.0.1:9199";
const BUCKET =
  process.env.STORAGE_BUCKET || "ccc-taller-refac.firebasestorage.app";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const OTHER_WORKSHOP = process.env.ID_WORKSHOP_B || "taller-prueba-b";
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";
const ADMIN_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const ADMIN_PASSWORD = process.env.SEED_PASSWORD || "prueba123";

// PNG 1x1 válido (para que el input accept="image/*" y el upload lo tomen).
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

// ── Helpers de API (mismo estilo que el resto de operacion/) ─────────────────

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
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

/** Cliente + auto + OS mínima (basta para abrir el Expediente). */
async function makeOs(request, tag) {
  const s = `${String(Date.now()).slice(-6)}`;
  const client = await post(request, "/clients", {
    fullName: `Cliente C5 ${tag} ${s}`,
    email: `c5.${tag}.${s}@test.com`,
    phone: `56${s}`,
    idWorkshop: ID_WORKSHOP,
    createdBy: MECHANIC_ID,
  });
  const car = await post(request, "/cars", {
    clientId: idOf(client),
    brand: "Kia",
    model: `Rio C5-${tag}`,
    year: 2022,
    vin: `C5${tag}${s}000000000000`.slice(0, 17),
    codeCar: `C5${s.slice(-5)}`,
    color: "Rojo",
    fuel: "Gasolina",
    transmition: "Manual",
    km: 22000,
  });
  const entry = await post(request, "/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId: idOf(client),
    carId: idOf(car),
    assigned_mechanic: MECHANIC_ID,
    status: 1,
    observations: `C5 ${tag}: evidencia por taller`,
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  });
  return { clientId: idOf(client), entryId: idOf(entry), os: entry?.sheet };
}

// ── Helpers del emulador de Storage (REST, con el idToken del emulador) ──────

const objUrl = (objectPath) =>
  `${STORAGE_EMU}/v0/b/${BUCKET}/o/${encodeURIComponent(objectPath)}`;

async function storageList(request, prefix, token) {
  const res = await request.get(
    `${STORAGE_EMU}/v0/b/${BUCKET}/o?prefix=${encodeURIComponent(prefix)}`,
    { headers: { Authorization: `Firebase ${token}` } },
  );
  if (!res.ok()) return { status: res.status(), items: [] };
  const json = await res.json().catch(() => ({}));
  return { status: res.status(), items: json?.items ?? [] };
}

async function storageUpload(request, objectPath, token) {
  return request.post(`${objUrl(objectPath)}?uploadType=media&name=${encodeURIComponent(objectPath)}`, {
    headers: { Authorization: `Firebase ${token}`, "Content-Type": "image/png" },
    data: PNG_1x1,
  });
}

async function storageGet(request, objectPath, token) {
  return request.get(`${objUrl(objectPath)}?alt=media`, {
    headers: { Authorization: `Firebase ${token}` },
  });
}

async function login(page) {
  await page.goto("/login");
  await page.locator("#email").fill(ADMIN_EMAIL);
  await page.locator("#password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });
}

// ── 1. UI: subir desde el Expediente cae en la ruta por taller ───────────────

test(
  "C5 (UI): la evidencia subida desde el Expediente queda en {idWorkshop}/{clientId}/{entryId}/service y se lista",
  { tag: ["@ui", "@lento"] },
  async ({ page, request }) => {
    test.setTimeout(180_000);
    const { clientId, entryId, os } = await makeOs(request, "U");
    const token = await getApiToken();

    await login(page);
    await page.goto(`/expediente/${entryId}`);
    await expect(page.getByText(/evidencias generales/i).first()).toBeVisible({ timeout: 20000 });

    // El input de EvidenceManager está oculto tras el botón "Subir evidencia":
    // se le inyecta el archivo directo (accept="image/*,video/*").
    const section = page
      .locator("section, div", { has: page.getByText(/evidencias generales/i) })
      .last();
    const fileInput = section.locator('input[type="file"]').first();
    await fileInput.setInputFiles({ name: "c5.png", mimeType: "image/png", buffer: PNG_1x1 });

    await expect(
      page.locator("[data-sonner-toaster]").getByText(/se subieron 1 archivo/i).first(),
      "toast de subida",
    ).toBeVisible({ timeout: 30000 });

    // Storage (emulador): el objeto está bajo la ruta NUEVA…
    const nuevo = await storageList(request, `${ID_WORKSHOP}/${clientId}/${entryId}/service/`, token);
    expect(nuevo.status, "listar la ruta nueva con el token del taller").toBe(200);
    expect(
      nuevo.items.length,
      `OS ${os}: no hay objetos en ${ID_WORKSHOP}/${clientId}/${entryId}/service/ — ` +
        "¿el front sigue armando la ruta legada sin idWorkshop?",
    ).toBeGreaterThan(0);

    // …y NO en la legada.
    const legado = await storageList(request, `${clientId}/${entryId}/service/`, token);
    expect(
      legado.items.length,
      `OS ${os}: apareció evidencia en la ruta LEGADA ${clientId}/${entryId}/service/`,
    ).toBe(0);

    // La pantalla la lista (recarga → el listado lee la ruta nueva).
    await page.reload();
    await expect(page.getByText(/evidencias generales/i).first()).toBeVisible({ timeout: 20000 });
    const imgs = page.locator('img[src*="' + encodeURIComponent(ID_WORKSHOP) + '"], img[src*="' + ID_WORKSHOP + '"]');
    await expect(imgs.first(), "la miniatura de la evidencia (URL con el taller) se muestra").toBeVisible({ timeout: 20000 });
  },
);

// ── 2. API: las reglas aíslan por taller (y la ruta legada es solo lectura) ─

test(
  "C5 (reglas): con el token del taller A no se puede escribir ni leer evidencia del taller B, ni escribir en la ruta legada",
  { tag: ["@api"] },
  async ({ request }) => {
    const token = await getApiToken(); // taller-prueba (A)
    const stamp = Date.now();

    // Propio: OK
    const own = await storageUpload(request, `${ID_WORKSHOP}/cliX/entX/service/ok-${stamp}.png`, token);
    expect(own.status(), "escribir evidencia del PROPIO taller").toBeLessThan(300);
    const ownRead = await storageGet(request, `${ID_WORKSHOP}/cliX/entX/service/ok-${stamp}.png`, token);
    expect(ownRead.status(), "leer evidencia del PROPIO taller").toBe(200);

    // Ajeno: escribir y leer → denegado
    const foreignW = await storageUpload(request, `${OTHER_WORKSHOP}/cliY/entY/service/hack-${stamp}.png`, token);
    expect(foreignW.status(), "escribir bajo OTRO taller debe denegarse").toBe(403);
    const foreignR = await storageGet(request, `${OTHER_WORKSHOP}/cliY/entY/service/cualquiera.png`, token);
    expect([403, 404]).toContain(foreignR.status()); // 403 por regla; 404 solo si la regla no aplicara (no debe pasar)
    expect(foreignR.status(), "leer bajo OTRO taller debe ser 403 (no 404 = habría pasado la regla)").toBe(403);

    // Diagnóstico y serviceflow ajenos también
    const foreignD = await storageUpload(request, `${OTHER_WORKSHOP}/cliY/entY/diagnostics/f1/hack-${stamp}.png`, token);
    expect(foreignD.status(), "diagnostics de OTRO taller").toBe(403);
    const foreignF = await storageUpload(request, `${OTHER_WORKSHOP}/cliY/entY/serviceflow/hack-${stamp}.png`, token);
    expect(foreignF.status(), "serviceflow de OTRO taller").toBe(403);

    // Ruta LEGADA: escribir denegado (solo lectura de compatibilidad)
    const legacyW = await storageUpload(request, `cliX/entX/service/legacy-${stamp}.png`, token);
    expect(legacyW.status(), "escribir en la ruta legada sin taller debe denegarse").toBe(403);

    // Sin token: nada
    const anon = await request.post(
      `${objUrl(`${ID_WORKSHOP}/cliX/entX/service/anon-${stamp}.png`)}?uploadType=media`,
      { headers: { "Content-Type": "image/png" }, data: PNG_1x1 },
    );
    expect(anon.status(), "anónimo no escribe evidencia").toBeGreaterThanOrEqual(400);
  },
);
