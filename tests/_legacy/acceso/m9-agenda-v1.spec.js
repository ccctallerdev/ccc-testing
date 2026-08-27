const { test, expect } = require("@playwright/test");

/**
 * M9 — Agenda dentro de /v1 (antes: Cloud Function pública `agenda`, sin
 * sesión ni aislamiento: cualquiera con la URL leía las citas —nombres y
 * teléfonos de clientes— de cualquier taller, y podía crear/editar/borrar).
 *
 * Ahora /v1/agenda pasa por requireAuth + authorize(CAN_MANAGE_AGENDA) +
 * verifyWorkshopAccess, y PUT/DELETE verifican pertenencia por id.
 *
 *   1) sin sesión → 401 en GET/POST/PUT/DELETE
 *   2) con sesión del taller A: crear, listar, editar y borrar SU cita (feliz)
 *   3) taller A NO lista las citas del taller B (403), ni crea citas a nombre de B (403)
 *   4) taller A NO edita ni borra una cita del taller B (404: para él no existe)
 *   5) la URL legada (/agenda) se conserva pero blindada: 401 sin sesión, 403 otro taller
 *   6) UI: la pantalla Agenda sigue funcionando con la ruta nueva (crear + ver)
 *
 * PRERREQUISITOS: emuladores + backend :3001 + frontend :3000. Semilla vía
 * global setup (prueba@ccc.test / taller-prueba; existe taller-prueba-b).
 */

const API = process.env.API || "http://localhost:3001/v1";
const LEGACY = process.env.AGENDA_LEGACY_API || "http://localhost:3001/agenda";
const AUTH_EMU = process.env.AUTH_EMU || "http://127.0.0.1:9099";
const OWNER_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const OWNER_PASSWORD = process.env.SEED_PASSWORD || "prueba123";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const ID_WORKSHOP_B = process.env.ID_WORKSHOP_B || "taller-prueba-b";

async function tokenFor(request, email, password) {
  const res = await request.post(
    `${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`,
    { data: { email, password, returnSecureToken: true } },
  );
  if (!res.ok()) throw new Error(`signIn ${email} → ${res.status()}: ${await res.text()}`);
  return (await res.json()).idToken;
}

async function api(request, token, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), data: json?.data ?? json };
}

const stamp = () => String(Date.now()).slice(-6);
const inDays = (n, h = 11) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(h, 0, 0, 0);
  return d.toISOString();
};
/** Fecha dentro del MES actual (la vista Agenda del calendario es mensual). */
const inSameMonth = (n, h = 10) => {
  const now = new Date();
  const d = new Date(now);
  d.setDate(now.getDate() + n);
  if (d.getMonth() !== now.getMonth()) d.setTime(now.getTime());
  d.setHours(h, 0, 0, 0);
  return d.toISOString();
};

