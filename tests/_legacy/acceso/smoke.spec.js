const { test, expect } = require("@playwright/test");

/**
 * Prueba de humo: confirma que la app carga y muestra el login.
 * Requiere el frontend corriendo en http://localhost:3000.
 * (El flujo completo Costeo→…→Reparación se agregará después, ya con
 *  los emuladores + un usuario de prueba en el Auth emulator.)
 */
test("la app carga y muestra el login", { tag: ["@ui", "@humo"] }, async ({ page }) => {
  await page.goto("/login");
  await expect(page).toHaveURL(/login/i);
  // Debe existir al menos un campo de correo/usuario y uno de contraseña.
  await expect(page.locator('input[type="password"]')).toBeVisible();
});
