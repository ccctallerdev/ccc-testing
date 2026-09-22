const { test, expect } = require("@playwright/test");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BLOQUE-TRIV01 — BL-46 · BL-33 · OBS31-12 · OBS31-10 @ui
 * (rama fix/bloque-triviales-01-front) — escritos NUEVOS, en ROJO antes del fix
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   BL-46     La foto de perfil del USUARIO se guarda pero el header no cambia
 *             hasta recargar (nadie refresca userData del AuthContext). Además
 *             el toast decía "Taller actualizado" en el formulario del usuario.
 *             Y lo que destapó correrlo por roles: el formulario guardaba con
 *             PUT /users/:id, que exige CAN_MANAGE_USERS — Asesor, Compras,
 *             Mecánico y Recepción NO podían guardar ni su foto (403). Ahora
 *             ellos van por PUT /users/me (foto y nombres) y ven teléfono y
 *             país deshabilitados con "Solicita a tu administrador…".
 *   BL-33     Desde Entradas → Abastecimiento se abre SOLA la ventana "Pedido
 *             para Refacciones OS N". Roberto quiere la pantalla, no la
 *             ventana; la precarga debe esperar a "Nuevo pedido".
 *             De paso: Asesor/Recepción veían el botón aunque la ruta los
 *             rebota (regla de BL-13).
 *   OBS31-12  Clientes: la columna "Último servicio" leía `finishedDate`, que el
 *             auto no trae; el dato real es `lastServiceAt`.
 *   OBS31-10  Costeo no dice de qué OS es.
 *
 * Cada caso recorre los 6 roles: lo que el rol DEBE poder hacer y lo que NO
 * debe ver. Un rol sin credenciales se marca SKIP (nunca verde de gratis).
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   ⚠️ Front LOCAL con la rama (QA corre el código viejo: contra QA solo
 *   confirmarías el bug). Backend local o QA, según tu .env.local.
 *     1) ccc-backend/functions → npm run dev      (localhost:3001)
 *     2) ccc-frontend          → npm start        (localhost:3000)
 *   $env:BASE_URL="http://localhost:3000"; $env:SKIP_SEED="1"
 *   $env:ROL_DUENO_EMAIL="rsv_gpa@outlook.com";              $env:ROL_DUENO_PASS="admin123"
 *   $env:ROL_ADMINISTRADOR_EMAIL="rsv_gpa+admin1@outlook.com"; $env:ROL_ADMINISTRADOR_PASS="Prueba_123!"
 *   $env:ROL_ASESOR_EMAIL="rsv_gpa+asesor1@outlook.com"; $env:ROL_ASESOR_PASS="Prueba_123!"
 *   $env:ROL_COMPRAS_EMAIL="rsv_gpa+compras1@outlook.com"; $env:ROL_COMPRAS_PASS="Prueba_123!"
 *   $env:ROL_MECANICO_EMAIL="rsv_gpa+mecanico1@outlook.com"; $env:ROL_MECANICO_PASS="Prueba_123!"
 *   $env:ROL_RECEPCION_EMAIL="rsv_gpa+recepcion1@outlook.com"; $env:ROL_RECEPCION_PASS="Prueba_123!"
 *   # OBS31-10 necesita una OS REAL con diagnóstico (sin ella, ese caso = SKIP):
 *   $env:E2E_ENTRY_ID="<id de una entrada de refac CON diagnóstico>"
 *   npx playwright test --project=qa tests/qa/BLOQUE-TRIV01_bl46-bl33-obs31-12-obs31-10.ui.spec.js
 *
 * ── ROJO ESPERADO contra dev-front SIN el fix ─────────────────────────────
 *   BL-46     el avatar del header no trae el token nuevo (y el toast no dice
 *             "Usuario actualizado").
 *   BL-33     Dueño/Admin: hay un diálogo abierto al llegar. Asesor/Recepción:
 *             el botón Abastecimiento se les pinta.
 *   OBS31-12  la fila del auto con solo `lastServiceAt` muestra "—".
 *   OBS31-10  el encabezado no contiene "OS <número>".
 * ═══════════════════════════════════════════════════════════════════════════
 */

