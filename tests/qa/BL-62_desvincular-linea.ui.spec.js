const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-62 — Editar cotización: borrar cualquier fila, vaciar la única y quitar
 * el vínculo con el inventario, por los 6 roles @ui
 * (ramas fix/bl62-desvincular-linea-cotizacion-front + -api) — escrito NUEVO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Enrique, 29-sep-2026 (prueba manual de OBS21-01): "el primer elemento no se
 * puede borrar ni modificar cuando se vincula un nuevo artículo […] si solo
 * queda una, que el botón de borrar no borre la fila pero sí el contenido y el
 * vínculo; si ya no hay vínculo, que muestre el espacio de buscar en inventario".
 *
 * Acceso: /cotizacion-editar/:id exige CAN_CREATE_QUOTE → Dueño, Administrador,
 * Asesor y Recepción entran (desde Cotizaciones → Ver detalle → Editar
 * cotización); Compras y Mecánico rebotan.
 *
 * Datos: por cada rol que entra se crea por API (cuenta del Dueño) una OS con
 * una cotización de UNA partida vinculada a un artículo de inventario real.
 * Al final se verifica por API que la partida guardada quedó SIN inventoryId.
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
 *   npx playwright test --project=qa tests/qa/BL-62_desvincular-linea.ui.spec.js
 *
 * ── ROJO ESPERADO sin el fix ──────────────────────────────────────────────
 *   La única fila no tiene botón "Eliminar" y no existe "Quitar vínculo".
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP;
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";
const HORA = 3600 * 1000;

const ROLES = [
  { nombre: "Dueño", clave: "DUENO", entra: true,
    email: process.env.ROL_DUENO_EMAIL || process.env.SEED_EMAIL || "rsv_gpa@outlook.com",
    pass: process.env.ROL_DUENO_PASS || process.env.SEED_PASSWORD },
  { nombre: "Administrador", clave: "ADMINISTRADOR", entra: true },
  { nombre: "Asesor", clave: "ASESOR", entra: true },
  { nombre: "Compras", clave: "COMPRAS", entra: false },
  { nombre: "Mecánico", clave: "MECANICO", entra: false },
  { nombre: "Recepción", clave: "RECEPCION", entra: true },
].map((r) => ({
  ...r,
  email: r.email || process.env[`ROL_${r.clave}_EMAIL`],
  pass: r.pass || process.env[`ROL_${r.clave}_PASS`],
}));

const S0 = String(Date.now()).slice(-7);
const datosPorRol = {}; // clave → { entryId, quoteId, articulo }

async function call(request, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: await authHeaders(),
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json, data: json?.data ?? json };
}
const idOf = (d) => d?.id ?? d?.entryId ?? d;
const ok = (r, msg) => expect(r.status, `${msg}: ${JSON.stringify(r.body)}`).toBeLessThan(300);

