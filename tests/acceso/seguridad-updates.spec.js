const { test, expect } = require("@playwright/test");

/**
 * Seguridad — mass-assignment / updates sin permiso (8-ago-2026).
 *
 * A) POST /v1/subscriptions permitía a CUALQUIER usuario logueado crear una
 *    suscripción con status=2 y auto-otorgarse acceso ilimitado gratis. Se
 *    ELIMINÓ (era legacy pre-Stripe, sin uso). El GET (lectura) se conserva.
 * B) PUT /v1/workshops/:id escribía el body CRUDO → se inyectaban campos
 *    (isDeleted, isActive, idSubscription, billingExempt...). Ahora solo se
 *    escriben campos en lista blanca, sin romper el update legítimo.
 *
 * PRERREQUISITOS: emuladores + backend + seed (global-setup siembra al admin
 * con claim role=ADMIN → owner, y la suscripción activa del taller-prueba).
 */

const API = process.env.API || "http://localhost:3001/v1";
const AUTH_EMU = process.env.AUTH_EMU || "http://127.0.0.1:9099";
const OWNER_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const OWNER_PASSWORD = process.env.SEED_PASSWORD || "prueba123";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";

async function tokenFor(request, email, password) {
  const res = await request.post(
    `${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`,
    { data: { email, password, returnSecureToken: true } },
  );
  if (!res.ok()) throw new Error(`signIn ${email} → ${res.status()}: ${await res.text()}`);
  return (await res.json()).idToken;
}

async function api(request, token, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), data: json?.data ?? json };
}

test.describe.serial("Seguridad — updates sin permiso / mass-assignment", () => {
  test("1) POST /subscriptions fue removido → self-grant imposible (404)", { tag: ["@api"] }, async ({ request }) => {
    const ownerToken = await tokenFor(request, OWNER_EMAIL, OWNER_PASSWORD);
    const res = await api(request, ownerToken, "post", "/subscriptions", {
      idReference: ID_WORKSHOP,
      subscriptionType: 0,
      max_users: 4,
      plan_name: "hack",
      billing_cycle: 0,
      price: 0,
      status: 2, // lo que daría acceso ilimitado gratis
    });
    expect(res.status, "el POST debe estar removido (404), no crear la suscripción").toBe(404);
  });

  test("2) POST /subscriptions sin token: rechazado", { tag: ["@api"] }, async ({ request }) => {
    const res = await api(request, null, "post", "/subscriptions", { idReference: ID_WORKSHOP, status: 2 });
    expect([401, 404], "sin token debe rebotar").toContain(res.status);
  });

  test("3) el GET de suscripción sigue vivo (no rompimos lo que usa la app)", { tag: ["@api"] }, async ({ request }) => {
    const ownerToken = await tokenFor(request, OWNER_EMAIL, OWNER_PASSWORD);
    const res = await api(request, ownerToken, "get", `/subscriptions/${ID_WORKSHOP}`);
    expect(res.status, "GET /subscriptions/:id debe seguir respondiendo 200").toBe(200);
    expect(res.data?.status, "la suscripción sembrada debe estar activa (2)").toBe(2);
  });

  test("4) PUT /workshops/:id: no se inyectan campos sensibles, pero el update legítimo SÍ aplica", { tag: ["@api"] }, async ({ request }) => {
    const ownerToken = await tokenFor(request, OWNER_EMAIL, OWNER_PASSWORD);

    // NOTA: con el aislamiento entre talleres (Paso 2) el owner SOLO puede
    // editar SU propio taller — un taller desechable daría 403. Se prueba sobre
    // taller-prueba y se restaura el nombre al final para no ensuciar la seed.
    const wid = ID_WORKSHOP;

    // Update con un campo legítimo + campos PROHIBIDOS inyectados.
    const upd = await api(request, ownerToken, "put", `/workshops/${wid}`, {
      name: "Nombre Legitimo",
      isDeleted: true,
      isActive: false,
      idSubscription: "inyectado",
      billingExempt: true,
    });
    expect(upd.status, "el update del taller propio debe responder OK").toBeLessThan(300);

    // El campo legítimo SÍ se aplicó…
    expect(upd.data.name, "el nombre legítimo debe actualizarse").toBe("Nombre Legitimo");
    // …y los inyectados NO se persistieron.
    expect(upd.data.isDeleted, "isDeleted NO debe fijarse a true").not.toBe(true);
    expect(upd.data.isActive, "isActive NO debe fijarse a false").not.toBe(false);
    expect(upd.data, "billingExempt NO debe existir").not.toHaveProperty("billingExempt");
    expect(upd.data.idSubscription, "idSubscription NO debe inyectarse").not.toBe("inyectado");

    // Doble verificación por GET: el taller sigue vivo y con el nombre nuevo.
    const got = await api(request, ownerToken, "get", `/workshops/${wid}`);
    expect(got.status, "el taller debe seguir accesible (no borrado lógico)").toBeLessThan(300);
    expect(got.data.name).toBe("Nombre Legitimo");
    expect(got.data).not.toHaveProperty("billingExempt");

    // Restaurar el nombre sembrado para no ensuciar otras pruebas.
    await api(request, ownerToken, "put", `/workshops/${wid}`, { name: "Taller de Prueba" });
  });
});
