const { test, expect } = require("@playwright/test");

/**
 * Q20 — Roles y Permisos (doc ejecutivo 13-jul):
 *   1) El Dueño (claim ADMIN=owner) crea usuarios con los 5 roles y el backend
 *      firma el custom claim `role` de cada uno.
 *   2) Matriz de pantallas: cada rol ve su menú y las rutas ajenas lo rebotan.
 *   3) Blindaje del servidor: endpoints con gate responden 403 al rol sin
 *      capability (aunque el usuario arme la URL a mano).
 *   4) Sanitización de red: los campos sensibles NO VIAJAN al rol que no debe
 *      verlos (Valor Atrapado solo Dueño; precio de venta no llega a Compras).
 *
 * PRERREQUISITOS: emuladores + backend + frontend; seed corrida (siembra al
 * admin CON custom claim role=ADMIN → owner).
 */

const API = process.env.API || "http://localhost:3001/v1";
const AUTH_EMU = process.env.AUTH_EMU || "http://127.0.0.1:9099";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const OWNER_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const OWNER_PASSWORD = process.env.SEED_PASSWORD || "prueba123";

const s = String(Date.now()).slice(-6);
const PASSWORD = "Password_123";
// Teléfono ÚNICO por usuario: el backend rechaza duplicados de correo O teléfono.
const USERS = {
  admin: { email: `rol.admin.${s}@ccc.test`, rol: "SUPER_ADMIN", name: "Gerente", phone: `551${s}1` },
  advisor: { email: `rol.asesor.${s}@ccc.test`, rol: "ASESOR", name: "Asesora", phone: `551${s}2` },
  purchasing: { email: `rol.compras.${s}@ccc.test`, rol: "COMPRAS", name: "Comprador", phone: `551${s}3` },
  mechanic: { email: `rol.mecanico.${s}@ccc.test`, rol: "MECANICO", name: "Tecnico", phone: `551${s}4` },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** idToken del emulador de Auth (REST; la key es ignorada por el emulador). */
async function tokenFor(request, email, password) {
  const res = await request.post(
    `${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`,
    { data: { email, password, returnSecureToken: true } },
  );
  if (!res.ok()) throw new Error(`signIn ${email} → ${res.status()}: ${await res.text()}`);
  return (await res.json()).idToken;
}

/** Claims del idToken (JWT sin verificar: solo para asertar el claim `role`). */
function claimsOf(idToken) {
  const payload = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
}

/** Llamada a la API con Bearer token. Devuelve status + body parseado. */
async function api(request, token, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), data: json?.data ?? json };
}

async function loginUI(page, email, password) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });
}

/** El ítem del menú lateral (por nombre exacto) ¿está visible?
    Ojo: el Sidebar renderiza BOTONES (navegan con onClick), no <a>. */
const menuItem = (page, name) =>
  page.locator("aside").getByRole("button", { name, exact: true });

// ─────────────────────────────────────────────────────────────────────────────