// Qué puede cada rol, según permissions.config.js (matriz C4):
//   entradas  = CAN_REGISTER_VEHICLE_ENTRY  (owner, admin, advisor)
//   pedir     = CAN_GENERATE_PURCHASE_ORDER (owner, admin, purchasing)
//   clientes  = CAN_VIEW_CLIENTS            (owner, admin, advisor)
//   costeo    = CAN_VIEW_COST_VS_PRICE      (owner, admin)
//   gestiona  = CAN_MANAGE_USERS            (owner, admin) → PUT /users/:id
// Asesor y Recepción comparten el rol de app `advisor`.
const ROLES = [
  { nombre: "Dueño",         clave: "DUENO",         entradas: true,  pedir: true,  clientes: true,  costeo: true,  gestiona: true,
    email: process.env.ROL_DUENO_EMAIL || process.env.SEED_EMAIL || "rsv_gpa@outlook.com",
    pass: process.env.ROL_DUENO_PASS || process.env.SEED_PASSWORD || "admin123" },
  { nombre: "Administrador", clave: "ADMINISTRADOR", entradas: true,  pedir: true,  clientes: true,  costeo: true,  gestiona: true },
  { nombre: "Asesor",        clave: "ASESOR",        entradas: true,  pedir: false, clientes: true,  costeo: false, gestiona: false },
  { nombre: "Compras",       clave: "COMPRAS",       entradas: false, pedir: true,  clientes: false, costeo: false, gestiona: false },
  { nombre: "Mecánico",      clave: "MECANICO",      entradas: false, pedir: false, clientes: false, costeo: false, gestiona: false },
  { nombre: "Recepción",     clave: "RECEPCION",     entradas: true,  pedir: false, clientes: true,  costeo: false, gestiona: false },
].map((r) => ({
  ...r,
  email: r.email || process.env[`ROL_${r.clave}_EMAIL`],
  pass: r.pass || process.env[`ROL_${r.clave}_PASS`],
}));

const ENTRY_ID = process.env.E2E_ENTRY_ID || "";

// PNG 1×1 como "foto nueva".
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function entrarComo(page, rol) {
  await page.goto("/login");
  await page.locator("#email").fill(rol.email);
  await page.locator("#password").fill(rol.pass);
  await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });
  await expect(page).not.toHaveURL(/\/suscripcion/, { timeout: 5000 });
}

/** El rebote de RoleBasedRoute: no se queda en la ruta y AVISA (BL-13). */
async function esperarRebote(page, ruta) {
  await expect(page, `debe rebotar de ${ruta}`).not.toHaveURL(new RegExp(ruta), { timeout: 15000 });
  await expect(page.getByText(/no tienes acceso/i)).toBeVisible({ timeout: 10000 });
}

// Casos independientes: uno en rojo NO debe tumbar a los demás (con
// "serial" un fallo dejaba 26 sin correr).
test.describe.configure({ mode: "default" });

