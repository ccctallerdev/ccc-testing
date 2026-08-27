const { test, expect } = require("@playwright/test");
const { ID_WORKSHOP, stamp, getJson, makeSupplier, login, clientsOfWorkshop } = require("./_helpers");

/**
 * Bloques 3 y 4 (25-ago) — Obs. 16-ago #2/#11 (clientes que "no aparecen") y
 * #5/#10 (importación de inventario sin precio ni proveedor):
 *   - Importar CSV de clientes deja a cada fila AFILIADA (con token) → aparece
 *     en la lista del taller; repetir el archivo dice "ya estaban".
 *     El CSV va con `;`, encabezados en español y teléfono con guiones.
 *   - "Crear cliente" en /elegir-vehiculo también afilia.
 *   - Importar inventario lee "$300", "1,500.00" y la columna `supplier`
 *     (nombre → proveedor real), y avisa de los artículos sin precio.
 *
 * PRERREQUISITOS: emuladores + backend + frontend + seed (rol ADMIN: la
 * tarjeta "Datos del sistema" solo la ve el dueño).
 */

const s = stamp();

/** Fila de una entidad en la tarjeta "Datos del sistema" (tiene su input file). */
const entityRow = (page, label) =>
  page
    .locator("div.rounded-lg")
    .filter({ has: page.getByText(label, { exact: true }) })
    .filter({ has: page.locator('input[type="file"]') })
    .first();

async function importCsv(page, label, name, text) {
  const row = entityRow(page, label);
  await expect(row).toBeVisible({ timeout: 20000 });
  await row.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: "text/csv",
    buffer: Buffer.from(text, "utf8"),
  });
}

test.describe.serial("Bloques 3–4 — importación y alta de clientes / inventario", () => {
  const CLIENTS = [
    { fullName: `Brenda Importada ${s}`, email: `brenda.imp.${s}@ccc.test`, phone: `55-13${s.slice(0, 2)}-${s.slice(2)}` },
    { fullName: `Carlos Importado ${s}`, email: `carlos.imp.${s}@ccc.test`, phone: `5514${s}`.slice(0, 10) },
  ];
  // Excel en español: separador `;`, encabezados humanos.
  const clientsCsv =
    "Nombre completo;Correo;Teléfono\r\n" +
    CLIENTS.map((c) => `${c.fullName};${c.email};${c.phone}`).join("\r\n") +
    "\r\n";

  test("1) UI: importar CSV de clientes (`;`, encabezados en español) → afiliados y visibles", { tag: ["@ui", "@api"] }, async ({ page, request }) => {
    test.setTimeout(120_000);
    await login(page);
    await page.goto("/configuracion");
    await importCsv(page, "Clientes", `clientes_${s}.csv`, clientsCsv);
    await expect(page.getByText(/Clientes: 2 importados/i)).toBeVisible({ timeout: 30000 });

    for (const c of CLIENTS) {
      const found = (await clientsOfWorkshop(request, c.email)).find((x) => x.email === c.email);
      expect(found, `${c.email} aparece en la lista del taller`).toBeTruthy();
      expect(found.tokenId, "afiliado (token vivo)").toBeTruthy();
      expect(found.phone, "teléfono saneado a 10 dígitos").toMatch(/^\d{10}$/);
    }
  });

  test("2) UI: repetir el mismo archivo no duplica: 'ya estaban en tu taller'", { tag: ["@ui", "@api"] }, async ({ page, request }) => {
    test.setTimeout(120_000);
    await login(page);
    await page.goto("/configuracion");
    await importCsv(page, "Clientes", `clientes_${s}_bis.csv`, clientsCsv);
    await expect(page.getByText(/Clientes: 2 ya estaban en tu taller/i)).toBeVisible({ timeout: 30000 });
    const all = await clientsOfWorkshop(request, `imp.${s}`);
    expect(all.filter((x) => x.email.includes(`imp.${s}`)).length).toBe(2);
  });

  test("3) UI: 'Crear cliente' en /elegir-vehiculo afilia al taller (aparece en la lista)", { tag: ["@ui", "@api"] }, async ({ page, request }) => {
    test.setTimeout(120_000);
    const email = `paso1.${s}@ccc.test`;
    await login(page);
    await page.goto("/elegir-vehiculo");
    await page.getByRole("button", { name: /crear cliente/i }).first().click();
    // El modal de este paso es propio (clients/utils/Modal), no antd: se
    // localiza por el formulario con sus campos.
    const form = page.locator("form").filter({ has: page.locator("#step1-name") });
    await expect(form).toBeVisible({ timeout: 15000 });
    await form.locator("#step1-name").fill(`Paso Uno ${s}`);
    await form.locator("#step1-phone").fill(`5515${s}`.slice(0, 10));
    await form.locator("#step1-email").fill(email);
    await form.getByRole("button", { name: /^crear cliente$/i }).click();
    // Pasa a la fase de edición del cliente recién creado.
    await expect(page.getByText(/cliente creado|cliente afiliado/i).first()).toBeVisible({ timeout: 20000 });

    const found = (await clientsOfWorkshop(request, email)).find((x) => x.email === email);
    expect(found, "el cliente del paso 1 está en la lista del taller").toBeTruthy();
    expect(found.tokenId).toBeTruthy();
  });

  test("4) UI: importar inventario con precios 'de Excel' y columna proveedor", { tag: ["@ui", "@api"] }, async ({ page, request }) => {
    test.setTimeout(120_000);
    const sup = await makeSupplier(request, s, "IMP");
    const csv =
      "sku,name,cost,price,stock,supplier\r\n" +
      `IMP-${s}-A,Balata importada ${s},"$150.50","1,500.00",4,${sup.supplierName}\r\n` +
      `IMP-${s}-B,Filtro importado ${s},"120,50",300,2,Proveedor Inexistente ${s}\r\n` +
      `IMP-${s}-C,Bujía importada ${s},40,,6,\r\n`;

    await login(page);
    await page.goto("/configuracion");
    await importCsv(page, "Inventario", `inventario_${s}.csv`, csv);
    await expect(page.getByText(/Inventario: 3 importados/i)).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/1 artículo quedó sin precio al cliente/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/1 artículo con proveedor no reconocido/i)).toBeVisible({ timeout: 10000 });

    const list = await getJson(request, `/inventory?idWorkshop=${ID_WORKSHOP}&search=${encodeURIComponent(`importad`)}&limit=100`);
    const items = list?.items ?? [];
    const a = items.find((i) => i.sku === `IMP-${s}-A`);
    const b = items.find((i) => i.sku === `IMP-${s}-B`);
    const c = items.find((i) => i.sku === `IMP-${s}-C`);
    expect(a, "artículo A importado").toBeTruthy();
    expect(Number(a.cost)).toBe(150.5);
    expect(Number(a.price), '"1,500.00" → 1500').toBe(1500);
    expect(a.supplierId).toBe(sup.supplierId);
    expect(a.supplierName).toBe(sup.supplierName);
    expect(Number(b.cost), '"120,50" (coma decimal) → 120.5').toBe(120.5);
    expect(Number(b.price)).toBe(300);
    expect(b.supplierId || "").toBe("");
    expect(Number(c.price), "precio vacío → 0 (avisado)").toBe(0);
  });
});
