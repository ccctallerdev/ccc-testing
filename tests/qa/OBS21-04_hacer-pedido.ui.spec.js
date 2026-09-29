const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OBS21-04 — "Hacer pedido" en Abastecimiento, por los 6 roles @ui
 * (ramas fix/obs21-04-hacer-pedido-front + -api) — escrito NUEVO, no reciclado
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Roberto, 21-sep (punto 5): el botón de la tarjeta pasa a "Hacer pedido"; la
 * ventana trae el proveedor elegido en Costeo; las horas / fecha de la
 * refacción van a la alerta de entrega; "Cambiar proveedor" queda dentro como
 * paso secundario. D31: "Solicitado" lo marca el responsable a mano.
 *
 * Acceso: /abastecimiento exige CAN_GENERATE_PURCHASE_ORDER → Dueño,
 * Administrador y Compras entran (desde el menú lateral "Abastecimiento");
 * Asesor, Recepción y Mecánico rebotan.
 *
 * Datos: por cada rol que entra se crea por API (con la cuenta del Dueño) una
 * orden con proveedor real y sin fecha — así cada rol hace SU pedido.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   ⚠️ Front LOCAL con la rama y back con la rama (QA aún no los tiene).
 *   $env:BASE_URL="http://localhost:3000"; $env:API="http://localhost:3001/v1"
 *   $env:AUTH_REAL="1"; $env:SKIP_SEED="1"; $env:ID_WORKSHOP="G85FhlhedkD4L4CEDWvW"
 *   $env:SEED_EMAIL="rsv_gpa@outlook.com"; $env:SEED_PASSWORD="<contraseña>"
 *   $env:ROL_ADMINISTRADOR_EMAIL="rsv_gpa+admin1@outlook.com"; $env:ROL_ADMINISTRADOR_PASS="<...>"
 *   $env:ROL_ASESOR_EMAIL="rsv_gpa+asesor1@outlook.com";       $env:ROL_ASESOR_PASS="<...>"
 *   $env:ROL_COMPRAS_EMAIL="rsv_gpa+compras1@outlook.com";     $env:ROL_COMPRAS_PASS="<...>"
 *   $env:ROL_MECANICO_EMAIL="rsv_gpa+mecanico1@outlook.com";   $env:ROL_MECANICO_PASS="<...>"
 *   $env:ROL_RECEPCION_EMAIL="rsv_gpa+recepcion1@outlook.com"; $env:ROL_RECEPCION_PASS="<...>"
 *   npx playwright test --project=qa tests/qa/OBS21-04_hacer-pedido.ui.spec.js
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP;

const ROLES = [
  { nombre: "Dueño", clave: "DUENO", entra: true,
    email: process.env.ROL_DUENO_EMAIL || process.env.SEED_EMAIL || "rsv_gpa@outlook.com",
    pass: process.env.ROL_DUENO_PASS || process.env.SEED_PASSWORD },
  { nombre: "Administrador", clave: "ADMINISTRADOR", entra: true },
  { nombre: "Asesor", clave: "ASESOR", entra: false },
  { nombre: "Compras", clave: "COMPRAS", entra: true },
  { nombre: "Mecánico", clave: "MECANICO", entra: false },
  { nombre: "Recepción", clave: "RECEPCION", entra: false },
].map((r) => ({
  ...r,
  email: r.email || process.env[`ROL_${r.clave}_EMAIL`],
  pass: r.pass || process.env[`ROL_${r.clave}_PASS`],
}));

const S = String(Date.now()).slice(-7);
const proveedor = { id: null, name: `Refacciones UI OBS21-04 ${S}` };
const ordenPorRol = {}; // clave → { id, desc }

async function call(request, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: await authHeaders(),
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json, data: json?.data ?? json };
}
const idOf = (d) => d?.id ?? d;

async function entrarComo(page, rol) {
  await page.goto("/login");
  await page.locator("#email").fill(rol.email);
  await page.locator("#password").fill(rol.pass);
  await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });
  await expect(page).not.toHaveURL(/\/suscripcion/, { timeout: 5000 });
}

test.describe.configure({ mode: "default" });

