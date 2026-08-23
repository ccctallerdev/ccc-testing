const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * Clientes v2 — UNICIDAD DE IDENTIDAD (22-ago): correo y teléfono son únicos
 * por persona, evaluados sobre `users` Y `clients` a la vez, en TODAS las
 * puertas de alta (signup público de la app, with-account de la web, POST
 * /clients).
 *
 * Reproduce exactamente lo que pasó en Firestore el 22-ago:
 *   15:22  app   → signup rutituti1 / tel 4400000002            (ok)
 *   15:37  web   → alta correo@gmail / tel 4400000002           ← se coló
 *   15:39  web   → alta rutituti1    / tel 4400000003           ← se coló con
 *                   otro teléfono que el de su propia cuenta
 * Ahora la 2ª y la 3ª deben dar 409, y la web solo acepta a la persona de
 * la app con SU mismo teléfono.
 *
 * PRERREQUISITOS: emuladores + backend + seed (global-setup).
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";

const stamp = String(Date.now()).slice(-7);
const PHONE_A = `44${stamp}1`.slice(0, 10); // el teléfono compartido
const PHONE_B = `44${stamp}2`.slice(0, 10); // "otro" teléfono
const PHONE_D = `44${stamp}3`.slice(0, 10);
const EMAIL_APP = `app.unico.${stamp}@ccc.test`;   // se registra desde la app
const EMAIL_WEB = `web.otro.${stamp}@ccc.test`;    // lo intenta dar de alta el taller
const EMAIL_D = `web.primero.${stamp}@ccc.test`;   // nace desde la web
let ipSeq = 10;

