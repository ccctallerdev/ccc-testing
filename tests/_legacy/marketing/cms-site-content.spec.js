const { test, expect } = require("@playwright/test");
const { getApiToken } = require("#apiToken");

/**
 * Fase 2 (CMS de Marketing) — paso 1: la API de contenido por página.
 *
 *   GET  /v1/site-content          → doc legado `landing`   [público]
 *   GET  /v1/site-content/:page    → doc de la página       [público]
 *   PUT  /v1/site-content/:page    → publica la página      [TECH_SUPPORT]
 *
 * Cubre: lectura anónima (la landing no tiene sesión), lista blanca de
 * páginas (`landing` queda FUERA del :page a propósito), blindaje del PUT
 * (sin token → 401; owner del ERP sin rol de plataforma → 403), el viaje
 * completo publicar→leer→limpiar, y los topes del payload (anidado > 6 → 422).
 *
 * PRERREQUISITOS: emuladores + API en :3001 (global-setup siembra al owner).
 * El usuario TECH_SUPPORT lo crea este spec (las pruebas crean sus datos):
 * signUp por REST + custom claim `role` vía el endpoint admin del emulador.
 */

const API = process.env.API || "http://localhost:3001/v1";
const AUTH_EMU = process.env.AUTH_EMU || "http://127.0.0.1:9099";
const PROJECT_ID = process.env.FB_PROJECT || "ccc-taller-refac";

const TECH_EMAIL = process.env.TECH_EMAIL || "techsupport.cms@ccc.test";
const TECH_PASSWORD = process.env.TECH_PASSWORD || "prueba123";

/** Lista blanca del backend (routes/V1/siteContent.js). Si agregas una página
 *  allá, agrégala aquí: el loop de lectura pública la cubre sola. */
const PAGINAS = ["global", "home", "despertar", "transformar", "dirigir", "planes", "academy", "dudas"];

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Garantiza el usuario TECH_SUPPORT en el emulador de Auth y devuelve un
 * idToken CON el custom claim `role=TECH_SUPPORT` (el guard del backend
 * autoriza por ese claim). Idempotente: si ya existe, solo re-firma el claim.
 */
