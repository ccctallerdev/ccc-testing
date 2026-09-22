const { test, expect } = require("@playwright/test");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BLOQUE-TRIV02 — BL-48 · BL-49 @ui
 * (rama fix/bloque-triviales-02-front) — escritos NUEVOS, en ROJO antes del fix
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   BL-48  "Servicios del auto": la fecha se formateaba con `HH:MM` y dayjs
 *          imprime el MES en el lugar de los minutos (todo septiembre salía
 *          ":09"); la columna decía "Fecha servicio" pero mostraba la fecha de
 *          INGRESO; y el encabezado no identificaba el auto (dos Versa del
 *          mismo cliente se veían idénticos).
 *   BL-49  La foto de perfil por omisión era una URL fija al bucket de QA
 *          (`public/userPlaceholder.png`), que desde BL-2 ya no se puede leer:
 *          toda cuenta nueva nacía con la imagen rota. Ahora el avatar sale de
 *          `public/` del propio front, y una URL guardada que falle cae ahí
 *          también. En Configuración, sin logo se muestra el recuadro de
 *          "logotipo pendiente".
 *
 * Cada caso recorre los 6 roles. Un rol sin credenciales se marca SKIP.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   ⚠️ Front LOCAL con la rama (QA corre el código viejo).
 *     1) ccc-backend/functions → npm run dev      (localhost:3001)
 *     2) ccc-frontend          → npm start        (localhost:3000)
 *   $env:BASE_URL="http://localhost:3000"; $env:SKIP_SEED="1"
 *   $env:ROL_DUENO_EMAIL="rsv_gpa@outlook.com";              $env:ROL_DUENO_PASS="admin123"
 *   $env:ROL_ADMINISTRADOR_EMAIL="rsv_gpa+admin1@outlook.com"; $env:ROL_ADMINISTRADOR_PASS="Roles_123!"
 *   $env:ROL_ASESOR_EMAIL="rsv_gpa+asesor1@outlook.com";     $env:ROL_ASESOR_PASS="Roles_123!"
 *   $env:ROL_COMPRAS_EMAIL="rsv_gpa+compras1@outlook.com";   $env:ROL_COMPRAS_PASS="Roles_123!"
 *   $env:ROL_MECANICO_EMAIL="rsv_gpa+mecanico1@outlook.com"; $env:ROL_MECANICO_PASS="Mec_123!"
 *   $env:ROL_RECEPCION_EMAIL="rsv_gpa+recepcion1@outlook.com"; $env:ROL_RECEPCION_PASS="Roles_123!"
 *   npx playwright test --project=qa tests/qa/BLOQUE-TRIV02_bl48-bl49.ui.spec.js
 *
 * ── ROJO ESPERADO sin el fix ──────────────────────────────────────────────
 *   BL-48  la hora sale ":09" (el mes), la columna dice "Fecha servicio" y el
 *          encabezado no trae placas.
 *   BL-49  el avatar apunta a firebasestorage (bucket de QA) y no carga;
 *          Configuración no muestra recuadro cuando el taller no tiene logo.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// Capacidades (permissions.config.js):
