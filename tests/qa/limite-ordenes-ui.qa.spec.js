const { test, expect, request: pwRequest } = require("@playwright/test");
// adminFlex decide solo: API en localhost → EMULADORES; otra cosa → refac.
const { db: qaDb, auth: qaAuth, modo } = require("../../adminFlex");
const { headersFor } = require("../../qaAuth");

/**
 * ─────────────────────────────────────────────────────────────────────────
 * LÍMITE DE ÓRDENES POR MES — PANTALLAS (D18) @ui
 *
 * La contraparte de UI de `limite-ordenes.qa.spec.js` (regla del 26-ago:
 * API amplia + UI angosta). Camino feliz de las pantallas nuevas:
 *
 *   1. El Dueño, con su taller al límite, ve el banner rojo, abre el modal,
 *      acepta el apoyo del 10 % y el banner pasa a ámbar (consumo/tope).
 *   2. Con el taller topado, el alta de OS por UI (cliente y vehículo nuevo)
 *      termina en el modal del límite — NO en la pantalla de "Finalizar".
 *
 * Precondición por Admin SDK (infraestructura, no flujo del producto): la
 * bandera global se enciende vía API con un TECH_SUPPORT efímero y el taller
 * se pone "al límite" con `limit_override` = consumo actual (mismo mecanismo
 * de las cuentas internas — D19). Nada del FLUJO se siembra por API.
 *
 * CÓMO CORRE — emuladores o refac (adminFlex decide: API local ⇒ emuladores).
 *   EMULADORES: emuladores + backend (ORDER_LIMITS_CONFIG_TTL_MS=0) + frontend.
 *     npx playwright test --project=qa tests/qa/limite-ordenes-ui.qa.spec.js
 *   REFAC: $env:AUTH_REAL="1" (si la API es local); ID_WORKSHOP, SEED_EMAIL y
 *   SEED_PASSWORD del taller real, BASE_URL del frontend a probar.
 * ─────────────────────────────────────────────────────────────────────────
 */

const API = process.env.API || "http://localhost:3001/v1";
// En emuladores el taller sembrado por global-setup es `taller-prueba`; contra
// refac hay que decir contra qué taller real se corre.
const ID_WORKSHOP = process.env.ID_WORKSHOP || (modo === "emulador" ? "taller-prueba" : null);
if (!ID_WORKSHOP) {
  throw new Error('Falta ID_WORKSHOP (taller real de refac). Ej: $env:ID_WORKSHOP="05Pf..."');
}
const DUENO = {
  correo: process.env.SEED_EMAIL || "prueba@ccc.test",
  password: process.env.SEED_PASSWORD || "prueba123",
};

const S = String(Date.now()).slice(-6);
const TECH_EMAIL = `tech.limitesui.${S}@ccc.test`;
const TECH_PASSWORD = "Prueba1234!";
const CLIENTE = { nombre: "Laura Límite Prueba", telefono: `55${S}77`.slice(0, 10), correo: `limite.ui.${S}@ccc.test` };
const AUTO = {
  marca: "Nissan", modelo: "Versa", anio: "2022", color: "Blanco",
  placas: `LIM${S}`.slice(0, 8), vin: `3N1CN7AD5PL${S}9`.slice(0, 17),
  transmision: "Automática", km: "42000", combustible: "Gasolina",
  falla: "Prueba del límite de órdenes por mes.",
};
// El asistente EXIGE asignar mecánico (validación nativa del formulario). En
// emuladores existe el que siembra seed_emulator_user.js; contra refac se
// pasa el nombre real con MECANICO_NOMBRE.
const MECANICO = process.env.MECANICO_NOMBRE || "Mecánico Prueba";

const literal = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const creados = { uids: [] };
let settingsPrevios = null;
let techHeaders = null;

async function apiTech(request, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: techHeaders,
    ...(body ? { data: body } : {}),
  });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

/** Pone el taller EXACTAMENTE en su límite del mes (sin tolerancia previa). */
async function tallerAlLimite() {
  const [inicio, fin] = (() => {
    const TZ = 6 * 60 * 60 * 1000;
    const local = new Date(Date.now() - TZ);
    const y = local.getUTCFullYear(), m = local.getUTCMonth();
    return [Date.UTC(y, m, 1) + TZ, Date.UTC(y, m + 1, 1) + TZ];
  })();
  const snap = await qaDb().collection("entries")
    .where("idWorkshop", "==", ID_WORKSHOP)
    .where("isDeleted", "==", false)
    .where("createdAt", ">=", inicio)
    .where("createdAt", "<", fin)
    .count().get();
  const used = snap.data().count;
  await qaDb().collection("order_usage").doc(ID_WORKSHOP).set({
    idWorkshop: ID_WORKSHOP,
    limit_override: Math.max(1, used), // >=1 para que el 10% ofrezca al menos 1 OS
  }, { merge: false });
  return used;
}

async function iniciarSesion(page, correo, password) {
  await page.goto("/login");
  await page.locator("#email").fill(correo);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 30000 });
}

