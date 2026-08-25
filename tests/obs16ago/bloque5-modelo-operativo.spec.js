const { test, expect } = require("@playwright/test");
const { ID_WORKSHOP, ADMIN_EMAIL, ADMIN_PASSWORD, getJson, put, api, tokenFor, login } = require("./_helpers");

/**
 * Bloque 5 (25-ago) — Obs. 16-ago #1 "una vez que se llena, ya no se puede
 * editar Salud del taller": el formulario valida campo por campo (entero,
 * mínimo/máximo, vacío, texto), NO guarda nada si algo está mal y marca el
 * campo; con valores válidos guarda y el backend lo refleja. Obs. #1b: el
 * resumen de capacidad explica de dónde salen las "Horas disponibles".
 */

const OM = `/settings/operating-model?idWorkshop=${ID_WORKSHOP}`;

test.describe.serial("Bloque 5 — Modelo Operativo valida y guarda", () => {
  let original;

  test.beforeAll(async ({ request }) => {
    original = await getJson(request, OM);
  });

  test.afterAll(async ({ request }) => {
    // Deja el taller como estaba.
    if (original) {
      await put(request, OM, {
        daysAtRisk: Number(original.daysAtRisk) || 4,
        hoursStageBlocked: Number(original.hoursStageBlocked) || 24,
        daysCemetery: Number(original.daysCemetery) || 10,
      });
    }
  });

  test("1) UI: un decimal donde va entero y un 0 donde va positivo se marcan y NO se guarda nada", { tag: ["@ui", "@api"] }, async ({ page, request }) => {
    await login(page);
    await page.goto("/configuracion");
    await expect(page.getByText(/modelo operativo/i).first()).toBeVisible({ timeout: 20000 });

    const daysAtRisk = page.locator("#om-daysAtRisk");
    const hoursBlocked = page.locator("#om-hoursStageBlocked");
    await expect(daysAtRisk).toHaveAttribute("type", "number");
    await daysAtRisk.fill("6.5");
    await hoursBlocked.fill("0");
    await page.getByRole("button", { name: /guardar modelo operativo/i }).click();

    await expect(page.getByText(/revisa los campos marcados/i)).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#om-error-daysAtRisk")).toContainText(/entero/i);
    await expect(daysAtRisk).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#om-error-hoursStageBlocked")).toContainText(/mayor que 0/i);
    // El primer campo inválido recibe el foco (a11y).
    await expect(daysAtRisk).toBeFocused();

    // Nada viajó al backend.
    const after = await getJson(request, OM);
    expect(Number(after.daysAtRisk)).toBe(Number(original.daysAtRisk));
    expect(Number(after.hoursStageBlocked)).toBe(Number(original.hoursStageBlocked));
  });

  test("2) UI: campo vacío o con texto también se marca (antes se omitía en silencio con toast de éxito)", { tag: ["@ui"] }, async ({ page }) => {
    await login(page);
    await page.goto("/configuracion");
    const daysCemetery = page.locator("#om-daysCemetery");
    await expect(daysCemetery).toBeVisible({ timeout: 20000 });
    await daysCemetery.fill("");
    await page.getByRole("button", { name: /guardar modelo operativo/i }).click();
    await expect(page.locator("#om-error-daysCemetery")).toContainText(/captura un valor/i);
    await expect(page.getByText(/modelo operativo guardado/i)).toHaveCount(0);
  });

  test("3) UI: con valores válidos guarda, el error se limpia y el backend lo refleja", { tag: ["@ui", "@api"] }, async ({ page, request }) => {
    const nuevoRiesgo = (Number(original.daysAtRisk) || 4) + 1;
    await login(page);
    await page.goto("/configuracion");
    const daysAtRisk = page.locator("#om-daysAtRisk");
    await expect(daysAtRisk).toBeVisible({ timeout: 20000 });
    await daysAtRisk.fill(String(nuevoRiesgo));
    await page.locator("#om-hoursStageBlocked").fill("36");
    await page.getByRole("button", { name: /guardar modelo operativo/i }).click();
    await expect(page.getByText(/modelo operativo guardado/i)).toBeVisible({ timeout: 15000 });
    await expect(page.locator("#om-error-daysAtRisk")).toHaveCount(0);

    const after = await getJson(request, OM);
    expect(Number(after.daysAtRisk)).toBe(nuevoRiesgo);
    expect(Number(after.hoursStageBlocked)).toBe(36);
  });

  test("4) UI: resumen de capacidad visible (horas de mecánicos, no capturadas aquí) y API get-mechanics expone isActive/hoursPerDay", { tag: ["@ui", "@api"] }, async ({ page, request }) => {
    await login(page);
    await page.goto("/configuracion");
    const summary = page.getByTestId("om-capacity-summary");
    await expect(summary).toBeVisible({ timeout: 20000 });
    await expect(summary).toContainText(/horas disponibles hoy en el centro de control/i);
    await expect(summary).toContainText(/mecánico|no hay mecánicos/i);

    const token = await tokenFor(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await api(request, token, "get", "/users/get-mechanics");
    expect(res.status).toBe(200);
    const users = res.data?.users ?? [];
    expect(users.length, "la seed siembra al menos un mecánico").toBeGreaterThan(0);
    expect(users[0]).toHaveProperty("isActive");
    expect(users[0]).toHaveProperty("hoursPerDay");
  });

  test("5) API: si algo se cuela al backend, el 400 trae el detalle por campo (path + message)", { tag: ["@api"] }, async ({ request }) => {
    const token = await tokenFor(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await api(request, token, "put", OM, { daysAtRisk: 2.5 });
    expect(res.status).toBe(400);
    const errs = res.body?.errors;
    expect(Array.isArray(errs), `errors debe ser arreglo: ${JSON.stringify(res.body)}`).toBe(true);
    expect(errs[0]?.path?.[0]).toBe("daysAtRisk");
    expect(String(errs[0]?.message || "")).not.toBe("");
  });
});