/** Cita del taller B sembrada directo en Firestore (Admin SDK → emulador). */
async function seedEventForB(title) {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  const { initializeApp, getApps } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  if (!getApps().length) initializeApp({ projectId: "ccc-taller-refac" });
  const ref = getFirestore().collection("agenda").doc();
  await ref.set({
    idWorkshop: ID_WORKSHOP_B,
    title,
    description: "cita del taller B",
    phone: "5500000000",
    start: inDays(2),
    end: inDays(2),
    allDay: false,
    createdBy: "b",
    createdByName: "Asesor B",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return ref.id;
}

test.describe.serial("M9 — Agenda en /v1: sesión, rol y aislamiento por taller", () => {
  const marker = `Cita M9 ${stamp()}`;
  let ownerToken;
  let createdId;

  test.beforeAll(async ({ request }) => {
    ownerToken = await tokenFor(request, OWNER_EMAIL, OWNER_PASSWORD);
  });

  test("1) sin sesión: GET/POST/PUT/DELETE → 401", { tag: ["@api", "@seguridad"] }, async ({ request }) => {
    expect((await api(request, null, "get", `/agenda?idWorkshop=${ID_WORKSHOP}`)).status).toBe(401);
    expect((await api(request, null, "post", `/agenda`, { idWorkshop: ID_WORKSHOP, title: "x", start: inDays(1) })).status).toBe(401);
    expect((await api(request, null, "put", `/agenda/cualquiera`, { title: "x" })).status).toBe(401);
    expect((await api(request, null, "delete", `/agenda/cualquiera`)).status).toBe(401);
  });

  test("2) taller A: crea, lista, edita y borra SU cita", { tag: ["@api"] }, async ({ request }) => {
    const c = await api(request, ownerToken, "post", `/agenda`, {
      idWorkshop: ID_WORKSHOP,
      title: marker,
      description: "prueba m9",
      phone: "5512345678",
      start: inDays(1),
      end: inDays(1),
      allDay: false,
      createdBy: "asesor-prueba",
      createdByName: "Asesor Prueba",
    });
    expect(c.status, "crear cita propia").toBe(201);
    createdId = c.data?.id;
    expect(createdId).toBeTruthy();

    const l = await api(request, ownerToken, "get", `/agenda?idWorkshop=${ID_WORKSHOP}`);
    expect(l.status).toBe(200);
    const mine = (l.data?.events ?? []).find((e) => e.id === createdId);
    expect(mine, "la cita aparece en el listado del taller").toBeTruthy();
    expect(mine.createdByName).toBe("Asesor Prueba");

    const u = await api(request, ownerToken, "put", `/agenda/${createdId}`, { title: `${marker} (editada)`, phone: "5587654321" });
    expect(u.status, "editar cita propia").toBe(200);
    expect(u.data?.title).toBe(`${marker} (editada)`);

    const d = await api(request, ownerToken, "delete", `/agenda/${createdId}`);
    expect(d.status, "borrar cita propia").toBe(200);
    const l2 = await api(request, ownerToken, "get", `/agenda?idWorkshop=${ID_WORKSHOP}`);
    expect((l2.data?.events ?? []).some((e) => e.id === createdId), "ya no está").toBe(false);
  });

  test("3) taller A NO lista ni crea citas del taller B (403)", { tag: ["@api", "@seguridad"] }, async ({ request }) => {
    const l = await api(request, ownerToken, "get", `/agenda?idWorkshop=${ID_WORKSHOP_B}`);
    expect(l.status, "listar citas de otro taller").toBe(403);
    const c = await api(request, ownerToken, "post", `/agenda`, { idWorkshop: ID_WORKSHOP_B, title: "intrusa", start: inDays(1) });
    expect(c.status, "crear cita a nombre de otro taller").toBe(403);
  });

  test("4) taller A NO edita ni borra una cita del taller B (para él no existe: 404)", { tag: ["@api", "@seguridad"] }, async ({ request }) => {
    const bId = await seedEventForB(`Cita B ${stamp()}`);
    const u = await api(request, ownerToken, "put", `/agenda/${bId}`, { title: "hackeada" });
    expect(u.status, "editar cita ajena").toBe(404);
    const d = await api(request, ownerToken, "delete", `/agenda/${bId}`);
    expect(d.status, "borrar cita ajena").toBe(404);
    // Sigue viva e intacta para B (lectura directa por Admin SDK).
    const { getFirestore } = require("firebase-admin/firestore");
    const snap = await getFirestore().collection("agenda").doc(bId).get();
    expect(snap.exists).toBe(true);
    expect(snap.data().title).not.toBe("hackeada");
    await getFirestore().collection("agenda").doc(bId).delete(); // limpieza
  });

  test("5) la URL legada (/agenda) se conserva pero YA NO es pública: sin sesión 401; con sesión y taller propio sigue sirviendo", { tag: ["@api", "@seguridad"] }, async ({ request }) => {
    const anon = await request.get(`${LEGACY}/getevents?idw=${ID_WORKSHOP}`);
    expect(anon.status(), "legado sin sesión debe rechazar").toBe(401);
    const own = await request.get(`${LEGACY}/getevents?idw=${ID_WORKSHOP}`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    expect(own.status(), "legado con sesión del taller propio").toBe(200);
    expect(Array.isArray(await own.json()), "misma forma de respuesta de siempre (arreglo)").toBe(true);
    const other = await request.get(`${LEGACY}/getevents?idw=${ID_WORKSHOP_B}`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    expect(other.status(), "legado no deja leer otro taller").toBe(403);
    const anonWrite = await request.post(`${LEGACY}/addevent`, { data: { idWorkshop: ID_WORKSHOP, title: "x", start: inDays(1) } });
    expect(anonWrite.status(), "legado sin sesión no crea").toBe(401);
  });

  test("6) UI: la pantalla Agenda crea y muestra la cita por la ruta nueva", { tag: ["@ui"] }, async ({ page, request }) => {
    const title = `Cita UI M9 ${stamp()}`;
    // Se crea por API (misma ruta que usa el front) y se comprueba que la pantalla la pinta.
    const c = await api(request, ownerToken, "post", `/agenda`, {
      idWorkshop: ID_WORKSHOP,
      title,
      phone: "5512345678",
      start: inSameMonth(3, 10),
      end: inSameMonth(3, 10),
      allDay: false,
      createdBy: "asesor-prueba",
      createdByName: "Asesor Prueba",
    });
    expect(c.status).toBe(201);

    await page.goto("/login");
    await page.locator("#email").fill(OWNER_EMAIL);
    await page.locator("#password").fill(OWNER_PASSWORD);
    await page.getByRole("button", { name: /iniciar sesión/i }).click();
    await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });
    await page.goto("/agenda");
    // Vista Agenda (lista) para no depender del colapso "+N más" del mes.
    await page.locator(".fc-listMonth-button").click();
    await expect(page.getByText(title, { exact: false }).first()).toBeVisible({ timeout: 20000 });

    await api(request, ownerToken, "delete", `/agenda/${c.data.id}`); // limpieza
  });
});