async function api(request, token, method, path, body, headers = {}) {
  const res = await request[method](`${API}${path}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json, data: json?.data ?? json };
}

/** Signup público de la app móvil (cada llamada con IP distinta: rate-limit). */
function signup(request, { email, phone }) {
  return api(request, null, "post", "/public/signup", {
    country: "MX",
    name: "Persona",
    firstSurname: "Unica",
    secondSurname: "",
    email,
    phone,
    password: "ClaveSegura123!",
  }, { "x-forwarded-for": `10.22.${stamp.slice(0, 2)}.${ipSeq++}` });
}

function altaWeb(request, token, { fullName, email, phone }) {
  return api(request, token, "post", "/clients/with-account", {
    fullName,
    email,
    phone,
    createdBy: "spec",
    idWorkshop: ID_WORKSHOP,
  });
}

test.describe.serial("Clientes v2 — correo y teléfono únicos (users + clients)", () => {
  let adminToken;

  test.beforeAll(async () => {
    adminToken = (await authHeaders()).Authorization.replace("Bearer ", "");
  });

  test("1) la persona se registra desde la app (solo cuenta, sin expediente)", { tag: ["@api", "@publico"] }, async ({ request }) => {
    const res = await signup(request, { email: EMAIL_APP, phone: PHONE_A });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.data.email).toBe(EMAIL_APP);
  });

  test("2) web: OTRO correo con el MISMO teléfono → 409 (antes se colaba)", { tag: ["@api"] }, async ({ request }) => {
    const res = await altaWeb(request, adminToken, {
      fullName: "Ruth Test Test", email: EMAIL_WEB, phone: PHONE_A,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.data?.code).toBe("CLIENT_EXISTS");
    expect(String(res.body?.descripcion)).toMatch(/teléfono.*otro correo/i);
  });

  test("3) web: MISMO correo con OTRO teléfono → 409 (antes creaba el cliente con el tel nuevo)", { tag: ["@api"] }, async ({ request }) => {
    const res = await altaWeb(request, adminToken, {
      fullName: "Test Cliente Input", email: EMAIL_APP, phone: PHONE_B,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.data?.code).toBe("CLIENT_EXISTS");
    expect(String(res.body?.descripcion)).toMatch(/correo.*otro número/i);
  });

  test("4) lookup avisa el mismatch en ambos sentidos (para el dialog de la web)", { tag: ["@api"] }, async ({ request }) => {
    const porCorreo = await api(request, adminToken, "get",
      `/clients/lookup?email=${encodeURIComponent(EMAIL_APP)}&phone=${PHONE_B}&idWorkshop=${ID_WORKSHOP}`);
    expect(porCorreo.status).toBe(200);
    expect(porCorreo.data.exists).toBe(true);
    expect(porCorreo.data.matchedBy).toBe("email");
    expect(porCorreo.data.mismatch).toBe("phone");
    expect(porCorreo.data.clientId).toBeNull(); // aún no hay expediente
    expect(porCorreo.data.hasAccount).toBe(true);

    const porTelefono = await api(request, adminToken, "get",
      `/clients/lookup?email=${encodeURIComponent(EMAIL_WEB)}&phone=${PHONE_A}&idWorkshop=${ID_WORKSHOP}`);
    expect(porTelefono.status).toBe(200);
    expect(porTelefono.data.exists).toBe(true);
    expect(porTelefono.data.matchedBy).toBe("phone");
    expect(porTelefono.data.mismatch).toBe("email");

    const cuadra = await api(request, adminToken, "get",
      `/clients/lookup?email=${encodeURIComponent(EMAIL_APP)}&phone=${PHONE_A}&idWorkshop=${ID_WORKSHOP}`);
    expect(cuadra.data.exists).toBe(true);
    expect(cuadra.data.mismatch).toBeNull();
    expect(cuadra.data.affiliated).toBe(false);
  });

  test("5) web: mismo correo y mismo teléfono → 201, crea el expediente ligado a la cuenta de la app", { tag: ["@api"] }, async ({ request }) => {
    const res = await altaWeb(request, adminToken, {
      fullName: "Persona Unica", email: EMAIL_APP, phone: PHONE_A,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.data.accountCreated).toBe(false);
    expect(res.data.clientCreated).toBe(true);
    expect(res.data.client.idUser).toBeTruthy();
    expect(res.data.client.phone).toBe(PHONE_A);
    expect(res.data.token).toMatch(/^[A-Z0-9]{6}$/);
  });

  test("6) app: signup con teléfono ya usado (otro correo) o correo ya usado → 409", { tag: ["@api", "@publico"] }, async ({ request }) => {
    const tel = await signup(request, { email: `tercero.${stamp}@ccc.test`, phone: PHONE_A });
    expect(tel.status, JSON.stringify(tel.body)).toBe(409);
    const correo = await signup(request, { email: EMAIL_APP, phone: PHONE_B });
    expect(correo.status, JSON.stringify(correo.body)).toBe(409);
  });

  test("7) sentido inverso: nace en la web y luego la app respeta su teléfono", { tag: ["@api", "@publico"] }, async ({ request }) => {
    const alta = await altaWeb(request, adminToken, {
      fullName: "Nace Web", email: EMAIL_D, phone: PHONE_D,
    });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);

    // Otra persona desde la app con el teléfono del cliente de la web → 409.
    const otro = await signup(request, { email: `otro.${stamp}@ccc.test`, phone: PHONE_D });
    expect(otro.status, JSON.stringify(otro.body)).toBe(409);
    // La misma persona desde la app: la cuenta ya existe (oculta) → 409.
    const mismo = await signup(request, { email: EMAIL_D, phone: PHONE_D });
    expect(mismo.status, JSON.stringify(mismo.body)).toBe(409);
  });

  test("8) POST /clients (solo expediente) aplica la misma regla", { tag: ["@api"] }, async ({ request }) => {
    const tel = await api(request, adminToken, "post", "/clients", {
      fullName: "Solo Expediente", email: `expediente.${stamp}@ccc.test`, phone: PHONE_A,
      createdBy: "spec", idWorkshop: ID_WORKSHOP,
    });
    expect(tel.status, JSON.stringify(tel.body)).toBe(409);
    expect(tel.data?.code).toBe("CLIENT_EXISTS");
  });
});
