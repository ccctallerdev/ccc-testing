const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * BACKLOG_TECNICO #7 (25-ago) — PUT /v1/users/me: perfil PROPIO (foto y
 * nombre) para la app móvil. Antes la app pegaba a PUT /users/:id (solo
 * CAN_MANAGE_USERS) con axios sin Bearer, así que la foto de perfil elegida al
 * registrarse nunca se guardaba.
 */
const API = process.env.API || "http://localhost:3001/v1";
const AUTH_EMU = process.env.AUTH_EMU || "http://127.0.0.1:9099";

const s = String(Date.now()).slice(-6);
const C = { email: `me.cliente.${s}@ccc.test`, phone: `5570${s}`, password: "Prueba123!" };
const PHOTO = "https://firebasestorage.googleapis.com/v0/b/demo/o/uid%2Fimagenes%2FphotoProfile.jpg?alt=media";

async function api(request, token, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json, data: json?.data ?? json };
}

async function signIn(request, email, password) {
  const res = await request.post(
    `${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`,
    { data: { email, password, returnSecureToken: true } },
  );
  if (!res.ok()) throw new Error(`signIn ${email} → ${res.status()}: ${await res.text()}`);
  return await res.json();
}

test.describe.serial("PUT /users/me — perfil propio de la cuenta CLIENTE", () => {
  let token;
  let uid;
  let adminToken;

  test.beforeAll(async ({ request }) => {
    adminToken = (await authHeaders()).Authorization.replace("Bearer ", "");
    const signup = await api(request, null, "post", "/public/signup", {
      name: "Cliente", firstSurname: "Foto", email: C.email, phone: C.phone, password: C.password,
    });
    expect(signup.status, `signup: ${JSON.stringify(signup.body)}`).toBe(201);
    const auth = await signIn(request, C.email, C.password);
    token = auth.idToken;
    uid = auth.localId;
  });

  test("1) un CLIENTE (correo sin verificar) guarda su foto y nombre en /users/me", { tag: ["@api"] }, async ({ request }) => {
    const r = await api(request, token, "put", "/users/me", { photoURL: PHOTO, name: "Clienta" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.photoURL).toBe(PHOTO);
    expect(r.data.name).toBe("Clienta");
    // Lo lee de vuelta por su propio perfil (GET /users/:id propio sigue abierto).
    const me = await api(request, token, "get", `/users/${uid}`);
    expect(me.status).toBe(200);
    expect(me.data.photoURL).toBe(PHOTO);
  });

  test("2) /users/me NO acepta rol, taller, correo ni teléfono (se ignoran → 422 si no queda nada)", { tag: ["@api"] }, async ({ request }) => {
    // Campos fuera del perfil se ignoran; si no queda nada → 422.
    const r = await api(request, token, "put", "/users/me", { rol: "ADMIN", email: "otro@ccc.test", phone: "5500000000" });
    expect(r.status).toBe(422);
    // Con un taller en el body ni siquiera llega a la ruta: verifyWorkshopAccess
    // rechaza a un CLIENTE que pida cualquier taller (bloque 1, 25-ago).
    const conTaller = await api(request, token, "put", "/users/me", { name: "X", idWorkshop: "taller-prueba" });
    expect(conTaller.status).toBe(403);
    const me = await api(request, token, "get", `/users/${uid}`);
    expect(String(me.data.rol).toUpperCase()).toBe("CLIENTE");
    expect(me.data.email).toBe(C.email);
    expect(me.data.idWorkshop ?? "").toBe("");
    const bad = await api(request, token, "put", "/users/me", { photoURL: "javascript:alert(1)" });
    expect(bad.status).toBe(422);
  });

  test("3) el camino viejo sigue cerrado: PUT /users/:id como CLIENTE → 403; y el dueño no puede usar /me para otro", { tag: ["@api"] }, async ({ request }) => {
    const r = await api(request, token, "put", `/users/${uid}`, { photoURL: PHOTO });
    expect(r.status, "PUT /users/:id exige CAN_MANAGE_USERS").toBe(403);
    // /me siempre es el uid de la sesión: el dueño se edita a sí mismo, no al cliente.
    const own = await api(request, adminToken, "put", "/users/me", { name: "Dueño" });
    expect(own.status).toBe(200);
    expect(own.data.id).not.toBe(uid);
  });
});