// ─────────────────────────────────────────────────────────────────────────
// BL-46 — la foto de perfil se ve al instante, para TODOS los roles
// ─────────────────────────────────────────────────────────────────────────
test.describe("BL-46 — la foto de perfil nueva se ve sin recargar @ui", () => {
  for (const rol of ROLES) {
    test(`BL-46 — ${rol.nombre}`, async ({ page }) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);
      const TOKEN = `e2e-foto-${rol.clave.toLowerCase()}-${Date.now()}`;

      // Storage simulado por protocolo (subida + metadata con token): no se
      // escribe en el bucket real y la URL final es determinista.
      await page.route(/firebasestorage\.googleapis\.com\/v0\/b\/.*\/o(\?|\/)/, (route) => {
        const url = route.request().url();
        const name = decodeURIComponent((url.match(/[?&]name=([^&]+)/) || [])[1] || "x/imagenes/profilePic.png");
        const bucket = (url.match(/\/v0\/b\/([^/]+)\/o/) || [])[1] || "bucket";
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ name, bucket, contentType: "image/png", downloadTokens: TOKEN }),
        });
      });
      // El PUT del usuario se intercepta (la persistencia la cubre el spec de
      // API): aquí se prueba lo que el usuario VE después de guardar.
      let putBody = null;
      let putUrl = null;
      await page.route(/\/users\/[^/?]+$/, async (route) => {
        if (route.request().method() !== "PUT") return route.fallback();
        putUrl = route.request().url();
        putBody = JSON.parse(route.request().postData() || "{}");
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: 200, descripcion: "ok", data: { ok: true } }),
        });
      });

      await entrarComo(page, rol);
      await page.goto("/configuracion");

      // Teléfono y país: los edita solo quien gestiona usuarios.
      const aviso = page.getByText(/solicita a tu administrador para cambiar estos datos/i);
      if (rol.gestiona) {
        await expect(aviso).toHaveCount(0);
      } else {
        await expect(aviso, `${rol.nombre} debe saber por qué no puede cambiar su teléfono`).toBeVisible({ timeout: 15000 });
        await expect(page.locator('div:has(> label:has-text("País")) select')).toBeDisabled();
      }

      // Hay DOS inputs de archivo en "Cuenta" (foto del usuario y, para el
      // Dueño, logo del taller): se ancla al de "Foto de Perfil".
      await page
        .locator('div:has(> label:has-text("Foto de Perfil")) input[type="file"]')
        .setInputFiles({ name: "foto-e2e.png", mimeType: "image/png", buffer: PNG_1x1 });
      // Solo la vista previa de la FOTO: el Dueño también ve la del logo del
      // taller ("Preview logo") y un selector que acepte ambas choca en strict mode.
      await expect(page.getByAltText(/vista previa de la foto de perfil/i)).toBeVisible();

      await page.getByRole("button", { name: /guardar usuario/i }).click();
      await expect(page.getByText(/actualizado correctamente/i).first()).toBeVisible({ timeout: 15000 });

      // 1) El PUT llevó la URL nueva, y por la puerta que el rol SÍ puede
      //    abrir: /users/:id exige CAN_MANAGE_USERS (403 para los demás).
      await expect.poll(() => JSON.stringify(putBody)).toContain(TOKEN);
      if (rol.gestiona) {
        expect(putUrl, "Dueño/Admin guardan por /users/:uid").not.toMatch(/\/users\/me$/);
      } else {
        expect(putUrl, `${rol.nombre} no tiene CAN_MANAGE_USERS: debe guardar por /users/me`).toMatch(/\/users\/me$/);
        expect(Object.keys(putBody).sort(), "/me solo acepta foto y nombres").toEqual(
          expect.arrayContaining(["photoURL"]),
        );
        expect(putBody).not.toHaveProperty("phone");
        expect(putBody).not.toHaveProperty("rol");
      }

      // 2) El avatar del header la refleja SIN recargar. Hoy FALLA (BL-46).
      const avatar = page.locator('header button[aria-haspopup="menu"] img, button[aria-haspopup="menu"] img').first();
      await expect(avatar, "el avatar debe cambiar en vivo; hoy solo cambia al recargar").toHaveAttribute(
        "src",
        new RegExp(TOKEN),
        { timeout: 10000 },
      );

      // 3) El toast habla del usuario, no del taller.
      await expect(page.getByText(/usuario actualizado/i).first()).toBeVisible();
      await expect(page.getByText(/taller actualizado/i)).toHaveCount(0);
      await page.screenshot({ path: `test-results/BL-46_${rol.clave}.png` });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// BL-33 — Abastecimiento: la pantalla sí, la ventana sola no
// ─────────────────────────────────────────────────────────────────────────
const OS_33 = "9033";
const ENTRADA_33 = {
  id: "e2e-triv-bl33",
  sheet: OS_33,
  carName: "Tsuru E2E",
  approvalState: "APROBADA",
  approvedDate: Date.now(),
  registerDate: new Date().toISOString(),
  statusService: "EN ESPERA",
  needsProcurement: true,
  procurement: [{ description: "Balatas E2E", qty: "2", unitCost: "", inventoryId: "" }],
  isDeleted: false,
  status: 1,
  client: { name: "Cliente", firstSurname: "De Prueba" },
  car: { brand: "Nissan", model: "Tsuru", codeCar: "E2E-033" },
};