//   servicios  = CAN_VIEW_OWN_PRODUCTIVITY   (owner, admin, advisor, mechanic)
//   usuarios   = CAN_MANAGE_USERS            (owner, admin)
//   taller     = el form del taller en Configuración solo lo ve el Dueño
//   entregados = CAN_REGISTER_VEHICLE_ENTRY  (owner, admin, advisor)  ← BL-51
// OJO: RECEPCION se colapsa en ADVISOR (permissions.config.js), por eso comparte
// banderas con Asesor. COMPRAS no tiene `servicios`, así que ni llega a /servicios.
const ROLES = [
  { nombre: "Dueño",         clave: "DUENO",         servicios: true,  usuarios: true,  taller: true,  entregados: true,
    email: process.env.ROL_DUENO_EMAIL || process.env.SEED_EMAIL || "rsv_gpa@outlook.com",
    pass: process.env.ROL_DUENO_PASS || process.env.SEED_PASSWORD || "admin123" },
  { nombre: "Administrador", clave: "ADMINISTRADOR", servicios: true,  usuarios: true,  taller: false, entregados: true },
  { nombre: "Asesor",        clave: "ASESOR",        servicios: true,  usuarios: false, taller: false, entregados: true },
  { nombre: "Compras",       clave: "COMPRAS",       servicios: false, usuarios: false, taller: false, entregados: false },
  { nombre: "Mecánico",      clave: "MECANICO",      servicios: true,  usuarios: false, taller: false, entregados: false },
  { nombre: "Recepción",     clave: "RECEPCION",     servicios: true,  usuarios: false, taller: false, entregados: true },
].map((r) => ({
  ...r,
  email: r.email || process.env[`ROL_${r.clave}_EMAIL`],
  pass: r.pass || process.env[`ROL_${r.clave}_PASS`],
}));

// Datos simulados de BL-48: entrega a las 17:45 de un 8 de marzo — si el
// formato vuelve a usar `MM`, la hora saldría "17:03" (marzo) y el caso truena.
const ENTREGA = Date.UTC(2026, 2, 8, 23, 45, 0); // 17:45 en CDMX (UTC-6)
const CAR_ID = "e2e-triv02-car";
const CLIENT_ID = "e2e-triv02-cli";
const PLACAS = "TRIV-482";
const SERVICIO = {
  id: "e2e-triv02-entry",
  sheet: "9048",
  carId: CAR_ID,
  clientId: CLIENT_ID,
  registerDate: Date.UTC(2026, 1, 2, 16, 0, 0), // ingreso: OTRO día, a propósito
  deliveredAt: ENTREGA,
  statusService: "ENTREGADO",
  quote: { diagnostic: "ROJO · Frenos: balatas al límite.", parts: [{ subtotal: 1700 }], labor: [{ subtotal: 900 }] },
};
const AUTO = { id: CAR_ID, brand: "Nissan", model: "Versa", year: "2023", codeCar: PLACAS };

async function entrarComo(page, rol) {
  await page.goto("/login");
  await page.locator("#email").fill(rol.email);
  await page.locator("#password").fill(rol.pass);
  await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });
  await expect(page).not.toHaveURL(/\/suscripcion/, { timeout: 5000 });
}

async function esperarRebote(page, ruta) {
  await expect(page, `debe rebotar de ${ruta}`).not.toHaveURL(new RegExp(ruta), { timeout: 15000 });
  await expect(page.getByText(/no tienes acceso/i)).toBeVisible({ timeout: 10000 });
}

// Casos independientes: un rojo no debe tumbar al resto.
test.describe.configure({ mode: "default" });

