const { test, expect } = require("@playwright/test");
const { getApiToken } = require("#apiToken");

/**
 * Fase 2 (CMS de Marketing) — paso 4: la biblioteca de medios.
 *
 *   GET  /v1/media   → biblioteca            [público]
 *   POST /v1/media   → registra un medio     [TECH_SUPPORT]
 *
 * La subida física va a Storage con el SDK del cliente; aquí se prueba el
 * REGISTRO del metadato: blindaje, validación (alt obligatorio por a11y,
 * URL http(s) o /assets/) y el viaje registrar → aparecer en la biblioteca.
 *
 * PRERREQUISITOS: emuladores + API en :3001. El usuario TECH_SUPPORT lo crea
 * el propio spec (mismo helper que cms-site-content.spec.js).
 */

const API = process.env.API || "http://localhost:3001/v1";
const AUTH_EMU = process.env.AUTH_EMU || "http://127.0.0.1:9099";
const PROJECT_ID = process.env.FB_PROJECT || "ccc-taller-refac";
const TECH_EMAIL = process.env.TECH_EMAIL || "techsupport.cms@ccc.test";
const TECH_PASSWORD = process.env.TECH_PASSWORD || "prueba123";

async function techSupportToken(request) {
  const signIn = () =>
    request.post(`${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
      data: { email: TECH_EMAIL, password: TECH_PASSWORD, returnSecureToken: true },
    });
  let uid;
  const up = await request.post(`${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
    data: { email: TECH_EMAIL, password: TECH_PASSWORD, returnSecureToken: true },
  });
  if (up.ok()) {
    uid = (await up.json()).localId;
  } else {
    const res = await signIn();
    if (!res.ok()) throw new Error(`No se pudo crear ni iniciar sesión ${TECH_EMAIL}: ${await res.text()}`);
    uid = (await res.json()).localId;
  }
  const upd = await request.post(
    `${AUTH_EMU}/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:update`,
    { headers: { Authorization: "Bearer owner" }, data: { localId: uid, customAttributes: JSON.stringify({ role: "TECH_SUPPORT" }) } },
  );
  if (!upd.ok()) throw new Error(`No se pudo firmar el claim TECH_SUPPORT: ${await upd.text()}`);
  const res = await signIn();
  if (!res.ok()) throw new Error(`signIn tras el claim falló: ${await res.text()}`);
  return (await res.json()).idToken;
}

async function post(request, body, token) {
  const res = await request.post(`${API}/media`, {
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    data: body,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), data: json?.data ?? null };
}

const medioValido = (marca) => ({
  url: `https://firebasestorage.googleapis.com/v0/b/demo/o/marketing%2Fimg%2F${marca}.webp?alt=media`,
  nombre: `spec-${marca}`,
  alt: `Imagen de prueba ${marca}`,
  tags: ["spec"],
  bytes: 12345,
  w: 800,
  h: 600,
  origen: "storage",
});

test.describe("Media — biblioteca del CMS", { tag: ["@api"] }, () => {
  test("GET /media responde 200 sin token (la lista es pública)", async ({ request }) => {
    const res = await request.get(`${API}/media`);
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json?.data?.media)).toBe(true);
    expect(res.headers()["cache-control"]).toContain("max-age=60");
  });

  test("POST sin token responde 401", async ({ request }) => {
    const { status } = await post(request, medioValido("sin-token"));
    expect(status).toBe(401);
  });

  test("POST con el owner del taller responde 403", async ({ request }) => {
    const ownerToken = await getApiToken();
    const { status } = await post(request, medioValido("owner"), ownerToken);
    expect(status).toBe(403);
  });

  test("POST sin alt responde 422 (el texto alternativo es obligatorio)", async ({ request }) => {
    const token = await techSupportToken(request);
    const { alt, ...sinAlt } = medioValido("sin-alt");
    const { status } = await post(request, sinAlt, token);
    expect(status).toBe(422);
  });

  test("POST con URL que no es http(s) ni /assets/ responde 422", async ({ request }) => {
    const token = await techSupportToken(request);
    const { status } = await post(request, { ...medioValido("mala-url"), url: "ftp://nope" }, token);
    expect(status).toBe(422);
  });

  test("TECH_SUPPORT registra un medio y aparece en la biblioteca pública", async ({ request }) => {
    const token = await techSupportToken(request);
    const marca = `${Date.now()}`;

    const creado = await post(request, medioValido(marca), token);
    expect(creado.status).toBe(201);
    expect(creado.data?.id).toBeTruthy();

    const res = await request.get(`${API}/media`);
    const { media } = (await res.json()).data;
    const encontrado = media.find((m) => m.nombre === `spec-${marca}`);
    expect(encontrado).toBeTruthy();
    expect(encontrado.alt).toBe(`Imagen de prueba ${marca}`);
    expect(encontrado.origen).toBe("storage");
  });

  test("un medio de origen repo acepta rutas /assets/ (como la semilla)", async ({ request }) => {
    const token = await techSupportToken(request);
    const marca = `repo-${Date.now()}`;
    const { status } = await post(request, {
      url: "/assets/wepb_L2/img1.webp",
      nombre: `spec-${marca}`,
      alt: "Imagen del repo",
      origen: "repo",
    }, token);
    expect(status).toBe(201);
  });
});
