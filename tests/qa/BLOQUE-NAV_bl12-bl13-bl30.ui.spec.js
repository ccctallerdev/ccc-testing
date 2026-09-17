const { test, expect } = require("@playwright/test");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BLOQUE-NAV — BL-12 · BL-13 · BL-30 (rama fix/bloque-navegacion-roles-front) @ui
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Tres bugs con el mismo fondo: la app deja al usuario donde no quería sin
 * decirle por qué.
 *
 *   BL-13  el rebote de RoleBasedRoute es MUDO (te deposita en tu home sin
 *          aviso), y los botones Comercial/Cotización/Cliente/Seguimientos se
 *          le pintan al Mecánico aunque sus rutas exigen CAN_CREATE_QUOTE.
 *   BL-12  el Mecánico no tiene NINGÚN camino de menú al diagnóstico: su
 *          permiso existe (CAN_CREATE_DIAGNOSTIC) pero la única puerta vive en
 *          /registro, que no puede abrir.
 *   BL-30  el logo del taller no aparece hasta cerrar sesión: workshopData se
 *          carga al login y nadie lo refresca al guardar.
 *
 * Escritos EN ROJO antes del arreglo (regla del equipo): los cuatro casos
 * deben FALLAR contra dev-front sin el fix, y quedar en verde con él.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   ⚠️ REQUIERE BACKEND LOCAL: ccc-frontend/.env.local apunta las APIs a
 *   localhost:3001. Sin `npm run dev` en ccc-backend/functions, TODOS los
 *   roles "aparecen vencidos" (ERR_CONNECTION_REFUSED → perfil inutilizable)
 *   y este spec falla por la razón equivocada. Terminales:
 *     1) ccc-backend/functions → npm run dev      (localhost:3001)
 *     2) ccc-frontend          → npm start        (localhost:3000)
 *   $env:BASE_URL="http://localhost:3000"
 *   $env:SKIP_SEED="1"
 *   $env:MECHANIC_EMAIL="rsv_gpa+mecanico1@outlook.com"; $env:MECHANIC_PASSWORD="Mec_123!"
 *   $env:SEED_EMAIL="rsv_gpa@outlook.com"; $env:SEED_PASSWORD="admin123"
 *   # opcional para el caso 2 (botones con datos reales):
 *   $env:E2E_ENTRY_ID="<id de una entrada de refac CON diagnóstico>"
 *   npx playwright test --project=qa tests/qa/BLOQUE-NAV_bl12-bl13-bl30.ui.spec.js
 * ═══════════════════════════════════════════════════════════════════════════
 */

const MECANICO = {
  correo: process.env.MECHANIC_EMAIL || "",
  password: process.env.MECHANIC_PASSWORD || "",
};
const DUENO = {
  correo: process.env.SEED_EMAIL || "rsv_gpa@outlook.com",
  password: process.env.SEED_PASSWORD || "admin123",
};
const ENTRY_ID = process.env.E2E_ENTRY_ID || "";

async function entrarComo(page, { correo, password }) {
  await page.goto("/login");
  await page.locator("#email").fill(correo);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });
}

test.describe.configure({ mode: "serial" });

