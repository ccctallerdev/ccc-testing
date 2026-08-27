const { test, expect } = require("@playwright/test");
const { getApiToken } = require("#apiToken");

/**
 * Fase 2 (CMS de Marketing) — paso 7: el catálogo de volúmenes.
 *
 *   GET /v1/volumes        → visibles (público); ?all=1 incluye ocultos
 *   PUT /v1/volumes/:key   → edita un volumen [TECH_SUPPORT]; key v0…v13
 *
 * Cubre: lectura anónima con caché, lista blanca de keys, blindaje (401/403),
 * validación zod (etapa/URLs) y el viaje editar → leerse en el GET público.
 * El spec RESTAURA lo que toca (edita v13 y lo regresa a su estado).
 *
 * PRERREQUISITOS: emuladores + API en :3001. No necesita la semilla de
 * volúmenes: el PUT con set+merge crea el doc si no existe.
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
  return (await res.json()).idToken;
}

async function put(request, key, body, token) {
  const res = await request.put(`${API}/volumes/${key}`, {
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    data: body,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), data: json?.data ?? null };
}

async function getAll(request) {
  const res = await request.get(`${API}/volumes?all=1`);
  return (await res.json())?.data?.volumes ?? [];
}

test.describe("Volumes — catálogo del CMS", { tag: ["@api"] }, () => {
  test("GET /volumes responde 200 sin token, con caché", async ({ request }) => {
    const res = await request.get(`${API}/volumes`);
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json?.data?.volumes)).toBe(true);
    expect(res.headers()["cache-control"]).toContain("max-age=60");
  });

  test("PUT sin token responde 401", async ({ request }) => {
    const { status } = await put(request, "v13", { titulo: "no debe guardarse" });
    expect(status).toBe(401);
  });

  test("PUT con el owner del taller responde 403", async ({ request }) => {
    const ownerToken = await getApiToken();
    const { status } = await put(request, "v13", { titulo: "un owner no edita volúmenes" }, ownerToken);
    expect(status).toBe(403);
  });

  test("PUT a una key fuera de v0…v13 responde 404", async ({ request }) => {
    const token = await techSupportToken(request);
    const { status } = await put(request, "v14", { titulo: "no existe" }, token);
    expect(status).toBe(404);
  });

  test("PUT con etapa inválida responde 422", async ({ request }) => {
    const token = await techSupportToken(request);
    const { status } = await put(request, "v13", { etapa: "jubilado" }, token);
    expect(status).toBe(422);
  });

  test("PUT con URL que no es http(s) ni /assets/ responde 422", async ({ request }) => {
    const token = await techSupportToken(request);
    const { status } = await put(request, "v13", { pdfUrl: "ftp://nope" }, token);
    expect(status).toBe(422);
  });

  test("TECH_SUPPORT edita v13 → se lee en el GET público → se restaura", async ({ request }) => {
    const token = await techSupportToken(request);
    const marca = `SPEC VOLUMEN ${Date.now()}`;

    // Estado previo (si la semilla corrió, para restaurarlo al final).
    const antes = (await getAll(request)).find((v) => v.key === "v13");

    const editado = await put(request, "v13", { titulo: marca, visible: true }, token);
    expect(editado.status).toBe(200);
    expect(editado.data?.titulo).toBe(marca);

    const publico = await request.get(`${API}/volumes`);
    const v13 = (await publico.json()).data.volumes.find((v) => v.key === "v13");
    expect(v13?.titulo).toBe(marca);

    // Restaurar (si había estado previo; si no, deja un título razonable).
    const restaurado = await put(request, "v13", {
      titulo: antes?.titulo || "EL DUEÑO QUE YA NO APAGA INCENDIOS",
      ...(antes ? { visible: antes.visible !== false } : {}),
    }, token);
    expect(restaurado.status).toBe(200);
  });

  test("un volumen oculto sale del GET público pero aparece con ?all=1", async ({ request }) => {
    const token = await techSupportToken(request);
    const antes = (await getAll(request)).find((v) => v.key === "v12");

    await put(request, "v12", { visible: false, titulo: antes?.titulo || "EL ERROR QUE SIEMPRE REGRESA" }, token);
    const publicos = (await (await request.get(`${API}/volumes`)).json()).data.volumes;
    expect(publicos.find((v) => v.key === "v12")).toBeUndefined();
    const todos = await getAll(request);
    expect(todos.find((v) => v.key === "v12")).toBeTruthy();

    // Restaurar.
    await put(request, "v12", { visible: antes ? antes.visible !== false : true }, token);
  });
});
