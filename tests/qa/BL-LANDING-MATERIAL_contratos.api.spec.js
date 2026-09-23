const { test, expect, request: pwRequest } = require("@playwright/test");
const { auth: qaAuth } = require("../../adminFlex");
const { headersFor } = require("../../qaAuth");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-54 · BL-55 · BL-56 · BL-59 — contratos de API del material de landings @api
 * (rama feat/landing-cms-material-front) — escritos NUEVOS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El bloque es SOLO de front, así que aquí no se prueba un fix del API sino
 * las PREMISAS en las que el front se apoya (si alguna cambia, el front se
 * rompe en silencio):
 *
 *   1. GET /site-content/home y /academy son públicos (sin sesión) y devuelven
 *      un objeto: la landing los lee anónima.
 *   2. PUT /site-content/:page rechaza sin sesión y sin rol TECH_SUPPORT.
 *   3. PUT /site-content/home como TECH_SUPPORT acepta las claves NUEVAS
 *      (HOME_HERO.videoUrl, HOME_CAPSULAS.items[].url) y las devuelve tal
 *      cual: el API no valida forma, guarda el doc completo. Se restaura el
 *      doc original al final.
 *   4. GET /volumes es público. Reporta (sin fallar) si la colección está
 *      vacía: es el dato que decide cuándo BL-59 puede retirar las URLs del
 *      fallback de data.js.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   Contra el API de QA desplegado (o local con `npm run dev` en :3001):
 *   $env:API="https://<api-de-qa>/v1"   (o http://localhost:3001/v1)
 *   $env:SKIP_SEED="1"
 *   npx playwright test --project=qa tests/qa/BL-LANDING-MATERIAL_contratos.api.spec.js
 *   Requiere serviceAccountKey de refac (adminFlex) para crear el TECH_SUPPORT efímero.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const S = String(Date.now()).slice(-6);
const TECH_EMAIL = `tech.landing.${S}@ccc.test`;
const TECH_PASSWORD = "Prueba1234!";
const MARCA = `landing-material-${S}`;

let techHeaders = null;
let uidTech = null;
let homeOriginal = null;

const api = async (ctx, method, path, opts = {}) => {
  const res = await ctx[method](`${API}${path}`, opts);
  return { status: res.status(), body: await res.json().catch(() => null) };
};

test.describe.configure({ mode: "serial" });

test.describe("Material de landings — premisas del API @api", () => {
  test.beforeAll(async () => {
    const user = await qaAuth().createUser({ email: TECH_EMAIL, password: TECH_PASSWORD });
    await qaAuth().setCustomUserClaims(user.uid, { role: "TECH_SUPPORT" });
    uidTech = user.uid;
    techHeaders = await headersFor(TECH_EMAIL, TECH_PASSWORD);
  });

  test.afterAll(async () => {
    const ctx = await pwRequest.newContext();
    if (homeOriginal !== null) {
      // PUT sin merge: se regresa el doc EXACTO que había (o {} si no había).
      await api(ctx, "put", "/site-content/home", { headers: techHeaders, data: homeOriginal }).catch(() => {});
    }
    await ctx.dispose();
    if (uidTech) await qaAuth().deleteUser(uidTech).catch(() => {});
  });

  test("1 · GET /site-content/home y /academy son públicos y devuelven objeto", async ({ request }) => {
    for (const pagina of ["home", "academy", "transformar"]) {
      const r = await api(request, "get", `/site-content/${pagina}`);
      expect(r.status, pagina).toBe(200);
      expect(typeof (r.body?.data ?? {}), pagina).toBe("object");
    }
  });

  test("2 · PUT /site-content/home sin sesión → 401/403", async ({ request }) => {
    const r = await api(request, "put", "/site-content/home", { data: { HOME_HERO: { videoUrl: "x" } } });
    expect([401, 403]).toContain(r.status);
  });

  test("3 · PUT como TECH_SUPPORT acepta las claves nuevas y las devuelve tal cual", async ({ request }) => {
    const antes = await api(request, "get", "/site-content/home");
    homeOriginal = antes.body?.data ?? {};

    const doc = {
      ...homeOriginal,
      HOME_HERO: { ...(homeOriginal.HOME_HERO || {}), videoUrl: `https://www.youtube.com/watch?v=R3kcANRV1L4#${MARCA}` },
      HOME_CAPSULAS: {
        ...(homeOriginal.HOME_CAPSULAS || {}),
        items: [
          { num: "01", title: "Sin flujo hay caos", url: "https://www.youtube.com/watch?v=sLCOZOBeaRY" },
          { num: "02", title: "El cuello de botella", url: "https://www.youtube.com/watch?v=HBNHKgs4NyI" },
          { num: "03", title: "El dinero no está en el banco", url: "https://www.youtube.com/watch?v=62CHB591ucg" },
        ],
      },
    };
    const put = await api(request, "put", "/site-content/home", { headers: techHeaders, data: doc });
    expect(put.status).toBe(200);

    const despues = await api(request, "get", "/site-content/home");
    expect(despues.body?.data?.HOME_HERO?.videoUrl).toContain(MARCA);
    expect(despues.body?.data?.HOME_CAPSULAS?.items?.map((i) => i.url)).toEqual(
      doc.HOME_CAPSULAS.items.map((i) => i.url)
    );
  });

  test("4 · GET /volumes es público; reporta si la colección está vacía (BL-59)", async ({ request }, testInfo) => {
    const r = await api(request, "get", "/volumes");
    expect(r.status).toBe(200);
    const vols = r.body?.data?.volumes;
    expect(Array.isArray(vols)).toBe(true);
    // 23-sep-2026: en QA devolvió [] — la colección `volumes` nunca se sembró y la
    // web vive del fallback estático de data.js (con URLs del bucket de QA). Por eso
    // BL-59 NO retira esas URLs todavía. Aquí se documenta, no se hace fallar.
    if (vols.length === 0) {
      testInfo.annotations.push({ type: "BL-59", description: "colección volumes VACÍA en este ambiente: la vitrina usa el fallback de data.js" });
      console.warn("⚠️ BL-59: GET /volumes devolvió []. Falta sembrar la colección (seed-volumes.js no existe).");
      return;
    }
    for (const key of ["v0", "v1", "v2"]) {
      const v = vols.find((x) => x.key === key);
      if (!v?.audioUrl || !v?.pdfUrl) console.warn(`⚠️ ${key} sin audioUrl/pdfUrl — cargarlo en la pestaña Volúmenes del CMS`);
    }
  });
});
