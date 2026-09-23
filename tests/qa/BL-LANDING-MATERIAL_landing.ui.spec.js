const { test, expect, request: pwRequest } = require("@playwright/test");
const { auth: qaAuth } = require("../../adminFlex");
const { headersFor } = require("../../qaAuth");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-54 · BL-55 · BL-56 · BL-57 · BL-58 — material de landings @ui @publico
 * (rama feat/landing-cms-material-front) — escritos NUEVOS, en ROJO antes del fix
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   BL-54  Home: "Ver Demo" abre el video del CMS (antes: modal fijo "Próximamente").
 *   BL-55  Cápsulas (sección de Academy; se editan en la pestaña Home del CMS):
 *          cada tarjeta abre SU video. Antes eran divs decorativos y solo
 *          había un botón general al canal.
 *   BL-56  Visor de imagen: Academy → botón "Ver descripción de todos los
 *          volúmenes" abre la "Línea de seguimiento" en grande; Transformar →
 *          la imagen del paso 3 se ve completa y abre en grande.
 *   BL-57  Academy lee cápsulas y manual del doc `home` del CMS (antes estáticos).
 *   BL-58  Dudas: al enviar se limpian los campos y aparece el aviso.
 *
 * Las páginas son PÚBLICAS: no hay matriz de roles. La sesión que sí importa
 * es la de TECH_SUPPORT (efímero) para publicar el contenido de prueba por
 * API; el doc original se restaura en afterAll.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   ⚠️ Front LOCAL con la rama (QA corre el código viejo), API de QA o local.
 *     1) ccc-backend/functions → npm run dev      (localhost:3001)   [o API de QA]
 *     2) ccc-frontend          → npm start        (localhost:3000)
 *   $env:BASE_URL="http://localhost:3000"; $env:API="http://localhost:3001/v1"; $env:SKIP_SEED="1"
 *   npx playwright test --project=qa tests/qa/BL-LANDING-MATERIAL_landing.ui.spec.js
 *
 * ── ROJO ESPERADO sin el fix ──────────────────────────────────────────────
 *   BL-54 el diálogo dice "Próximamente" aunque el CMS tenga video.
 *   BL-55 no existe ningún botón "Ver cápsula …".
 *   BL-56 el botón "Ver descripción…" no abre nada; no hay dialog en Transformar.
 *   BL-57 Academy no refleja el título de cápsula publicado en el CMS.
 *   BL-58 el nombre sigue en el campo después de enviar.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const S = String(Date.now()).slice(-6);
const TECH_EMAIL = `tech.landingui.${S}@ccc.test`;
const TECH_PASSWORD = "Prueba1234!";
const MARCA = `Cápsula prueba ${S}`;
// Imagen que existe en el propio front (no depende de Storage).
const IMG_PRUEBA = "/assets/wepb_L6/coleccion2.webp";

const originales = {};
let uidTech = null;
let techHeaders = null;

const api = async (ctx, method, path, opts = {}) => {
  const res = await ctx[method](`${API}${path}`, opts);
  return { status: res.status(), body: await res.json().catch(() => null) };
};

test.describe.configure({ mode: "serial" });

