const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OBS21-01 — La línea de tiempo del expediente, por los 6 roles @ui
 * (rama fix/obs21-01-aprobar-en-espera-api) — escrito NUEVO, no reciclado
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Roberto, OS 1130 (21-sep): la línea de tiempo marcaba "Refacciones 20:05"
 * ANTES de "Cotización aprobada 20:05" y no aparecía "En espera". Traía una
 * partida de INVENTARIO. D30 (25-sep): el surtido parcial SÍ mueve el auto a
 * Refacciones (regla del 2-sep); lo que no puede pasar es el orden.
 *
 * Este spec arma por API una OS igual a la suya (1 pieza de inventario + 1 de
 * proveedor), la aprueba por el MISMO camino que el botón "Aprobar" del listado
 * (approve-selection + PUT APROBADA) y con el reloj del "navegador" adelantado
 * 1 minuto — la otra mitad del bug —, y luego cada rol abre el expediente real
 * y lee la línea de tiempo en pantalla. No intercepta nada: prueba el back
 * desplegado a través del front real.
 *
 * Orden esperado en pantalla:
 *   Ingreso al taller → Cotización aprobada → En espera → Refacciones
 *
 * Acceso: /expediente/:id exige CAN_CREATE_DIAGNOSTIC (Dueño, Administrador,
 * Asesor, Compras, Mecánico; Recepción entra como Asesor). El Mecánico solo
 * lee OS ASIGNADAS a él: por eso la OS se asigna a su uid (se busca por correo).
 * Cómo llega cada rol en la vida real: tarjeta de la OS en Entradas → botón
 * "Expediente" (CardsSmall.jsx). Aquí se entra directo por URL.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   El front de QA sirve: el arreglo es solo de back (desplegado en refac).
 *   $env:BASE_URL="https://ccc-frontend-qa.vercel.app"
 *   $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"
 *   $env:AUTH_REAL="1"; $env:SKIP_SEED="1"
 *   $env:ID_WORKSHOP="G85FhlhedkD4L4CEDWvW"
 *   $env:SEED_EMAIL="rsv_gpa@outlook.com"; $env:SEED_PASSWORD="admin123"
 *   $env:ROL_ADMINISTRADOR_EMAIL="rsv_gpa+admin1@outlook.com"; $env:ROL_ADMINISTRADOR_PASS="Prueba_123!"
 *   $env:ROL_ASESOR_EMAIL="rsv_gpa+asesor1@outlook.com";       $env:ROL_ASESOR_PASS="Prueba_123!"
 *   $env:ROL_COMPRAS_EMAIL="rsv_gpa+compras1@outlook.com";     $env:ROL_COMPRAS_PASS="Prueba_123!"
 *   $env:ROL_MECANICO_EMAIL="rsv_gpa+mecanico1@outlook.com";   $env:ROL_MECANICO_PASS="Prueba_123!"
 *   $env:ROL_RECEPCION_EMAIL="rsv_gpa+recepcion1@outlook.com"; $env:ROL_RECEPCION_PASS="Prueba_123!"
 *   npx playwright test --project=qa tests/qa/OBS21-01_linea-tiempo-expediente.ui.spec.js
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP;

const ROLES = [
  { nombre: "Dueño", clave: "DUENO",
    email: process.env.ROL_DUENO_EMAIL || process.env.SEED_EMAIL || "rsv_gpa@outlook.com",
    pass: process.env.ROL_DUENO_PASS || process.env.SEED_PASSWORD || "admin123" },
  { nombre: "Administrador", clave: "ADMINISTRADOR" },
  { nombre: "Asesor", clave: "ASESOR" },
  { nombre: "Compras", clave: "COMPRAS" },
  { nombre: "Mecánico", clave: "MECANICO" },
  { nombre: "Recepción", clave: "RECEPCION" },
].map((r) => ({
  ...r,
  email: r.email || process.env[`ROL_${r.clave}_EMAIL`],
  pass: r.pass || process.env[`ROL_${r.clave}_PASS`],
}));

const S = String(Date.now()).slice(-7);
let entryId = null;

async function call(request, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: await authHeaders(),
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json, data: json?.data ?? json };
}
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;
const ok = (r, msg) => expect(r.status, `${msg}: ${JSON.stringify(r.body)}`).toBeLessThan(300);

async function entrarComo(page, rol) {
  await page.goto("/login");
  await page.locator("#email").fill(rol.email);
  await page.locator("#password").fill(rol.pass);
  await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });
  await expect(page).not.toHaveURL(/\/suscripcion/, { timeout: 5000 });
}

test.describe.configure({ mode: "default" });

