const { test, expect } = require("@playwright/test");

/**
 * Regresión — limpieza de código muerto (8-ago-2026). Confirma que quitar
 * código muerto NO rompió los endpoints tocados:
 *   - routes/V1/workshops.js: se eliminó un `PUT /:id` DUPLICADO → el PUT que
 *     queda (el único) debe seguir creando/actualizando/leyendo igual.
 *   - services/subscriptions/subscriptions.service.js: se eliminó el método
 *     `createSubscription` + imports → el `GET /subscriptions/:id` debe seguir
 *     cargando el módulo y respondiendo.
 *
 * PRERREQUISITOS: emuladores + backend + seed (global-setup).
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

test.describe.serial("Regresión — la limpieza no rompió endpoints", () => {
  test("workshops: crear → actualizar (único PUT) → obtener siguen OK", { tag: ["@api"] }, async ({ request }) => {
    const t = await tokenFor(request, OWNER_EMAIL, OWNER_PASSWORD);
    const s = String(Date.now()).slice(-6);

    const created = await api(request, t, "post", "/workshops", {
      name: `Reg ${s}`, email: `reg.${s}@ccc.test`, address: "Calle 123", phone: `55501${s}0000000000`.slice(0, 10),
    });
    expect(created.status, `crear taller → ${JSON.stringify(created.data)}`).toBeLessThan(300);
    const wid = created.data.id;

    const upd = await api(request, t, "put", `/workshops/${wid}`, { name: "Reg Actualizado" });
    expect(upd.status, "el PUT (único) debe funcionar").toBeLessThan(300);
    expect(upd.data.name).toBe("Reg Actualizado");

    const got = await api(request, t, "get", `/workshops/${wid}`);
    expect(got.status, "el GET del taller debe responder 200").toBe(200);
    expect(got.data.name).toBe("Reg Actualizado");
  });

  test("subscriptions: el GET sigue cargando/respondiendo tras quitar createSubscription", { tag: ["@api"] }, async ({ request }) => {
    const t = await tokenFor(request, OWNER_EMAIL, OWNER_PASSWORD);
    const got = await api(request, t, "get", `/subscriptions/${ID_WORKSHOP}`);
    expect(got.status, "GET /subscriptions/:id debe seguir respondiendo 200").toBe(200);
    expect(got.data?.status, "la suscripción sembrada está activa (2)").toBe(2);
  });
});