test.describe("BL-33 — desde Entradas se llega a Abastecimiento SIN ventana @ui", () => {
  // Las tarjetas (CardsSmall) con el botón Abastecimiento viven por debajo de
  // lg (1024 px); la tabla de escritorio no tiene ese botón.
  test.use({ viewport: { width: 900, height: 1000 } });

  for (const rol of ROLES) {
    test(`BL-33 — ${rol.nombre}`, async ({ page }) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);

      // El listado de Entradas se simula: una OS APROBADA con refacciones
      // fuera de stock (lo que enciende el botón).
      await page.route(/\/entries\?/, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: 200,
            descripcion: "ok",
            data: { entries: [ENTRADA_33], totalDocs: 1, totalPages: 1 },
          }),
        }),
      );

      await entrarComo(page, rol);

      if (!rol.entradas) {
        // Compras y Mecánico no entran a Entradas.
        await page.goto("/registro");
        await esperarRebote(page, "/registro");

        await page.goto("/abastecimiento");
        if (rol.pedir) {
          // Compras llega por su menú: pantalla limpia, sin precarga.
          await expect(page).toHaveURL(/\/abastecimiento/);
          await expect(page.getByRole("heading", { name: /centro de abastecimiento/i })).toBeVisible({ timeout: 15000 });
          await expect(page.getByRole("dialog")).toHaveCount(0);
          await expect(page.getByRole("button", { name: /nueva orden de compra/i })).toBeVisible();
        } else {
          await esperarRebote(page, "/abastecimiento");
        }
        return;
      }

      await page.goto("/registro");
      await page.getByRole("button", { name: /^aprobados/i }).first().click();
      await expect(page.getByText(new RegExp(OS_33)).first()).toBeVisible({ timeout: 15000 });
      const boton = page.getByRole("button", { name: /generar pedido de abastecimiento/i });

      if (!rol.pedir) {
        // Asesor / Recepción: la ruta los rebota, así que el botón no se pinta.
        await expect(boton, `${rol.nombre} no debe ver un botón que lo rebota`).toHaveCount(0);
        return;
      }

      await boton.first().click();
      await expect(page).toHaveURL(/\/abastecimiento/);
      await expect(page.getByRole("heading", { name: /centro de abastecimiento/i })).toBeVisible({ timeout: 15000 });

      // EL BUG: aquí se abría sola la ventana "Pedido para Refacciones OS N".
      await expect(page.getByRole("dialog"), "no debe abrirse ninguna ventana al llegar").toHaveCount(0);
      await page.screenshot({ path: `test-results/BL-33_${rol.clave}_llegada.png` });

      // La precarga NO se pierde: el botón la ofrece con la OS a la vista.
      const nuevo = page.getByRole("button", { name: new RegExp(`nuevo pedido para OS ${OS_33}`, "i") });
      await expect(nuevo).toBeVisible();
      await nuevo.click();
      const dialogo = page.getByRole("dialog");
      await expect(dialogo).toBeVisible();
      await expect(dialogo).toContainText(new RegExp(`Refacciones OS ${OS_33}`, "i"));
      const valores = await dialogo.locator("input, textarea").evaluateAll((els) => els.map((e) => e.value));
      expect(valores.join(" | "), "las partidas de la OS deben venir precargadas").toContain("Balatas E2E");
      await page.screenshot({ path: `test-results/BL-33_${rol.clave}_pedido.png` });

      // Cancelar no tira la precarga: se puede volver a abrir.
      // (Se cierra con el botón Cancelar, como el guion manual. No se cuenta
      // role=dialog: antd deja el contenedor del modal en el DOM tras cerrar.)
      const pedido = page.getByRole("dialog").filter({ hasText: new RegExp(`Refacciones OS ${OS_33}`, "i") });
      await pedido.getByRole("button", { name: /^cancelar$/i }).click();
      await expect(pedido, "la ventana debe cerrarse con Cancelar").toBeHidden();
      await expect(nuevo, "tras cancelar, el botón sigue ofreciendo la OS").toBeVisible();
      await nuevo.click();
      await expect(pedido).toBeVisible();
      const otraVez = await pedido.locator("input, textarea").evaluateAll((els) => els.map((e) => e.value));
      expect(otraVez.join(" | "), "cancelar no debe borrar la precarga").toContain("Balatas E2E");
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// OBS31-12 — Clientes: la fecha del último servicio en su columna
// ─────────────────────────────────────────────────────────────────────────
// 15-mar-2026 al mediodía (hora de CDMX) → "15 mar 2026" en español.
const LAST_SERVICE = Date.UTC(2026, 2, 15, 18, 0, 0);
const CLIENTE_12 = {
  id: "e2e-triv-obs3112",
  name: "Cliente",
  firstSurname: "Obs Tres Doce",
  phone: "5512300012",
  email: "obs3112@test.com",
  cars: [
    // El caso de Roberto: el auto trae lastServiceAt (lo sella el back al ENTREGAR).
    { id: "car-a", brand: "Nissan", model: "Versa", color: "Rojo", codeCar: "TRIV-12A", fuel: "Gasolina", transmition: "Manual", lastServiceAt: LAST_SERVICE },
    // Auto sin servicios → guion.
    { id: "car-b", brand: "Kia", model: "Rio", color: "Gris", codeCar: "TRIV-12B", fuel: "Gasolina", transmition: "Automática" },
    // Auto legado: solo finishedDate → también se ve.
    { id: "car-c", brand: "VW", model: "Jetta", color: "Blanco", codeCar: "TRIV-12C", fuel: "Gasolina", transmition: "Manual", finishedDate: Date.UTC(2025, 10, 2, 18, 0, 0) },
  ],
};