test.describe("Material de landings (BL-54…58) @ui @publico", () => {
  test.beforeAll(async () => {
    const user = await qaAuth().createUser({ email: TECH_EMAIL, password: TECH_PASSWORD });
    await qaAuth().setCustomUserClaims(user.uid, { role: "TECH_SUPPORT" });
    uidTech = user.uid;
    techHeaders = await headersFor(TECH_EMAIL, TECH_PASSWORD);

    const ctx = await pwRequest.newContext();
    for (const pagina of ["home", "academy", "transformar"]) {
      originales[pagina] = (await api(ctx, "get", `/site-content/${pagina}`)).body?.data ?? {};
    }
    const home = originales.home;
    await api(ctx, "put", "/site-content/home", {
      headers: techHeaders,
      data: {
        ...home,
        HOME_HERO: { ...(home.HOME_HERO || {}), videoUrl: "https://www.youtube.com/watch?v=R3kcANRV1L4" },
        SHOW_CAPSULAS: true,
        HOME_CAPSULAS: {
          ...(home.HOME_CAPSULAS || {}),
          items: [
            { num: "01", title: MARCA, url: "https://www.youtube.com/watch?v=sLCOZOBeaRY" },
            { num: "02", title: "El cuello de botella", url: "https://www.youtube.com/watch?v=HBNHKgs4NyI" },
            { num: "03", title: "Sin link (decorativa)", url: "" },
          ],
        },
      },
    });
    await api(ctx, "put", "/site-content/academy", {
      headers: techHeaders,
      data: {
        ...originales.academy,
        IMAGENES: { ...(originales.academy.IMAGENES || {}), academyLineaVolumenes: IMG_PRUEBA },
      },
    });
    await api(ctx, "put", "/site-content/transformar", {
      headers: techHeaders,
      data: {
        ...originales.transformar,
        IMAGENES: { ...(originales.transformar.IMAGENES || {}), transformarDashboard: IMG_PRUEBA },
      },
    });
    await ctx.dispose();
  });

  test.afterAll(async () => {
    const ctx = await pwRequest.newContext();
    for (const [pagina, doc] of Object.entries(originales)) {
      await api(ctx, "put", `/site-content/${pagina}`, { headers: techHeaders, data: doc }).catch(() => {});
    }
    await ctx.dispose();
    if (uidTech) await qaAuth().deleteUser(uidTech).catch(() => {});
  });

  test("BL-54 · Home: 'Ver Demo' abre el tutorial de YouTube", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /ver demo/i }).click();
    const dialog = page.getByRole("dialog", { name: "Ver Demo" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("iframe")).toHaveAttribute("src", /youtube\.com\/embed\/R3kcANRV1L4/);
    await expect(dialog.getByText(/próximamente/i)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  // La sección de cápsulas se pinta SOLO en Academy (el Home no la renderiza:
  // `Capsulas.jsx` no se monta en Landing.jsx). Se edita en la pestaña Home del CMS.
  test("BL-57 + BL-55 · Academy lee las cápsulas del CMS; la tarjeta con link abre SU video, la sin link no es botón", async ({ page }) => {
    await page.goto("/academy");
    const tarjeta = page.getByRole("button", { name: new RegExp(`ver cápsula 01: ${MARCA}`, "i") });
    await tarjeta.scrollIntoViewIfNeeded();
    await expect(tarjeta).toBeVisible(); // BL-57: antes Academy pintaba los títulos estáticos
    await tarjeta.click();
    const dialog = page.getByRole("dialog", { name: MARCA });
    await expect(dialog.locator("iframe")).toHaveAttribute("src", /youtube\.com\/embed\/sLCOZOBeaRY/);
    await page.getByRole("button", { name: /cerrar video/i }).click();
    await expect(dialog).toHaveCount(0);
    // Tarjeta 03 sin link: decorativa, no es botón
    await expect(page.getByRole("button", { name: /ver cápsula 03/i })).toHaveCount(0);
    await expect(page.getByText("Sin link (decorativa)")).toBeVisible();
  });

  test("BL-56 · Academy: 'Ver descripción de todos los volúmenes' abre la Línea de seguimiento en grande", async ({ page }) => {
    await page.goto("/academy");
    const boton = page.getByRole("button", { name: /ver descripción de todos los volúmenes/i });
    await boton.scrollIntoViewIfNeeded();
    await boton.click();
    const lightbox = page.getByTestId("lightbox");
    await expect(lightbox).toBeVisible();
    await expect(lightbox.getByRole("img")).toHaveAttribute("src", new RegExp(IMG_PRUEBA.replace(/\//g, "\\/")));
    await page.getByRole("button", { name: /cerrar imagen/i }).click();
    await expect(lightbox).toHaveCount(0);
  });

  test("BL-56 · Transformar: la imagen del paso 3 se ve completa y abre en grande", async ({ page }) => {
    await page.goto("/transformar");
    const boton = page.getByRole("button", { name: /ver en grande la imagen del sistema/i });
    await boton.scrollIntoViewIfNeeded();
    // object-contain: la imagen NO se recorta dentro de la tarjeta
    await expect(boton.locator("img")).toHaveClass(/object-contain/);
    await boton.click();
    await expect(page.getByTestId("lightbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("lightbox")).toHaveCount(0);
  });

  test("BL-58 · Dudas: al enviar se limpia el formulario y aparece el aviso", async ({ page }) => {
    await page.goto("/dudas");
    // No abrir WhatsApp de verdad: se intercepta window.open.
    await page.evaluate(() => { window.__abiertos = []; window.open = (u) => { window.__abiertos.push(u); return null; }; });
    await page.getByLabel(/nombre completo/i).fill("Prueba Landing");
    await page.getByLabel(/correo electrónico/i).fill(`landing.${S}@test.com`);
    await page.getByLabel(/whatsapp o teléfono/i).fill(`55${S}0000`.slice(0, 10));
    await page.getByRole("radio").first().check();
    await page.getByLabel(/cuéntanos brevemente tu duda/i).fill("Mensaje de prueba del formulario.");
    await page.getByRole("button", { name: /quiero hablar sobre mi taller/i }).click();

    const abiertos = await page.evaluate(() => window.__abiertos);
    expect(abiertos).toHaveLength(1);
    expect(abiertos[0]).toMatch(/wa\.me|whatsapp/);
    await expect(page.getByLabel(/nombre completo/i)).toHaveValue("");
    await expect(page.getByLabel(/cuéntanos brevemente tu duda/i)).toHaveValue("");
    await expect(page.getByRole("radio").first()).not.toBeChecked();
    await expect(page.getByRole("status")).toContainText(/abrimos whatsapp/i);
    // Empezar a escribir otra duda quita el aviso.
    await page.getByLabel(/nombre completo/i).fill("O");
    await expect(page.getByRole("status")).toHaveText("");
  });
});