test.describe("OBS21-04 — Hacer pedido en Abastecimiento, por roles @ui", () => {
  test.beforeAll(async ({ request }) => {
    test.setTimeout(60000);
    if (!ID_WORKSHOP) throw new Error('Falta ID_WORKSHOP (taller de refac).');
    const sup = await call(request, "post", "/suppliers", { idWorkshop: ID_WORKSHOP, name: proveedor.name });
    expect(sup.status, JSON.stringify(sup.body)).toBeLessThan(300);
    proveedor.id = idOf(sup.data);
    for (const rol of ROLES.filter((r) => r.entra)) {
      const desc = `Pieza UI ${rol.clave} ${S}`;
      const po = await call(request, "post", "/purchase-orders", {
        idWorkshop: ID_WORKSHOP, supplierId: proveedor.id, notes: "spec OBS21-04 UI",
        items: [{ description: desc, qty: 1, unitCost: 150 }],
      });
      expect(po.status, JSON.stringify(po.body)).toBeLessThan(300);
      ordenPorRol[rol.clave] = { id: idOf(po.data), desc };
    }
  });

  for (const rol of ROLES) {
    test(`OBS21-04 — ${rol.nombre}`, async ({ page, request }, testInfo) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);
      await entrarComo(page, rol);
      await page.goto("/abastecimiento");

      if (!rol.entra) {
        await expect(page, `${rol.nombre} no entra a Abastecimiento`).not.toHaveURL(/\/abastecimiento/, { timeout: 15000 });
        return;
      }

      const { id, desc } = ordenPorRol[rol.clave];
      const tarjeta = page.locator("div.rounded-xl.border.bg-white.p-4").filter({ hasText: desc });
      await expect(tarjeta, `${rol.nombre}: la orden de prueba debe verse`).toBeVisible({ timeout: 20000 });
      await expect(tarjeta.getByRole("button", { name: /otro proveedor/i }), "ya no existe 'Otro proveedor' en la tarjeta").toHaveCount(0);

      await tarjeta.getByRole("button", { name: /hacer pedido/i }).click();
      const modal = page.getByRole("dialog");
      await expect(modal, "se abre la ventana 'Hacer pedido'").toBeVisible();
      await expect(modal.getByText(proveedor.name), "el proveedor de Costeo viene puesto").toBeVisible();
      await expect(modal.getByText(/sin proveedor/i), "no debe decir '— Sin proveedor —'").toHaveCount(0);
      await expect(modal.getByRole("button", { name: /cambiar proveedor/i }), "'Cambiar proveedor' como paso secundario").toBeVisible();
      await modal.screenshot({ path: testInfo.outputPath(`hacer-pedido-${rol.clave}.png`) });

      // Sin tiempo ni fecha → aviso con texto (no solo color)
      await modal.getByRole("button", { name: /^hacer pedido$/i }).click();
      await expect(modal.getByRole("alert")).toContainText(/horas|fecha/i);

      // exact: "8 h" también coincide con "48 h"
      await modal.getByRole("button", { name: "8 h", exact: true }).click();
      const antes = Date.now();
      await modal.getByRole("button", { name: /^hacer pedido$/i }).click();
      await expect(modal, "la ventana se cierra al guardar").toBeHidden({ timeout: 15000 });

      await expect(tarjeta.getByRole("button", { name: /editar pedido/i }), "la tarjeta queda con el pedido hecho").toBeVisible({ timeout: 15000 });
      await expect(tarjeta, "muestra la fecha esperada de la refacción").toContainText(/esperada/i);
      await expect(tarjeta.getByText(/en tiempo/i), "alerta en verde recién pedido").toBeVisible();
      await tarjeta.screenshot({ path: testInfo.outputPath(`tarjeta-${rol.clave}.png`) });

      // Estado persistido: MISMA orden, fecha ≈ +8 h, sigue "En espera" (D31)
      const o = (await call(request, "get", `/purchase-orders/${id}`)).data;
      expect(Number(o.expectedDate)).toBeGreaterThanOrEqual(antes + 8 * 3600e3 - 120e3);
      expect(Number(o.expectedDate)).toBeLessThanOrEqual(Date.now() + 8 * 3600e3 + 120e3);
      expect(Number(o.orderedAt)).toBeGreaterThan(0);
      expect(o.sourcingStatus).toBe("EN_ESPERA");
    });
  }
});