test.describe("OBS31-12 — Clientes muestra la fecha del último servicio @ui", () => {
  for (const rol of ROLES) {
    test(`OBS31-12 — ${rol.nombre}`, async ({ page }) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);

      await page.route(/\/clients\?/, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: 200, descripcion: "ok", data: { clients: [CLIENTE_12], total: 1, page: 1 } }),
        }),
      );

      await entrarComo(page, rol);
      await page.goto("/clientes");

      if (!rol.clientes) {
        await esperarRebote(page, "/clientes");
        return;
      }

      const fila = (placas) => page.locator("tr", { hasText: placas });
      await expect(fila("TRIV-12A")).toBeVisible({ timeout: 15000 });
      // EL BUG: aquí salía "—" aunque el botón ya se pintaba de azul.
      await expect(fila("TRIV-12A"), "la fecha real del último servicio").toContainText(/15 mar\.? 2026/i);
      await expect(fila("TRIV-12B")).toContainText("—");
      await expect(fila("TRIV-12C"), "los autos legados con finishedDate siguen mostrándola").toContainText(/0?2 nov\.? 2025/i);
      await page.screenshot({ path: `test-results/OBS31-12_${rol.clave}.png` });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// OBS31-10 — Costeo dice de qué OS es
// ─────────────────────────────────────────────────────────────────────────
test.describe("OBS31-10 — el Costeo muestra el número de OS @ui", () => {
  for (const rol of ROLES) {
    test(`OBS31-10 — ${rol.nombre}`, async ({ page }) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);
      test.skip(
        rol.costeo && !ENTRY_ID,
        "Falta E2E_ENTRY_ID (OS real CON diagnóstico). Sin datos reales este caso no puede afirmar nada honesto.",
      );

      // El número de OS se toma de la MISMA respuesta que usa la pantalla,
      // así el spec no depende de conocerlo de antemano.
      let sheet = null;
      page.on("response", async (res) => {
        if (sheet || res.request().method() !== "GET") return;
        if (!new RegExp(`/entries/${ENTRY_ID}(\\?|$)`).test(res.url())) return;
        try {
          const json = await res.json();
          const e = json?.data?.entry ?? json?.data;
          if (e?.sheet != null && String(e.sheet).trim() !== "") sheet = String(e.sheet);
        } catch (_) { /* no era la entrada */ }
      });

      await entrarComo(page, rol);
      await page.goto(`/costeo/${ENTRY_ID || "una-os-cualquiera"}`);

      if (!rol.costeo) {
        await esperarRebote(page, "/costeo");
        return;
      }

      const h1 = page.getByRole("heading", { level: 1, name: /costeo/i });
      await expect(h1).toBeVisible({ timeout: 20000 });
      await expect.poll(() => sheet, { message: "E2E_ENTRY_ID debe ser una OS con número (sheet)" }).not.toBeNull();
      // EL BUG: el encabezado decía solo "Costeo".
      await expect(h1, "el encabezado debe decir de qué OS es").toContainText(new RegExp(`OS\\s*${sheet}`));
      await page.screenshot({ path: `test-results/OBS31-10_${rol.clave}.png` });
    });
  }
});
