const { test, expect } = require("@playwright/test");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OBS31-08 — Pegar el teléfono desde Excel pierde los 2 últimos dígitos
 * (lado CAPTURA)  @ui
 * SPEC DE REPRODUCCIÓN (nuevo): primero demuestra el bug, luego valida el fix.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lo que reportó Roberto (31-ago, obs. 9): "en los primeros registros dejaba
 * pegar el teléfono completo, pero ya en los últimos le faltaban los 2
 * últimos dígitos y no dejaba guardar. No sé a qué se deba."
 *
 * Hipótesis VERIFICADA leyendo el código (este spec la firma en rojo):
 *   El input de Teléfono en "Usuarios y Roles" (UserForm) tiene
 *   maxLength={10}. El navegador aplica maxLength al TEXTO PEGADO ANTES de
 *   que el onChange limpie los no-dígitos:
 *     - pega "5551234567"   (celda sin formato) → caben los 10 → OK
 *     - pega "555-123-4567" (celda con formato 3-3-4, 12 caracteres) → el
 *       navegador corta a 10 → "555-123-45" → onChange limpia guiones →
 *       quedan 8 dígitos: se pierden EXACTAMENTE los 2 últimos.
 *   Eso explica el misterio de Roberto: no depende de "primeros o últimos",
 *   depende del FORMATO de la celda que copió. Y como ni el front ni la API
 *   validan (ver spec hermano OBS31-08_telefono-guardado.api.spec.js), el
 *   dato truncado se guarda y aparece con 8 dígitos en Configuración.
 *
 * CONTRA EL CÓDIGO DE HOY se espera: caso 1 VERDE (pegado sin formato),
 * caso 2 ROJO (pegado con guiones pierde 2 dígitos) = bug reproducido.
 * Tras el fix, todo verde. No crea ningún dato: solo escribe en el
 * formulario y lo cancela.
 *
 * NOTA DEL FIX: el campo homologado (PhoneField) MUESTRA la máscara 3-3-4
 * como referencia visual, así que las aserciones comparan los DÍGITOS del
 * campo, no el texto literal. Lo que no puede pasar es perder dígitos.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   $env:BASE_URL="<front de QA o local>"
 *   $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"
 *   $env:AUTH_REAL="1"; $env:SKIP_SEED="1"
 *   $env:SEED_EMAIL="<Dueño>"; $env:SEED_PASSWORD="..."
 *   npx playwright test --project=qa tests/qa/OBS31-08_telefono-pegado.ui.spec.js
 * ═══════════════════════════════════════════════════════════════════════════
 */

const DUENO = {
  correo: process.env.SEED_EMAIL || "prueba@ccc.test",
  password: process.env.SEED_PASSWORD || "prueba123",
};

const TEL_10 = "5512345678";
const TEL_EXCEL = "551-234-5678"; // mismo número, como lo formatea Excel (3-3-4)
// Copia REAL de una celda de Excel: trae formato Y salto de línea al final.
const TEL_EXCEL_CELDA = "(55) 1234-5678\r\n";
const TEL_EXCEL_CELDA_DIGITOS = "5512345678";
const digitos = (v) => String(v).replace(/\D/g, "");

async function entrarComo(page, { correo, password }) {
  await page.goto("/login");
  await page.locator("#email").fill(correo);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });
}

async function abrirAltaUsuario(page) {
  await page.goto("/usuarios");
  await page.getByRole("button", { name: /nuevo usuario/i }).click();
  // Antes del fix el placeholder era "10 dígitos"; el campo homologado usa "555-123-4567".
  const telefono = page.getByPlaceholder(/10 dígitos|555-123-4567/);
  await expect(telefono).toBeVisible({ timeout: 15000 });
  return telefono;
}

/** Pega texto en el campo vía clipboard real (Ctrl+V), como lo hace Roberto. */
async function pegar(page, locator, texto) {
  await page.evaluate((t) => navigator.clipboard.writeText(t), texto);
  await locator.click();
  await locator.press(process.platform === "darwin" ? "Meta+v" : "Control+v");
}

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test.describe("OBS31-08 · pegar el teléfono desde Excel conserva los 10 dígitos @ui", () => {
  test.beforeEach(async ({ page }) => {
    await entrarComo(page, DUENO);
  });

  test("1) pegado SIN formato (10 dígitos corridos) entra completo", async ({ page }) => {
    const telefono = await abrirAltaUsuario(page);
    await pegar(page, telefono, TEL_10);
    const valor = await telefono.inputValue();
    expect(digitos(valor), `el campo quedó con '${valor}'`).toBe(TEL_10);
  });

  test("2) ROJO esperado hoy: pegado CON guiones (formato Excel) no debe perder dígitos", async ({ page }) => {
    const telefono = await abrirAltaUsuario(page);
    await pegar(page, telefono, TEL_EXCEL);

    const valor = await telefono.inputValue();
    expect(
      digitos(valor),
      `Se pegó '${TEL_EXCEL}' y el campo quedó con '${valor}' (${digitos(valor).length} dígitos). ` +
        `maxLength corta el texto pegado ANTES de limpiar los guiones: se pierden los 2 últimos dígitos, ` +
        `igual que le pasó a Roberto.`,
    ).toBe(TEL_10);
  });

  test("3) pegado de una CELDA real de Excel (paréntesis, espacio y salto de línea) tampoco pierde dígitos", async ({ page }) => {
    const telefono = await abrirAltaUsuario(page);
    await pegar(page, telefono, TEL_EXCEL_CELDA);

    const valor = await telefono.inputValue();
    expect(
      digitos(valor),
      `Se pegó ${JSON.stringify(TEL_EXCEL_CELDA)} y el campo quedó con '${valor}' ` +
        `(${digitos(valor).length} dígitos). Excel agrega \r\n al copiar una celda y hay ` +
        `celdas con formato (XX) XXXX-XXXX: nada de eso debe costar dígitos.`,
    ).toBe(TEL_EXCEL_CELDA_DIGITOS);
  });
});