test.describe.serial("Q20 — roles y permisos", () => {
  let ownerToken;

  test("1) el Dueño crea usuarios con los 5 roles y el claim queda firmado", { tag: ["@api"] }, async ({ request }) => {
    ownerToken = await tokenFor(request, OWNER_EMAIL, OWNER_PASSWORD);
    // El claim del propio dueño (la seed lo siembra): ADMIN → owner.
    expect(claimsOf(ownerToken).role).toBe("ADMIN");

    for (const u of Object.values(USERS)) {
      const res = await api(request, ownerToken, "post", "/users", {
        idWorkshop: ID_WORKSHOP,
        name: u.name,
        firstSurname: "Prueba",
        email: u.email,
        password: PASSWORD,
        rol: u.rol, // COMPRAS valida el fix del enum del schema
        country: "México",
        phone: u.phone,
      });
      expect(res.status, `POST /users rol ${u.rol} → ${JSON.stringify(res.data)}`).toBeLessThan(300);

      // El backend debió firmar el custom claim `role` = rol asignado.
      const t = await tokenFor(request, u.email, PASSWORD);
      expect(claimsOf(t).role, `claim de ${u.rol}`).toBe(u.rol);
      u.token = t;
    }
  });

  test("2) Asesor: ve venta, no compras — menú, rebote de ruta y 403 del back", { tag: ["@ui"] }, async ({ page, request }) => {
    await loginUI(page, USERS.advisor.email, PASSWORD);

    // Matriz de pantallas (doc): asesor ✓ clientes/entrada/servicio/garantías.
    await expect(menuItem(page, "Clientes")).toBeVisible();
    await expect(menuItem(page, "Entrada de Vehículo")).toBeVisible();
    await expect(menuItem(page, "Servicio")).toBeVisible();
    await expect(menuItem(page, "Garantías")).toBeVisible();
    // ✗ abastecimiento/usuarios: ni en el menú…
    await expect(menuItem(page, "Abastecimiento")).toHaveCount(0);
    await expect(menuItem(page, "Usuarios")).toHaveCount(0);

    // …ni tecleando la URL (RoleBasedRoute rebota al home del rol).
    await page.goto("/abastecimiento");
    await expect(page).toHaveURL(/\/dashboard/);
    await page.goto("/usuarios");
    await expect(page).toHaveURL(/\/dashboard/);

    // Blindaje del servidor: proveedores es capability de compras.
    const sup = await api(request, USERS.advisor.token, "get", "/suppliers");
    expect(sup.status, "GET /suppliers como asesor").toBe(403);
  });

  test("3) Compras: ve costos, no clientes ni precio de venta", { tag: ["@ui"] }, async ({ page, request }) => {
    await loginUI(page, USERS.purchasing.email, PASSWORD);

    await expect(menuItem(page, "Abastecimiento")).toBeVisible();
    await expect(menuItem(page, "Inventario")).toBeVisible();
    await expect(menuItem(page, "Clientes")).toHaveCount(0);
    await expect(menuItem(page, "Entrada de Vehículo")).toHaveCount(0);
    await expect(menuItem(page, "Producción")).toHaveCount(0);
    await expect(menuItem(page, "Usuarios")).toHaveCount(0);

    await page.goto("/clientes");
    await expect(page).toHaveURL(/\/dashboard/);

    // Servidor: clientes prohibido para compras.
    const cli = await api(request, USERS.purchasing.token, "get", `/clients?idWorkshop=${ID_WORKSHOP}`);
    expect(cli.status, "GET /clients como compras").toBe(403);

    // Sanitización por campo: compras SÍ recibe costo, NO precio de venta.
    const inv = await api(request, USERS.purchasing.token, "get", `/inventory?idWorkshop=${ID_WORKSHOP}`);
    expect(inv.status).toBeLessThan(300);
    const items = Array.isArray(inv.data) ? inv.data : inv.data?.items ?? [];
    for (const it of items.slice(0, 5)) {
      expect(it, "precio de venta filtrado para compras").not.toHaveProperty("price");
    }
  });

  test("4) Mecánico: sin dashboard — su home es Servicio", { tag: ["@ui"] }, async ({ page, request }) => {
    await loginUI(page, USERS.mechanic.email, PASSWORD);

    // Al intentar el dashboard, el guard lo aterriza en /servicios.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/servicios/);

    await expect(menuItem(page, "Servicio")).toBeVisible();
    await expect(menuItem(page, "Producción")).toBeVisible();
    await expect(menuItem(page, "Agenda")).toBeVisible();
    await expect(menuItem(page, "Centro de control")).toHaveCount(0);
    await expect(menuItem(page, "Clientes")).toHaveCount(0);
    await expect(menuItem(page, "Inventario")).toHaveCount(0);
    await expect(menuItem(page, "Garantías")).toHaveCount(0);

    // Servidor: el dashboard ni siquiera responde datos al mecánico.
    const dash = await api(request, USERS.mechanic.token, "get", `/dashboard?idWorkshop=${ID_WORKSHOP}`);
    expect(dash.status, "GET /dashboard como mecánico").toBe(403);
  });

  test("5) Valor Atrapado: viaja al Dueño y NO viaja al Administrador", { tag: ["@api"] }, async ({ request }) => {
    // Dueño: healthValue presente en la respuesta del dashboard.
    const owner = await api(request, ownerToken, "get", `/dashboard?idWorkshop=${ID_WORKSHOP}`);
    expect(owner.status).toBeLessThan(300);
    expect(owner.data, "el Dueño debe recibir healthValue").toHaveProperty("healthValue");

    // Administrador (SUPER_ADMIN → admin): mismo endpoint 200, SIN healthValue
    // — el campo se elimina de la red (matriz: Valor Atrapado solo Dueño).
    const admin = await api(request, USERS.admin.token, "get", `/dashboard?idWorkshop=${ID_WORKSHOP}`);
    expect(admin.status, "dashboard permitido al admin").toBeLessThan(300);
    expect(admin.data?.healthValue, "healthValue NO debe viajar al admin").toBeUndefined();
  });

  test("6) Administrador (Gerente) en UI: pantalla completa pero SIN Valor Atrapado", { tag: ["@ui"] }, async ({ page }) => {
    // Nota del doc: "el Administrador entra a las mismas pantallas que el
    // Dueño, pero los indicadores financieros más sensibles no se le muestran".
    await loginUI(page, USERS.admin.email, PASSWORD);
    await page.goto("/dashboard");

    // Pantallas de gestión visibles (incluida Usuarios: admin ✓ en la matriz).
    await expect(menuItem(page, "Centro de control")).toBeVisible();
    await expect(menuItem(page, "Clientes")).toBeVisible();
    await expect(menuItem(page, "Abastecimiento")).toBeVisible();
    await expect(menuItem(page, "Usuarios")).toBeVisible();

    // El dashboard carga (espera un panel real) y el letrero "Valor Atrapado"
    // NO aparece en NINGÚN lado: ni en Salud del taller ni en el comandante
    // (el campo ni siquiera llegó por la red — prueba 5).
    await expect(page.getByText("Salud del taller")).toBeVisible();
    await expect(page.getByText(/Valor Atrapado/i)).toHaveCount(0);
  });

  test("7) layout por rol: los 12 ítems del menú contra la matriz del doc", { tag: ["@api"] }, async ({ browser }) => {
    test.setTimeout(120_000); // 5 logins en serie

    // Matriz de pantallas del doc ejecutivo (✓/✗ por rol), tal cual:
    const MENU = [
      //  ítem                      dueño  admin  asesor compras mec
      ["Centro de control",         true,  true,  true,  true,  false],
      ["Agenda",                    true,  true,  true,  true,  true],
      ["Clientes",                  true,  true,  true,  false, false],
      ["Entrada de Vehículo",       true,  true,  true,  false, false],
      ["Abastecimiento",            true,  true,  false, true,  false],
      ["Servicio",                  true,  true,  true,  false, true],
      ["Producción",                true,  true,  true,  false, true],
      ["Inventario",                true,  true,  true,  true,  false],
      ["Garantías",                 true,  true,  true,  true,  false],
      ["Mejora Continua",           true,  true,  true,  false, false],
      ["Usuarios",                  true,  true,  false, false, false],
      ["Configuración",             true,  true,  true,  true,  true],
    ];
    const SESSIONS = [
      { rolDoc: "Dueño", email: OWNER_EMAIL, password: OWNER_PASSWORD, col: 1 },
      { rolDoc: "Administrador", email: USERS.admin.email, password: PASSWORD, col: 2 },
      { rolDoc: "Asesor", email: USERS.advisor.email, password: PASSWORD, col: 3 },
      { rolDoc: "Compras", email: USERS.purchasing.email, password: PASSWORD, col: 4 },
      { rolDoc: "Mecánico", email: USERS.mechanic.email, password: PASSWORD, col: 5 },
    ];

    // Cada rol estrena CONTEXTO de navegador (perfil limpio): limpiar la
    // sesión de Firebase a mano es frágil (IndexedDB persiste y /login rebota).
    const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

    for (const ses of SESSIONS) {
      const context = await browser.newContext({ baseURL: BASE_URL });
      const page = await context.newPage();
      try {
        await loginUI(page, ses.email, ses.password);
        // Ancla: el menú ya montó (Configuración es visible para TODOS los roles).
        await expect(menuItem(page, "Configuración")).toBeVisible();

        for (const row of MENU) {
          const [label, ...cols] = row;
          const debeVerlo = cols[ses.col - 1];
          if (debeVerlo) {
            await expect(
              menuItem(page, label),
              `${ses.rolDoc} DEBE ver "${label}" en el menú`,
            ).toBeVisible();
          } else {
            await expect(
              menuItem(page, label),
              `${ses.rolDoc} NO debe ver "${label}" en el menú`,
            ).toHaveCount(0);
          }
        }
      } finally {
        await context.close();
      }
    }
  });

  test("8) EVIDENCIA — usuario legado sin claim: la API lo bloquea aunque Firestore diga ASESOR", { tag: ["@api"] }, async ({ request }) => {
    // Simula a CUALQUIER usuario de producción creado ANTES de feat/roles-setup:
    // cuenta de Auth SIN custom claim + doc de Firestore con rol válido.
    // Demuestra dos cosas a la vez:
    //   a) el backend es fail-closed (sin claim = sin acceso) ✔ correcto, y
    //   b) SIN un backfill de claims, TODOS los usuarios existentes quedarán
    //      fuera el día del deploy (el script backfill-role-claims.js que cita
    //      AuthContext no existe aún en la rama).
    const email = `legacy.${s}@ccc.test`;

    // 1) Cuenta de Auth "vieja": signUp directo al emulador (sin claims).
    const signUp = await request.post(
      `${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`,
      { data: { email, password: PASSWORD, returnSecureToken: true } },
    );
    expect(signUp.ok()).toBe(true);
    const { idToken, localId } = await signUp.json();
    expect(claimsOf(idToken).role, "usuario legado: no debe traer claim").toBeUndefined();

    // 2) Su doc de Firestore dice ASESOR (como cualquier usuario actual).
    process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
    const { initializeApp, getApps } = require("firebase-admin/app");
    const { getFirestore } = require("firebase-admin/firestore");
    if (!getApps().length) initializeApp({ projectId: "ccc-taller-refac" });
    await getFirestore().collection("users").doc(localId).set({
      uid: localId, email, rol: "ASESOR", idWorkshop: ID_WORKSHOP,
      isActive: true, isDeleted: false, createdAt: Date.now(), updatedAt: Date.now(),
    });

    // 3) Y aun así, la API lo rechaza: solo confía en el claim firmado.
    //    (Clientes es capability que un ASESOR real SÍ tiene — el bloqueo es
    //    puramente por la falta de claim.)
    const cli = await api(request, idToken, "get", `/clients?idWorkshop=${ID_WORKSHOP}`);
    expect(cli.status, "ASESOR legado sin claim → bloqueado (falta backfill)").toBe(403);
  });
});