// ─────────────────────────────────────────────────────────────────────────
// BL-48 — Servicios del auto: hora real, fecha de entrega y placas
// ─────────────────────────────────────────────────────────────────────────
test.describe("BL-48 — Servicios del auto identifica el auto y la hora es la hora @ui", () => {
  for (const rol of ROLES) {
    test(`BL-48 — ${rol.nombre}`, async ({ page }) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);

      await page.route(/\/get-car-services\//, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: 200,
            descripcion: "ok",
            data: { carServices: [SERVICIO], clientData: { id: CLIENT_ID, name: "Cliente", firstSurname: "TRIV02" } },
          }),
        }),
      );
      await page.route(new RegExp(`/cars/${CAR_ID}`), (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: 200, descripcion: "ok", data: AUTO }),
        }),
      );

      await entrarComo(page, rol);
      await page.goto(`/auto-servicios/${CAR_ID}/${CLIENT_ID}`);

      if (!rol.servicios) {
        await esperarRebote(page, "/auto-servicios");
        return;
      }

      // 1) El encabezado dice DE QUÉ auto es.
      await expect(
        page.getByText(new RegExp(`Placas:\\s*${PLACAS}`, "i")),
        "sin placas, dos autos del mismo modelo se ven idénticos",
      ).toBeVisible({ timeout: 20000 });

      const fila = page.locator("div.grid", { hasText: /balatas al l[ií]mite/i }).first();
      await expect(fila).toBeVisible({ timeout: 15000 });

      // 2) La hora es la hora: 17:45, no ":03" (el mes con `HH:MM`).
      await expect(fila, "la hora debe traer los MINUTOS, no el mes").toContainText(/17:45/);
      await expect(fila, "`HH:MM` imprimía el mes en lugar de los minutos").not.toContainText(/17:03/);

      // 3) Es la fecha de ENTREGA (8 mar), no la de ingreso (2 feb).
      await expect(fila, "el histórico del auto muestra cuándo se entregó").toContainText(/0?8 mar/i);
      await expect(fila).not.toContainText(/0?2 feb/i);

      // 4) Y la columna se llama como lo que muestra.
      await expect(page.getByText(/fecha de entrega/i)).toBeVisible();
      await page.screenshot({ path: `test-results/BL-48_${rol.clave}.png` });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// BL-51 — el botón "Vehículos Entregados" solo se le muestra a quien puede entrar