/** Combobox "escribe y ELIGE": teclear no basta, hay que clicar la opción. */
async function elegirDeLista(page, placeholderRe, valor) {
  const input = page.getByPlaceholder(placeholderRe);
  await input.fill(valor);
  const opcion = page.getByRole("button", { name: new RegExp(`^${literal(valor)}$`) }).first();
  await opcion.waitFor({ timeout: 10000 });
  await opcion.click();
}

/**
 * Mecánico = CreatableSelect. NUNCA Enter: si el texto no casa, INVENTA la
 * opción y la entrada queda con un assigned_mechanic que no es de nadie.
 * Clic en la opción real, anclada al inicio (la de crear dice `Create "..."`).
 */
async function elegirMecanico(page, nombre) {
  const input = page.locator('input[id^="react-select"][id$="-input"]').first();
  await input.click({ force: true });
  await input.pressSequentially(nombre);
  const opcion = page
    .locator('[id*="-option-"]')
    .filter({ hasText: new RegExp(`^${literal(nombre)}`) })
    .first();
  await expect(opcion, `«${nombre}» no aparece en la lista de mecánicos`).toBeVisible({ timeout: 10000 });
  await opcion.click();
}

test.describe.configure({ mode: "serial" });

test.describe("Límite de órdenes por mes — pantallas @ui", () => {
  test.beforeAll(async () => {
    const user = await qaAuth().createUser({ email: TECH_EMAIL, password: TECH_PASSWORD });
    await qaAuth().setCustomUserClaims(user.uid, { role: "TECH_SUPPORT" });
    creados.uids.push(user.uid);
    techHeaders = await headersFor(TECH_EMAIL, TECH_PASSWORD);

    // `request` no es fixture de beforeAll: contexto propio.
    const ctx = await pwRequest.newContext();
    settingsPrevios = (await apiTech(ctx, "get", "/order-limits/settings")).body?.data || null;
    const on = await apiTech(ctx, "put", "/order-limits/settings", { enforcement: "on" });
    await ctx.dispose();
    if (on.status !== 200) throw new Error(`No pude encender la bandera: ${on.status}`);
  });

  test.afterAll(async () => {
    const ctx = await pwRequest.newContext();
    if (settingsPrevios) {
      await apiTech(ctx, "put", "/order-limits/settings", {
        enforcement: settingsPrevios.enforcement,
      }).catch(() => {});
    }
    await ctx.dispose();
    await qaDb().collection("order_usage").doc(ID_WORKSHOP).delete().catch(() => {});

    // Rastro del alta bloqueada: cliente (y su cuenta oculta) y auto.
    const porEmail = await qaDb().collection("clients").where("email", "==", CLIENTE.correo).get();
    for (const d of porEmail.docs) await d.ref.delete().catch(() => {});
    const autos = await qaDb().collection("cars").where("codeCar", "==", AUTO.placas).get();
    for (const d of autos.docs) {
      const os = await qaDb().collection("entries").where("carId", "==", d.id).get();
      for (const e of os.docs) await e.ref.delete().catch(() => {});
      await d.ref.delete().catch(() => {});
    }
    const cuentas = await qaDb().collection("users").where("email", "==", CLIENTE.correo).get();
    for (const d of cuentas.docs) await d.ref.delete().catch(() => {});
    await qaAuth().getUserByEmail(CLIENTE.correo)
      .then((u) => qaAuth().deleteUser(u.uid))
      .catch(() => {});
    for (const uid of creados.uids) await qaAuth().deleteUser(uid).catch(() => {});
  });

  test("el Dueño ve el banner al límite, acepta el apoyo y el banner pasa a ámbar", async ({ page }) => {
    await tallerAlLimite();
    await iniciarSesion(page, DUENO.correo, DUENO.password);

    const banner = page.getByTestId("banner-limite-ordenes");
    await expect(banner, "el banner del límite debe aparecer en el layout").toBeVisible({ timeout: 20000 });
    await expect(banner).toContainText(/Llegaste al límite/i);

    await banner.getByRole("button", { name: /ver opciones/i }).click();
    await expect(page.getByText(/Llegaste a tu límite de órdenes de este mes/i)).toBeVisible({ timeout: 10000 });
    // El mensaje de Roberto: el apoyo se descuenta del próximo mes.
    await expect(page.getByText(/se descontará de tu plan del próximo mes/i)).toBeVisible();

    await page.getByTestId("btn-aceptar-apoyo").click();

    // Mejor aserción que un toast (trampa conocida): el BANNER cambia de
    // estado — ya no dice "Llegaste al límite", dice el consumo contra el
    // tope ampliado y que el apoyo del mes ya quedó aplicado.
    await expect(banner).not.toContainText(/Llegaste al límite/i, { timeout: 15000 });
    await expect(banner).toContainText(/Llevas \d+ de \d+ órdenes/i);
    await expect(banner).toContainText(/Apoyo del mes ya aplicado/i);
  });

  test("el alta de OS con el taller topado termina en el modal del límite, no en Finalizar", async ({ page }) => {
    // Caja negra → caja de cristal: si el modal no aparece, estas respuestas
    // dicen exactamente qué llamada falló (patrón del paso 8 del e2e_v2 —
    // varios hooks tragan errores y un 500 se ve como "no pasó nada").
    const red = [];
    page.on("response", async (res) => {
      if (res.request().method() === "GET") return;
      if (!/\/(entries|clients|cars|tokens|order-limits)/.test(res.url())) return;
      let cuerpo = "";
      try { cuerpo = (await res.text()).slice(0, 400); } catch {}
      red.push(`${res.request().method()} ${new URL(res.url()).pathname} → ${res.status()} ${cuerpo}`);
    });
    page.on("pageerror", (e) => red.push(`PAGEERROR: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") red.push(`CONSOLE: ${m.text().slice(0, 300)}`); });

    await tallerAlLimite(); // borra la tolerancia aceptada arriba: topado otra vez
    await iniciarSesion(page, DUENO.correo, DUENO.password);

    await page.goto("/registro");
    await page.getByRole("button", { name: /nueva entrada/i }).click();
    await page.getByRole("button", { name: /cliente y veh[ií]culo nuevo/i }).click();
    await expect(page).toHaveURL(/crear-cliente-vehiculo/, { timeout: 20000 });

    // Paso 1 — cliente
    await page.locator("#name").fill(CLIENTE.nombre);
    await page.locator("#phone").fill(CLIENTE.telefono);
    await page.locator("#email").fill(CLIENTE.correo);
    await page.getByRole("button", { name: /^siguiente$/i }).click();
    const confirmar = page.getByRole("button", { name: /afiliar|s[ií], continuar|confirmar/i }).first();
    if (await confirmar.isVisible({ timeout: 4000 }).catch(() => false)) await confirmar.click();

    // Paso 2 — vehículo (sin mecánico: es opcional y aquí no hay equipo)
    await expect(page.locator("#codeCar")).toBeVisible({ timeout: 20000 });
    await elegirDeLista(page, /escribe o selecciona una marca/i, AUTO.marca);
    await elegirDeLista(page, /el modelo|modelo \(libre\)|primero elige/i, AUTO.modelo);
    await page.locator("#year").fill(AUTO.anio);
    await elegirDeLista(page, /escribe o selecciona un color/i, AUTO.color);
    await page.locator("#codeCar").fill(AUTO.placas);
    await page.locator("#vin").fill(AUTO.vin);
    await page.locator("#transmition").selectOption(AUTO.transmision);
    await page.locator("#car-km").fill(AUTO.km);
    await page.locator("#car-fuel").selectOption(AUTO.combustible);
    await elegirMecanico(page, MECANICO); // obligatorio: sin él, "Siguiente" no avanza
    await page.locator("#car-issue-desc").fill(AUTO.falla);
    await page.getByRole("button", { name: /^siguiente$/i }).click();

    // Paso 3 — hoja de servicio y el intento de registrar
    await expect(page.locator("#selectAll")).toBeVisible({ timeout: 20000 });
    await page.locator("#selectAll").check();
    const tanque = page.locator('[data-entry-sheet-field="fuel_tank"]');
    if (await tanque.count()) await tanque.getByText("1/2", { exact: true }).click();
    else await page.getByRole("button", { name: "1/2" }).first().click();
    // Igual que el e2e_v2: expandir "Diagnóstico/Fallas Reportadas" y marcar
    // al menos una falla — el handler valida esto ANTES de llamar a la red y
    // sin ello el clic muere en silencio (toast que no dice "error").
    await page.getByRole("button", { name: /diagn[oó]stico\/fallas reportadas/i }).click();
    await page
      .locator("label", { has: page.locator('input[type="checkbox"]') })
      .first()
      .click();
    // "Estado general del vehículo" es obligatorio (validación nativa).
    await page
      .getByPlaceholder(/describa los aspectos generales/i)
      .fill("Vehículo de prueba del límite de órdenes; sin daños visibles.");

    await page.getByRole("button", { name: /registrar y continuar/i }).click();

    // El backend responde ORDER_LIMIT_REACHED y la pantalla correcta es el
    // MODAL del límite. La trampa conocida ("toasts que no dicen error") se
    // evita asertando la navegación: NO debe aparecer "Finalizar".
    try {
      await expect(
        page.getByText(/Llegaste a tu límite de órdenes de este mes/i),
        "el 403 del tope debe abrir el modal del límite",
      ).toBeVisible({ timeout: 20000 });
    } catch (err) {
      throw new Error(
        `${err.message}\n\n── Tráfico del alta (POST/PUT) y errores de consola ──\n${red.join("\n") || "(vacío: ninguna llamada de escritura salió)"}`,
      );
    }
    await expect(page.getByRole("button", { name: /^finalizar$/i })).toHaveCount(0);

    // Y de verdad NO se registró nada: ninguna OS para ese auto.
    const autos = await qaDb().collection("cars").where("codeCar", "==", AUTO.placas).get();
    for (const d of autos.docs) {
      const os = await qaDb().collection("entries").where("carId", "==", d.id).get();
      expect(os.size, "no debe existir ninguna OS del auto del alta bloqueada").toBe(0);
    }
  });
});
