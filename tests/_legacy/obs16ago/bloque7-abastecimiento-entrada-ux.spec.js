const { test, expect } = require("@playwright/test");
const { ID_WORKSHOP, stamp, idOf, post, getJson, makeApprovedOs, makeSupplier, makeEntry, login } = require("./_helpers");

/**
 * Bloque 7 (25-ago) — UX de Entrada y Abastecimiento:
 *   #9  El botón "Hoja de servicio" se pinta azul cuando la OS ya tiene hoja
 *       (aunque no haya selección oficial); gris solo sin hoja.
 *   #8  Abastecimiento "por Proveedor" agrupa en tarjetas por proveedor, con
 *       "Sin proveedor" (el "General" del cliente) al final, y ese pedido se
 *       puede CANCELAR (queda en histórico, no se borra).
 *   #7  El formulario de pedido: horas libres (input numérico + atajos),
 *       fecha Y hora esperada (datetime-local) y casilla "Incluir en este
 *       pedido" por partida; la tarjeta muestra fecha con hora.
 */

test.describe.serial("Bloque 7 — Abastecimiento y tarjeta de Entrada", () => {
  let os;
  let sup;
  let poId;

  test.beforeAll(async ({ request }) => {
    os = await makeApprovedOs(request, { tag: "UX7" }); // genera el pedido "Sin proveedor"
    sup = await makeSupplier(request, os.s, "UX7");
    const po = await post(request, "/purchase-orders", {
      idWorkshop: ID_WORKSHOP,
      entryId: os.entryId,
      supplierId: sup.supplierId,
      expectedDate: Date.now() + 8 * 3600 * 1000,
      items: [{ description: os.partName, qty: 1, unitCost: 900 }],
    });
    poId = idOf(po);
  });

  test("#9 UI: la OS con hoja (sin oficial) muestra 'Hoja de servicio' en azul; sin hoja, gris", { tag: ["@ui", "@api"] }, async ({ page, request }) => {
    const conHoja = await makeEntry(request, { tag: "HJA", withSheet: true });
    const sinHoja = await makeEntry(request, { tag: "HJB", withSheet: false });

    await login(page);
    await page.goto("/registro");
    const search = page.getByRole("textbox", { name: /buscar por no\. de os/i });

    await search.fill(conHoja.os);
    await page.getByRole("button", { name: /^buscar$/i }).click();
    const cardA = page.locator(".rounded-xl", { hasText: `OS: ${conHoja.os}` }).first();
    await expect(cardA).toBeVisible({ timeout: 20000 });
    const hojaA = cardA.getByRole("button", { name: /^hoja de servicio$/i });
    await expect(hojaA).toBeVisible();
    await expect(hojaA, "azul = ya hay hoja").toHaveClass(/text-blue-800/);

    await search.fill(sinHoja.os);
    await page.getByRole("button", { name: /^buscar$/i }).click();
    const cardB = page.locator(".rounded-xl", { hasText: `OS: ${sinHoja.os}` }).first();
    await expect(cardB).toBeVisible({ timeout: 20000 });
    const hojaB = cardB.getByRole("button", { name: /sin hoja de servicio/i });
    await expect(hojaB).toBeVisible();
    await expect(hojaB).toHaveClass(/text-gray-700/);
  });

  test("#8 UI: vista por Proveedor agrupada; 'Sin proveedor' al final con aviso; la tarjeta muestra fecha con hora", { tag: ["@ui"] }, async ({ page }) => {
    await login(page);
    await page.goto("/abastecimiento");
    await page.getByRole("button", { name: /^proveedor$/i }).click();

    const grupoSup = page.getByRole("region", { name: `Pedidos de ${sup.supplierName}` });
    await expect(grupoSup).toBeVisible({ timeout: 20000 });
    await expect(grupoSup.locator(".rounded-xl", { hasText: `OS ${os.os}` }).first()).toBeVisible();
    // Fecha esperada con hora ("… esperada 18 ago 2026, 13:57").
    await expect(grupoSup.getByText(/esperada .*\d{1,2}:\d{2}/i).first()).toBeVisible();

    const grupoGeneral = page.getByRole("region", { name: /pedidos de sin proveedor/i });
    await expect(grupoGeneral).toBeVisible();
    await expect(grupoGeneral.getByText(/repártelas con «otro proveedor» y cancela este pedido/i)).toBeVisible();

    // Orden: el grupo del proveedor va antes que "Sin proveedor".
    const regions = page.getByRole("region");
    const names = await regions.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") || ""));
    const iSup = names.indexOf(`Pedidos de ${sup.supplierName}`);
    const iGen = names.findIndex((n) => /sin proveedor/i.test(n));
    expect(iSup).toBeGreaterThanOrEqual(0);
    expect(iGen).toBeGreaterThan(iSup);
  });

  test("#8 UI: cancelar el pedido 'Sin proveedor' de la OS → confirmación, sale de activos, queda CANCELLED", { tag: ["@ui", "@api"] }, async ({ page, request }) => {
    const before = await getJson(request, `/purchase-orders?idWorkshop=${ID_WORKSHOP}&scope=all`);
    const general = (before?.orders ?? []).find(
      (o) => o.entryId === os.entryId && !o.supplierId && o.origin !== "INVENTORY" && o.status === "OPEN",
    );
    expect(general, "existe el pedido automático sin proveedor de la OS").toBeTruthy();

    await login(page);
    await page.goto("/abastecimiento");
    await page.getByRole("button", { name: /^proveedor$/i }).click();
    const grupoGeneral = page.getByRole("region", { name: /pedidos de sin proveedor/i });
    const card = grupoGeneral.locator(".rounded-xl", { hasText: `OS ${os.os}` }).first();
    await expect(card).toBeVisible({ timeout: 20000 });
    // El botón lleva aria-label "Cancelar pedido <proveedor> de la OS n".
    await card.getByRole("button", { name: /^cancelar pedido/i }).click();

    const confirm = page.locator(".ant-modal-confirm");
    await expect(confirm.getByText(/se cancelará el pedido/i)).toBeVisible({ timeout: 10000 });
    await confirm.getByRole("button", { name: /cancelar pedido/i }).click();
    await expect(page.getByText(/^pedido cancelado$/i)).toBeVisible({ timeout: 15000 });
    await expect(card).toHaveCount(0, { timeout: 15000 });

    const after = await getJson(request, `/purchase-orders?idWorkshop=${ID_WORKSHOP}&scope=all`);
    const cancelled = (after?.orders ?? []).find((o) => o.id === general.id);
    expect(cancelled?.status, "sigue existiendo, como cancelado").toBe("CANCELLED");
    // El pedido al proveedor real no se tocó.
    const mine = (after?.orders ?? []).find((o) => o.id === poId);
    expect(mine?.status).toBe("OPEN");
  });

  test("#7 UI: el formulario de pedido tiene horas libres con atajos, fecha-hora y casilla 'Incluir'; excluir una partida la deja fuera", { tag: ["@ui", "@api"] }, async ({ page, request }) => {
    test.setTimeout(120_000);
    const s = stamp();
    await login(page);
    await page.goto("/abastecimiento");
    await page.getByRole("button", { name: /nueva orden de compra/i }).click();
    const modal = page.locator(".ant-modal").last();
    await expect(modal).toBeVisible({ timeout: 15000 });

    const hours = modal.locator("#po-promised-hours");
    await expect(hours).toHaveAttribute("type", "number");
    await modal.getByRole("button", { name: /^8 h$/i }).click();
    await expect(hours).toHaveValue("8");
    await hours.fill("6"); // libre, no solo los atajos
    await expect(modal.locator("#po-expected-date")).toHaveAttribute("type", "datetime-local");

    await modal.locator("select").first().selectOption(sup.supplierId);
    // Partida 1 (se incluye) y partida 2 (se excluye con la casilla).
    await modal.getByPlaceholder(/bomba de gasolina/i).nth(0).fill(`Partida incluida ${s}`);
    await modal.getByRole("button", { name: /agregar partida/i }).click();
    await modal.getByPlaceholder(/bomba de gasolina/i).nth(1).fill(`Partida excluida ${s}`);
    const checks = modal.getByRole("checkbox", { name: /incluir en este pedido/i });
    await expect(checks).toHaveCount(2);
    await checks.nth(1).uncheck();
    await expect(modal.getByText(/\(1 de 2 partidas\)/i)).toBeVisible();

    await modal.getByRole("button", { name: /crear orden/i }).click();
    await expect(page.getByText(/orden de compra creada/i)).toBeVisible({ timeout: 15000 });

    const list = await getJson(request, `/purchase-orders?idWorkshop=${ID_WORKSHOP}&scope=all`);
    const created = (list?.orders ?? []).find((o) => (o.items || []).some((it) => it.description === `Partida incluida ${s}`));
    expect(created, "pedido creado con la partida incluida").toBeTruthy();
    expect(created.items.length, "solo la partida incluida").toBe(1);
    expect(created.items.some((it) => it.description === `Partida excluida ${s}`)).toBe(false);
    // 6 horas prometidas ⇒ expectedDate ≈ ahora + 6 h (±10 min).
    const diffH = (Number(created.expectedDate) - Date.now()) / 3600000;
    expect(diffH).toBeGreaterThan(5.8);
    expect(diffH).toBeLessThan(6.2);
  });
});