// ─────────────────────────────────────────────────────────────────────────
test.describe("BL-51 — Vehículos Entregados no se le ofrece a quien va a rebotar @ui", () => {
  for (const rol of ROLES) {
    test(`BL-51 — ${rol.nombre}`, async ({ page }) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);
      await entrarComo(page, rol);
      await page.goto("/servicios");

      // Compras no tiene CAN_VIEW_OWN_PRODUCTIVITY: ni siquiera llega a la pantalla.
      if (!rol.servicios) {
        await esperarRebote(page, "/servicios");
        return;
      }

      await expect(page.getByRole("heading", { name: /^Servicios$/ })).toBeVisible({ timeout: 20000 });
      const boton = page.getByRole("button", { name: /veh[ií]culos entregados/i });

      if (rol.entregados) {
        await expect(boton, "este rol sí puede entrar, el botón debe estar").toBeVisible();
        await boton.click();
        await expect(page, "y debe llevarlo de verdad").toHaveURL(/\/servicios-entregados/, { timeout: 15000 });
        await expect(page.getByText(/no tienes acceso/i)).toHaveCount(0);
      } else {
        // El bug: al Mecánico se le pintaba y solo lo rebotaba.
        await expect(boton, "un botón que solo sabe rebotarte no se muestra").toHaveCount(0);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// BL-49 — avatar por omisión servido por el front
// ─────────────────────────────────────────────────────────────────────────
test.describe("BL-49 — el avatar por omisión no depende de Storage @ui", () => {
  for (const rol of ROLES) {
    test(`BL-49 avatar — ${rol.nombre}`, async ({ page }) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);

      // El perfil se devuelve SIN foto: así se prueba el camino de la cuenta
      // recién creada, sea cual sea la foto que hoy tenga la cuenta de prueba.
      await page.route(/\/users\/[^/?]+$/, async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const res = await route.fetch();
        const json = await res.json().catch(() => null);
        if (!json?.data) return route.fulfill({ response: res });
        json.data.photoURL = "";
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
      });

      await entrarComo(page, rol);

      const avatar = page.locator('button[aria-haspopup="menu"] img').first();
      await expect(avatar, "sin foto propia debe salir el avatar local").toHaveAttribute(
        "src",
        /\/userPlaceholder\.png$/,
        { timeout: 20000 },
      );
      // Y la imagen CARGA de verdad (no es el icono roto): naturalWidth > 0.
      await expect
        .poll(() => avatar.evaluate((img) => img.complete && img.naturalWidth), { timeout: 15000 })
        .toBeGreaterThan(0);
    });
  }

  test("BL-49 · una photoURL muerta cae al avatar local (cuentas viejas)", async ({ page }) => {
    const rol = ROLES[0];
    test.skip(!rol.email || !rol.pass, "Sin credenciales del Dueño");

    // Exactamente la URL con la que nacieron las cuentas: el bucket de QA.
    const MUERTA =
      "https://firebasestorage.googleapis.com/v0/b/ccc-taller-refac.firebasestorage.app/o/public%2FuserPlaceholder.png?alt=media&token=52868c71-aa00-4666-88ea-80fbf0bb6ef8";
    await page.route(/\/users\/[^/?]+$/, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const res = await route.fetch();
      const json = await res.json().catch(() => null);
      if (!json?.data) return route.fulfill({ response: res });
      json.data.photoURL = MUERTA;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
    });
    // Storage responde 403, como en la vida real desde BL-2.
    await page.route(/firebasestorage\.googleapis\.com\/.*/, (route) =>
      route.fulfill({ status: 403, contentType: "text/plain", body: "denegado" }),
    );

    await entrarComo(page, rol);
    const avatar = page.locator('button[aria-haspopup="menu"] img').first();
    await expect(avatar, "el onError debe reemplazar la URL muerta").toHaveAttribute(
      "src",
      /\/userPlaceholder\.png$/,
      { timeout: 20000 },
    );
  });

  test("BL-49 · el alta de usuarios ya NO manda la URL del bucket de QA", async ({ page }) => {
    const rol = ROLES[0];
    test.skip(!rol.email || !rol.pass, "Sin credenciales del Dueño");

    let cuerpo = null;
    await page.route(/\/users$/, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      cuerpo = JSON.parse(route.request().postData() || "{}");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: 200, descripcion: "ok", data: { id: "e2e-triv02-user" } }),
      });
    });

    await entrarComo(page, rol);
    await page.goto("/usuarios");
    await page.getByRole("button", { name: /agregar|nuevo usuario|añadir|\+/i }).first().click();
    await expect(page.getByText(/apellido paterno/i).first()).toBeVisible({ timeout: 15000 });

    const S = String(Date.now()).slice(-7);
    const textos = page.locator('input[type="text"], input:not([type])');
    await textos.nth(0).fill("Triv");
    await textos.nth(1).fill("Cero");
    await textos.nth(2).fill("Dos");
    await page.locator('input[type="email"]').first().fill(`rsv_gpa+triv02${S}@outlook.com`);
    await page.getByPlaceholder(/Mínimo 8 caracteres/i).fill("Roles_123!");
    await page.getByPlaceholder(/Repite la contraseña/i).fill("Roles_123!");
    await page.getByPlaceholder(/555-123-4567/).fill(`55${S}0`);
    await page.locator("select").first().selectOption({ label: "Asesor" });
    await page.getByRole("button", { name: /^crear usuario$/i }).click();

    await expect.poll(() => cuerpo, { timeout: 20000 }).not.toBeNull();
    expect(
      String(cuerpo.photoURL ?? ""),
      "el alta no debe sembrar una URL de Storage: el avatar se resuelve al pintar",
    ).not.toMatch(/firebasestorage/);
  });

  test("BL-49 · Configuración muestra el recuadro cuando el taller no tiene logo", async ({ page }) => {
    const rol = ROLES[0];
    test.skip(!rol.email || !rol.pass, "Sin credenciales del Dueño");

    // El taller se devuelve SIN logo (la cuenta de prueba sí tiene uno).
    await page.route(/\/workshops\/[^/?]+$/, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const res = await route.fetch();
      const json = await res.json().catch(() => null);
      if (!json?.data) return route.fulfill({ response: res });
      json.data.logo = "";
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
    });

    await entrarComo(page, rol);
    await page.goto("/configuracion");
    await expect(page.getByText(/aún no has subido el logotipo/i)).toBeVisible({ timeout: 20000 });
    await expect(page.getByAltText(/logotipo del taller pendiente/i)).toHaveAttribute(
      "src",
      /\/LogoTallerPlaceholder\.png$/,
    );
  });
});