async function techSupportToken(request) {
  const signIn = () =>
    request.post(`${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
      data: { email: TECH_EMAIL, password: TECH_PASSWORD, returnSecureToken: true },
    });

  // 1) Crear (o recuperar) el usuario.
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

  // 2) Custom claim role=TECH_SUPPORT (endpoint ADMIN del emulador: Bearer owner).
  const upd = await request.post(
    `${AUTH_EMU}/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:update`,
    {
      headers: { Authorization: "Bearer owner" },
      data: { localId: uid, customAttributes: JSON.stringify({ role: "TECH_SUPPORT" }) },
    },
  );
  if (!upd.ok()) throw new Error(`No se pudo firmar el claim TECH_SUPPORT: ${await upd.text()}`);

  // 3) Token nuevo, ya CON el claim (los tokens previos no lo traen).
  const res = await signIn();
  if (!res.ok()) throw new Error(`signIn tras el claim falló: ${await res.text()}`);
  return (await res.json()).idToken;
}

/** GET anónimo. Devuelve status + `data` del envoltorio de la API. */
async function apiGet(request, path) {
  const res = await request.get(`${API}${path}`);
  const json = await res.json().catch(() => null);
  return { status: res.status(), data: json?.data ?? null, res };
}

/** PUT con (o sin) token. */
async function apiPut(request, path, body, token) {
  const res = await request.put(`${API}${path}`, {
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    data: body,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), data: json?.data ?? null };
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe("CMS — lectura pública (la landing es anónima)", { tag: ["@api"] }, () => {
  test("GET legado /site-content responde 200 sin token (no se rompió)", async ({ request }) => {
    const { status, data, res } = await apiGet(request, "/site-content");
    expect(status).toBe(200);
    expect(typeof data).toBe("object");
    // §3.7 de la guía: los GET públicos salen con caché para el primer pintado.
    expect(res.headers()["cache-control"]).toContain("max-age=60");
  });

  for (const pagina of PAGINAS) {
    test(`GET /site-content/${pagina} responde 200 sin token`, async ({ request }) => {
      const { status, data } = await apiGet(request, `/site-content/${pagina}`);
      expect(status).toBe(200);
      expect(typeof data).toBe("object"); // {} si nadie ha publicado aún
    });
  }

  test("GET de una página fuera de la lista blanca responde 404", async ({ request }) => {
    const { status } = await apiGet(request, "/site-content/loquesea");
    expect(status).toBe(404);
  });
});

test.describe("CMS — blindaje del PUT", { tag: ["@api"] }, () => {
  test("PUT sin token responde 401", async ({ request }) => {
    const { status } = await apiPut(request, "/site-content/despertar", {
      DESPERTAR_HERO: { titulo: "no debe guardarse" },
    });
    expect(status).toBe(401);
  });

  test("PUT con el owner del taller (sin rol de plataforma) responde 403", async ({ request }) => {
    // El dueño manda en SU taller, pero la web pública es del equipo de
    // plataforma: la matriz ERP no aplica aquí (decisión §2.3 de la guía).
    const ownerToken = await getApiToken();
    const { status } = await apiPut(
      request,
      "/site-content/despertar",
      { DESPERTAR_HERO: { titulo: "un owner no publica marketing" } },
      ownerToken,
    );
    expect(status).toBe(403);
  });

  test("PUT a `landing` vía :page responde 404 (el doc legado está protegido)", async ({ request }) => {
    const token = await techSupportToken(request);
    const { status } = await apiPut(
      request,
      "/site-content/landing",
      { hero: { title: "no debe pisar el doc legado" } },
      token,
    );
    expect(status).toBe(404);
  });
});

test.describe.serial("CMS — publicar, leer y limpiar (TECH_SUPPORT)", { tag: ["@api"] }, () => {
  let token;
  const marca = `PRUEBA CMS ${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    token = await techSupportToken(request);
  });

  test("TECH_SUPPORT publica contenido en despertar → 200", async ({ request }) => {
    const { status, data } = await apiPut(
      request,
      "/site-content/despertar",
      {
        DESPERTAR_HERO: { titulo: marca },
        DESPERTAR_SINTOMAS: [{ text: "síntoma publicado por el spec" }],
      },
      token,
    );
    expect(status).toBe(200);
    expect(data?.DESPERTAR_HERO?.titulo).toBe(marca);
  });

  test("lo publicado se lee SIN sesión (el viaje que hará la landing)", async ({ request }) => {
    const { status, data } = await apiGet(request, "/site-content/despertar");
    expect(status).toBe(200);
    expect(data?.DESPERTAR_HERO?.titulo).toBe(marca);
    expect(data?.DESPERTAR_SINTOMAS).toHaveLength(1);
  });

  test("publicar {} limpia la página (la web vuelve a data.js) y no deja restos", async ({ request }) => {
    const { status } = await apiPut(request, "/site-content/despertar", {}, token);
    expect(status).toBe(200);

    const { data } = await apiGet(request, "/site-content/despertar");
    // set SIN merge: del contenido anterior no queda NADA (solo updatedAt).
    expect(data?.DESPERTAR_HERO).toBeUndefined();
    expect(data?.DESPERTAR_SINTOMAS).toBeUndefined();
  });
});

test.describe("CMS — topes del payload", { tag: ["@api"] }, () => {
  test("un array como raíz responde 422", async ({ request }) => {
    const token = await techSupportToken(request);
    const { status } = await apiPut(request, "/site-content/despertar", [{ titulo: "raíz inválida" }], token);
    expect(status).toBe(422);
  });

  test("más de 6 niveles de anidado responde 422", async ({ request }) => {
    const token = await techSupportToken(request);
    const profundo = { a: { b: { c: { d: { e: { f: { g: "demasiado profundo" } } } } } } };
    const { status } = await apiPut(request, "/site-content/despertar", profundo, token);
    expect(status).toBe(422);
  });
});
