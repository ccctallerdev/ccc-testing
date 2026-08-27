const { test, expect } = require("@playwright/test");

/**
 * Fase 2 — LA prueba de punta a punta del CMS (la promesa completa):
 *
 *   1. TECH_SUPPORT entra a /gestion-contenido, edita el título del hero de
 *      Despertar y publica.
 *   2. Un visitante ANÓNIMO abre /despertar y ve el texto nuevo.
 *   3. Se vacía el campo y se publica: la landing VUELVE al texto de data.js
 *      (la prueba del fallback — la más importante de la guía).
 *
 * PRERREQUISITOS: emuladores + API en :3001 + frontend en :3000, y la seed
 * corrida (global-setup la corre sola; crea a tech@ccc.test / prueba123).
 */

const TECH_EMAIL = process.env.TECH_EMAIL_UI || "tech@ccc.test";
const TECH_PASSWORD = process.env.TECH_PASSWORD_UI || "prueba123";

/** Título estático del hero de Despertar en data.js (el fallback esperado). */
const TITULO_ESTATICO = "TU TALLER NO NECESITA TRABAJAR MÁS.";

/** Campo del editor: id estable que genera EditorCMS desde el esquema. */
const CAMPO_TITULO = "#cms-despertar-DESPERTAR_HERO-titulo";

async function loginTech(page) {
  await page.goto("/login");
  await page.locator("#email").fill(TECH_EMAIL);
  await page.locator("#password").fill(TECH_PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });
}

async function publicar(page) {
  await page.getByRole("button", { name: /publicar cambios en la web/i }).click();
  // La barra fija anuncia el estado; "Todo publicado" = el PUT respondió bien.
  await expect(page.getByText("Todo publicado")).toBeVisible({ timeout: 15000 });
}

test.describe.serial("CMS de punta a punta — editar, ver anónimo, y el fallback", { tag: ["@ui"] }, () => {
  const marca = `CMS E2E ${Date.now()}`;

  test("TECH_SUPPORT publica un título nuevo y el visitante anónimo lo ve", async ({ page, browser }) => {
    await loginTech(page);
    await page.goto("/gestion-contenido");

    // La pestaña Despertar es la primera (activa por defecto); el campo del
    // título del hero tiene id estable generado desde el esquema.
    const campo = page.locator(CAMPO_TITULO);
    await expect(campo).toBeVisible({ timeout: 15000 });
    await campo.fill(marca);
    await expect(page.getByText("Tienes cambios sin publicar")).toBeVisible();
    await publicar(page);

    // Visitante anónimo: contexto NUEVO, sin sesión (las landings públicas
    // van envueltas en RedirectIfAuthenticated — deben verse sin login).
    const anonimo = await browser.newContext();
    const publica = await anonimo.newPage();
    await publica.goto("http://localhost:3000/despertar");
    await expect(publica.getByRole("heading", { level: 1 })).toContainText(marca, { timeout: 15000 });
    await anonimo.close();
  });

  test("vaciar el campo y publicar regresa el texto original (fallback)", async ({ page, browser }) => {
    await loginTech(page);
    await page.goto("/gestion-contenido");

    const campo = page.locator(CAMPO_TITULO);
    await expect(campo).toBeVisible({ timeout: 15000 });
    // Sanidad: el campo aún trae la marca del test anterior.
    await expect(campo).toHaveValue(marca);
    await campo.fill("");
    await publicar(page);

    const anonimo = await browser.newContext();
    const publica = await anonimo.newPage();
    await publica.goto("http://localhost:3000/despertar");
    const h1 = publica.getByRole("heading", { level: 1 });
    await expect(h1).toContainText(TITULO_ESTATICO, { timeout: 15000 });
    await expect(h1).not.toContainText(marca);
    await anonimo.close();
  });
});