test.describe("BLOQUE-NAV — el usuario siempre sabe dónde está y por qué @ui", () => {
  test("1) BL-13 · el rebote por permisos AVISA, no es mudo", async ({ page }) => {
    test.skip(!MECANICO.correo || !MECANICO.password, "Falta MECHANIC_EMAIL / MECHANIC_PASSWORD");
    await entrarComo(page, MECANICO);

    // El LOGIN debe ser silencioso y aterrizar en SU home. Antes el redirect
    // interno mandaba a todos a /clientes y al Mecánico lo recibía el aviso de
    // "no tienes acceso" en su primer segundo (lo vio Enrique el 17-sep): un
    // aviso correcto disparado por una navegación que él nunca pidió.
    await expect(page).toHaveURL(/\/servicios/, { timeout: 15000 });
    await expect(page.getByText(/no tienes acceso/i)).toHaveCount(0);

    // El Mecánico no tiene CAN_VIEW_COST_VS_PRICE: /costeo lo rebota a su home.
    await page.goto("/costeo/una-os-cualquiera");

    // El home del Mecánico es /servicios (no ve dashboard).
    await expect(page).toHaveURL(/\/servicios/, { timeout: 15000 });
    // Y el rebote EXPLICA: sin este toast, "la app se descompuso" (BL-13).
    await expect(
      page.getByText(/no tienes acceso/i),
      "el rebote debe decir por qué; hoy es mudo y parece un bug",
    ).toBeVisible({ timeout: 10000 });
  });

  test("2) BL-13 · al Mecánico no se le pintan botones a rutas que lo rebotan", async ({ page }) => {
    test.skip(!MECANICO.correo || !MECANICO.password, "Falta MECHANIC_EMAIL / MECHANIC_PASSWORD");
    test.skip(
      !ENTRY_ID,
      "Falta E2E_ENTRY_ID (una entrada de refac CON diagnóstico). Sin datos reales este caso no puede afirmar nada honesto.",
    );
    await entrarComo(page, MECANICO);
    await page.goto(`/diagnostico-vista/${ENTRY_ID}`);
    await expect(page.getByRole("heading", { name: /diagn[oó]sticos/i })).toBeVisible({ timeout: 15000 });

    // Guardia de datos: si la OS no tiene diagnósticos, los botones no se
    // renderizan para NADIE y el caso pasaría de gratis. Exigimos la tarjeta.
    await expect(
      page.getByText(/sin diagn[oó]sticos registrados/i),
      "E2E_ENTRY_ID debe apuntar a una OS CON diagnóstico; con la lista vacía este caso no prueba nada",
    ).toHaveCount(0);

    // Sus rutas exigen CAN_CREATE_QUOTE, que el Mecánico no tiene: no deben verse.
    await expect(page.getByRole("button", { name: /comercial/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /cotizaci[oó]n/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^cliente$/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /seguimientos/i })).toHaveCount(0);
    // Lo que SÍ es suyo sigue ahí: diagnóstico (CAN_CREATE_DIAGNOSTIC).
    await expect(page.getByRole("button", { name: /nuevo diagn[oó]stico/i })).toBeVisible();
  });

  test("3) BL-12 · Producción le da al Mecánico su pestaña 'Por diagnosticar'", async ({ page }) => {
    test.skip(!MECANICO.correo || !MECANICO.password, "Falta MECHANIC_EMAIL / MECHANIC_PASSWORD");

    // El uid del mecánico se captura del propio perfil que carga la app: así
    // la entrada simulada queda asignada a ÉL sin conocer el uid de antemano.
    let uid = null;
    page.on("response", async (res) => {
      if (uid || !/\/users\//.test(res.url()) || res.request().method() !== "GET") return;
      try {
        const json = await res.json();
        const u = json?.data;
        if (u && (u.id || u.uid) && u.rol) uid = String(u.id || u.uid);
      } catch (_) { /* no era el perfil */ }
    });

    // El listado de entradas se simula: una OS asignada a él, EN ESPERA y SIN
    // aprobar — hoy Producción la descarta y el Mecánico no tiene forma de
    // llegar a diagnosticarla (BL-12).
    await page.route(/\/entries\?/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: 200,
          descripcion: "ok",
          data: {
            entries: [{
              id: "e2enav-bl12",
              sheet: "OS-777",
              carName: "Tsuru E2E",
              approvalState: "PENDIENTE",
              statusService: "EN ESPERA",
              assigned_mechanic: uid || "uid-desconocido",
              isDeleted: false,
              client: { name: "Cliente", firstSurname: "De Prueba" },
            }],
          },
        }),
      }),
    );

    await entrarComo(page, MECANICO);
    await page.goto("/produccion");

    // La pestaña nueva, con su conteo, y la OS listada con salida directa.
    const tab = page.getByRole("button", { name: /por diagnosticar/i });
    await expect(tab, "sin esta pestaña el Mecánico no tiene camino a su trabajo").toBeVisible({ timeout: 15000 });
    await tab.click();
    await expect(page.getByText(/OS-777/)).toBeVisible();
    await page.getByRole("button", { name: /diagn[oó]stico/i }).first().click();
    await expect(page).toHaveURL(/\/diagnostico-vista\/e2enav-bl12/);
  });

  test("5) BL-27 · con la suscripción vencida, el login DEPOSITA en /suscripcion", async ({ page }) => {
    // El agujero que explicó el "me lleva al Reto" de prod: user autenticado +
    // subscriptionExpired dejaba al usuario VARADO en /login sin mensaje. Se
    // simula el estado vencido interceptando /billing/status, así el caso
    // corre aunque el taller de QA tenga la suscripción sana.
    await page.route(/\/billing\/status\//, async (route) => {
      const res = await route.fetch();
      const json = await res.json().catch(() => null);
      if (!json?.data) return route.fulfill({ response: res });
      json.data.hasAccess = false;
      json.data.status = 3; // Expired
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(json),
      });
    });

    await page.goto("/login");
    await page.locator("#email").fill(DUENO.correo);
    await page.locator("#password").fill(DUENO.password);
    await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();

    // NO varado en /login, NO en la landing: en la página donde se paga.
    await expect(page, "la sesión vencida debe aterrizar donde se paga, no quedarse muda en /login").toHaveURL(
      /\/suscripcion/,
      { timeout: 30000 },
    );
  });

  test("4) BL-30 · el logo nuevo se ve SIN cerrar sesión", async ({ page }) => {
    // Storage se simula por protocolo (subida + metadata con token): el spec no
    // escribe en el bucket real y la URL final es determinista.
    const TOKEN = "e2e-logo-token";
    await page.route(/firebasestorage\.googleapis\.com\/v0\/b\/.*\/o(\?|\/)/, (route) => {
      const url = route.request().url();
      const name = decodeURIComponent((url.match(/[?&]name=([^&]+)/) || [])[1] || "logo/logo.png");
      const bucket = (url.match(/\/v0\/b\/([^/]+)\/o/) || [])[1] || "bucket";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          name,
          bucket,
          contentType: "image/png",
          downloadTokens: TOKEN,
        }),
      });
    });
    // Caja negra del caso: TODO lo que salga hacia workshops o storage queda
    // registrado, y el poll de abajo imprime el registro completo al fallar.
    const vistos = [];
    page.on("request", (r) => {
      if (/workshops|firebasestorage/.test(r.url())) {
        vistos.push(`${r.method()} ${r.url().slice(0, 140)}`);
      }
    });
    let updateBody = null;
    await page.route(/\/workshops\//, async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      updateBody = JSON.parse(route.request().postData() || "{}");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: 200, descripcion: "ok", data: { ok: true } }),
      });
    });

    await entrarComo(page, DUENO);
    await page.goto("/configuracion");

    // Un PNG mínimo de 1×1 como logo nuevo.
    // ⚠️ La sección "Cuenta" monta DOS inputs de archivo: la Foto de Perfil
    // del usuario va ANTES que el logo del taller. Un selector genérico le da
    // el archivo a la foto — y el taller guarda logo:null (nos pasó). Se ancla
    // al input que acompaña a la etiqueta "Logo del taller".
    await page.locator('div:has(> label:has-text("Logo del taller")) input[type="file"]').setInputFiles({
      name: "logo-e2e.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
    // Si el archivo entró al estado, el formulario pinta su vista previa.
    // Esta aserción intermedia separa "no se seleccionó" de "no se guardó".
    // (con dos puntos: el "Vista previa" sin ellos es el de la sección Apariencia)
    await expect(page.getByText(/vista previa:/i)).toBeVisible({ timeout: 5000 });

    // OJO: /configuracion tiene VARIOS "Guardar" (Modelo Operativo trae el
    // suyo). El del taller se llama exacto "Guardar taller" — un .first()
    // genérico le pega al de otra sección y el toast esperado nunca sale.
    await page.getByRole("button", { name: /guardar taller/i }).click();
    await expect(page.getByText(/taller actualizado/i)).toBeVisible({ timeout: 15000 });

    // El PUT llevó la URL nueva del logo… (al fallar, imprime el tráfico
    // registrado y el cuerpo completo del PUT: el diagnóstico viene gratis)
    await expect
      .poll(() => JSON.stringify({ put: updateBody, trafico: vistos }))
      .toContain(TOKEN);
    // …y el header la refleja SIN recargar ni volver a entrar. Hoy esto FALLA:
    // workshopData solo se carga en el login (BL-30).
    await expect(
      page.locator('img[alt="Logo del taller"]'),
      "el logo debe refrescarse en vivo; hoy solo aparece tras cerrar sesión",
    ).toHaveAttribute("src", new RegExp(TOKEN), { timeout: 10000 });
  });
});