test.describe("OBS21-01 — línea de tiempo del expediente por roles @ui", () => {
  test.beforeAll(async ({ request }) => {
    test.setTimeout(90000);
    if (!ID_WORKSHOP) throw new Error('Falta ID_WORKSHOP (taller de refac). Ej: $env:ID_WORKSHOP="G85F..."');

    // El Mecánico solo lee OS asignadas a él: se busca su uid por correo.
    let mecanicoUid = "mecanico-prueba";
    const correoMec = process.env.ROL_MECANICO_EMAIL;
    if (correoMec) {
      const u = await call(request, "get", `/users/email/${encodeURIComponent(correoMec)}`);
      ok(u, "buscar al Mecánico por correo");
      mecanicoUid = idOf(u.data);
    }

    const art = await call(request, "post", "/inventory", {
      idWorkshop: ID_WORKSHOP, name: `Filtro de aceite UI ${S}`, sku: `O21UI-${S}`,
      cost: 200, price: 350, stock: 10,
    });
    ok(art, "artículo de inventario");

    const cliente = await call(request, "post", "/clients", {
      fullName: `Cliente obs21-01 UI ${S}`, email: `obs2101ui.${S}@test.com`,
      phone: `55${S}9`, idWorkshop: ID_WORKSHOP, createdBy: mecanicoUid,
    });
    ok(cliente, "cliente");
    const auto = await call(request, "post", "/cars", {
      clientId: idOf(cliente.data), brand: "Volkswagen", model: "Jetta", year: 2022,
      vin: `O21UI${S}00000000`.slice(0, 17), codeCar: `OUI-${S.slice(-4)}`,
      color: "Blanco", fuel: "Gasolina", transmition: "Automática", km: 38000,
    });
    ok(auto, "auto");
    const os = await call(request, "post", "/entries", {
      idWorkshop: ID_WORKSHOP, clientId: idOf(cliente.data), carId: idOf(auto.data),
      assigned_mechanic: mecanicoUid, status: 1,
      observations: "spec OBS21-01 UI (línea de tiempo)",
      registerDate: Date.now(), approvalState: "EN ESPERA",
    });
    ok(os, "OS");
    entryId = idOf(os.data);

    const hoja = await call(request, "post", `/entries/${entryId}/service-sheet`, {
      car_items: ["Documentos", "Llave"], checks: ["Servicio de Frenos"],
      isCheckAll: false, observations: "spec OBS21-01 UI", km: 38000, fuel_tank: "1/2",
    });
    ok(hoja, "hoja de servicio");
    const linea = (desc, count, extra) => ({
      description: desc, count, unitPrice: 500, cost: 500, subtotal: 500 * count,
      state: true, costProveedor: 300, utilidad: 40, availability: "VERDE", ...extra,
    });
    const cot = await call(request, "post", `/entries/${entryId}/quotes`, {
      diagnostic: "Servicio: filtro y balatas",
      labor: [{ description: "Mano de obra", count: 1, unitPrice: 300, cost: 300, subtotal: 300, state: true }],
      parts: [
        linea(`Filtro de aceite UI ${S}`, 1, { inventoryId: idOf(art.data) }),
        linea(`Balatas UI ${S}`, 2, { supplierId: `SUP-${S}`, supplierName: "Refaccionaria ACME" }),
      ],
      status: 2, clientBringsParts: false, stage: "COTIZACION",
    });
    ok(cot, "cotización");

    // Mismo camino que el botón "Aprobar" del listado (Entrada.jsx)…
    ok(await call(request, "put", `/entries/${entryId}/approve-selection`, {
      approvedQuoteId: idOf(cot.data), approvedServiceSheetId: idOf(hoja.data),
    }), "approve-selection");
    // …con la hora de un navegador adelantado 1 minuto (la otra mitad del bug).
    ok(await call(request, "put", `/entries/${entryId}`, {
      approvalState: "APROBADA",
      approvedDate: new Date(Date.now() + 60_000).toISOString(),
      rejectedDate: "",
    }), "PUT approvalState APROBADA");
  });

  for (const rol of ROLES) {
    test(`OBS21-01 — ${rol.nombre}`, async ({ page }, testInfo) => {
      test.skip(!rol.email || !rol.pass, `Sin credenciales para ${rol.nombre} (ROL_${rol.clave}_EMAIL/PASS)`);
      expect(entryId, "la OS de prueba debe existir (ver beforeAll)").toBeTruthy();

      await entrarComo(page, rol);
      await page.goto(`/expediente/${entryId}`);
      await expect(page, `${rol.nombre} debe poder abrir el expediente`).toHaveURL(new RegExp(`/expediente/${entryId}`), { timeout: 15000 });

      const linea = page.locator("ol").filter({ hasText: "Ingreso al taller" }).first();
      await expect(linea.getByText("Cotización aprobada"), `${rol.nombre}: la línea de tiempo debe cargar`).toBeVisible({ timeout: 20000 });
      await linea.screenshot({ path: testInfo.outputPath(`linea-tiempo-${rol.clave}.png`) });

      const pasos = (await linea.locator(":scope > li p.font-medium").allInnerTexts()).map((t) => t.trim());
      const i = (etiqueta) => pasos.indexOf(etiqueta);
      const resumen = pasos.join(" → ");

      expect(i("En espera"), `${rol.nombre}: debe aparecer "En espera" (Roberto: "sin En espera"). Pantalla: ${resumen}`).toBeGreaterThanOrEqual(0);
      expect(i("Refacciones"), `${rol.nombre}: con surtido de inventario el auto llega a "Refacciones" (D30 = b). Pantalla: ${resumen}`).toBeGreaterThanOrEqual(0);
      expect(i("Cotización aprobada"), `${rol.nombre}: "Cotización aprobada" va antes que "En espera". Pantalla: ${resumen}`).toBeLessThan(i("En espera"));
      expect(i("En espera"), `${rol.nombre}: "En espera" va antes que "Refacciones". Pantalla: ${resumen}`).toBeLessThan(i("Refacciones"));
    });
  }
});