async function sembrar(request, rol, i) {
  const S = String(Number(S0) + i).padStart(7, "0").slice(-7);
  const articulo = { name: `Filtro UI BL-62 ${rol.clave} ${S}` };
  const art = await call(request, "post", "/inventory", {
    idWorkshop: ID_WORKSHOP, name: articulo.name, sku: `BL62UI-${S}`, cost: 180, price: 243, stock: 10,
  });
  ok(art, "artículo"); articulo.id = idOf(art.data);
  const cliente = await call(request, "post", "/clients", {
    fullName: `Cliente bl62 ui ${S}`, email: `bl62ui.${S}@test.com`,
    phone: `55${S}6`, idWorkshop: ID_WORKSHOP, createdBy: MECHANIC_ID,
  });
  ok(cliente, "cliente");
  const auto = await call(request, "post", "/cars", {
    clientId: idOf(cliente.data), brand: "Kia", model: "Rio", year: 2019,
    vin: `B62UI${S}00000000`.slice(0, 17), codeCar: `B6U-${S.slice(-4)}`,
    color: "Azul", fuel: "Gasolina", transmition: "Manual", km: 50000,
  });
  ok(auto, "auto");
  const os = await call(request, "post", "/entries", {
    idWorkshop: ID_WORKSHOP, clientId: idOf(cliente.data), carId: idOf(auto.data),
    assigned_mechanic: MECHANIC_ID, status: 1, observations: "spec BL-62 UI",
    registerDate: Date.now(), approvalState: "EN ESPERA",
  });
  ok(os, "OS");
  const entryId = idOf(os.data);
  ok(await call(request, "post", `/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos"], checks: ["Servicio de Frenos"], isCheckAll: false,
    observations: "spec BL-62 UI", km: 50000, fuel_tank: "1/2",
  }), "hoja");
  const cot = await call(request, "post", `/entries/${entryId}/quotes`, {
    diagnostic: "Servicio BL-62", promiseDate: Date.now() + 72 * HORA,
    labor: [{ description: "Mano de obra", count: 1, unitPrice: 300, cost: 300, subtotal: 300, state: true }],
    parts: [{ description: articulo.name, count: 1, unitPrice: 243, cost: 243, subtotal: 243, state: true, inventoryId: articulo.id }],
    status: 2, clientBringsParts: false, stage: "COTIZACION",
  });
  ok(cot, "cotización");
  return { entryId, quoteId: idOf(cot.data), articulo };
}

async function entrarComo(page, rol) {
  await page.goto("/login");
  await page.locator("#email").fill(rol.email);
  await page.locator("#password").fill(rol.pass);
  await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });
  await expect(page).not.toHaveURL(/\/suscripcion/, { timeout: 5000 });
}

test.describe.configure({ mode: "default" });

test.describe("BL-62 — borrar / vaciar / desvincular partidas de la cotización, por roles @ui", () => {
  test.beforeAll(async ({ request }) => {
    test.setTimeout(90000);
    if (!ID_WORKSHOP) throw new Error("Falta ID_WORKSHOP (taller de refac).");
    let i = 0;
    for (const rol of ROLES.filter((r) => r.entra)) {
      datosPorRol[rol.clave] = await sembrar(request, rol, i++);
    }
  });

  for (const rol of ROLES) {
    test(`BL-62 — ${rol.nombre}`, async ({ page, request }, testInfo) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);
      await entrarComo(page, rol);
      const d = datosPorRol[rol.clave] || datosPorRol.DUENO;
      // Con ?quoteId (como el botón "Editar cotización"): sin él, la pantalla pide elegir una.
      await page.goto(`/cotizacion-editar/${d.entryId}?quoteId=${d.quoteId}`);

      if (!rol.entra) {
        await expect(page, `${rol.nombre} debe rebotar de Editar cotización`).not.toHaveURL(/\/cotizacion-editar/, { timeout: 15000 });
        return;
      }

      // .last() = el div.mb-6 más interno (los ancestros también "contienen" el encabezado)
      const seccion = page.locator("div.mb-6").filter({ has: page.getByRole("heading", { name: /refacciones y materiales/i }) }).last();
      const descripciones = seccion.getByPlaceholder("Ej. Filtro de aceite OEM");
      // antd AutoComplete: el placeholder es un <span>, no un atributo; el campo es un combobox
      const buscador = seccion.getByRole("combobox");
      await expect(descripciones.first(), "la partida vinculada cargó").toHaveValue(d.articulo.name, { timeout: 20000 });
      await expect(descripciones).toHaveCount(1);

      // 1) La única fila (la primera) SÍ tiene botón Eliminar y hay "Quitar vínculo"
      await expect(seccion.getByText(/vinculada al inventario/i), "la línea se ve vinculada").toBeVisible();
      await expect(seccion.getByTitle("Eliminar"), "la primera fila también tiene Eliminar").toHaveCount(1);
      await seccion.screenshot({ path: testInfo.outputPath(`1-vinculada-${rol.clave}.png`) });

      // 2) Quitar vínculo: la línea se queda como texto libre y regresa el buscador
      await seccion.getByRole("button", { name: /quitar vínculo/i }).click();
      await expect(seccion.getByText(/vinculada al inventario/i)).toHaveCount(0);
      await expect(buscador, "vuelve el buscador").toBeVisible();
      await expect(descripciones.first(), "la descripción se conserva").toHaveValue(d.articulo.name);
      await seccion.screenshot({ path: testInfo.outputPath(`2-desvinculada-${rol.clave}.png`) });

      // 3) Eliminar con una sola fila: NO desaparece, se vacía
      await seccion.getByTitle("Eliminar").click();
      await expect(descripciones, "sigue habiendo una fila").toHaveCount(1);
      await expect(descripciones.first(), "vacía").toHaveValue("");
      await expect(buscador).toBeVisible();

      // 4) Con dos filas, Eliminar la PRIMERA deja la segunda
      await seccion.getByTitle("Agregar").first().click();
      await expect(descripciones).toHaveCount(2);
      await descripciones.nth(0).fill("Primera (se borra)");
      await descripciones.nth(1).fill(`Pieza libre ${rol.clave}`);
      await seccion.getByTitle("Eliminar").nth(0).click();
      await expect(descripciones).toHaveCount(1);
      await expect(descripciones.first()).toHaveValue(`Pieza libre ${rol.clave}`);

      // 5) Guardar y verificar por API: sin inventoryId
      // Ya solo queda una fila (sin buscador: tiene descripción y nunca se vinculó),
      // así que los inputs editables de la sección son: descripción, cantidad y precio (si el rol lo ve).
      const inputs = seccion.locator("input:not([readonly]):not([type=checkbox]):not([role=combobox])");
      await inputs.nth(1).fill("1"); // cantidad
      if ((await inputs.count()) > 2) await inputs.nth(2).fill("150"); // precio (si el rol lo ve)
      await seccion.screenshot({ path: testInfo.outputPath(`3-libre-${rol.clave}.png`) });
      await page.getByRole("button", { name: /^guardar$/i }).click();
      await expect(page, "regresa a la vista de cotizaciones").toHaveURL(/\/cotizacion-vista\//, { timeout: 20000 });

      const q = (await call(request, "get", `/entries/${d.entryId}/quotes/${d.quoteId}`)).data;
      expect(q.parts, "queda una sola partida").toHaveLength(1);
      expect(q.parts[0].description).toBe(`Pieza libre ${rol.clave}`);
      expect(q.parts[0].inventoryId ?? undefined, "la partida guardada NO trae inventoryId").toBeUndefined();
      const art = (await call(request, "get", `/inventory/${d.articulo.id}`)).data;
      expect(Number(art.committed) || 0, "el artículo no queda comprometido").toBe(0);
    });
  }
});
