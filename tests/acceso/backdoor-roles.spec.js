const { test, expect } = require("@playwright/test");

/**
 * BACKDOOR — huecos de autorización POR ROL dentro del MISMO taller (C4).
 *
 * Lo que YA está bien (no lo prueba este archivo): sin sesión → 401; y un
 * usuario de un taller no llega a datos de otro (verifyWorkshopAccess).
 * Lo que este archivo demuestra: dentro de un taller, un usuario con el rol
 * más bajo (MECÁNICO) puede hacer por API cosas que NO le tocan, porque a
 * varios endpoints les falta `authorize`. El front lo oculta, pero el front
 * no es seguridad: aquí se llama la API directo con el token del mecánico.
 *
 * Estos tests están escritos para FALLAR HOY (documentan el hueco) y pasar
 * cuando se implemente C4. Por eso van con tag @backdoor y NO en la suite por
 * defecto — córrelos a propósito:
 *
 *   npx playwright test --project=acceso --grep "@backdoor"
 *
 * PRERREQUISITOS: emuladores + backend :3001. Cuenta semilla (dueño) por env.
 */

const API = process.env.API || "http://localhost:3001/v1";
const AUTH_EMU = process.env.AUTH_EMU || "http://127.0.0.1:9099";
const OWNER_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const OWNER_PASSWORD = process.env.SEED_PASSWORD || "prueba123";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const s = String(Date.now()).slice(-6);
const PASSWORD = "Password_123";

async function tokenFor(request, email, password) {
  const res = await request.post(
    `${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`,
    { data: { email, password, returnSecureToken: true } },
  );
  if (!res.ok()) throw new Error(`signIn ${email} → ${res.status()}: ${await res.text()}`);
  const j = await res.json();
  return { token: j.idToken, uid: j.localId };
}

async function api(request, token, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), data: json?.data ?? json };
}

test.describe("BACKDOOR — un MECÁNICO no debería poder hacer esto por API (C4)", () => {
  let owner;              // { token, uid } del dueño
  let mech;              // { token, uid } de un mecánico recién creado
  const mechEmail = `backdoor.mecanico.${s}@ccc.test`;
  const victimEmail = `backdoor.victima.${s}@ccc.test`;
  let victimUid;

  test.beforeAll(async ({ request }) => {
    owner = await tokenFor(request, OWNER_EMAIL, OWNER_PASSWORD);
    // El dueño crea un MECÁNICO (rol más bajo) y una segunda cuenta "víctima".
    const m = await api(request, owner.token, "post", "/users", {
      idWorkshop: ID_WORKSHOP, name: "Backdoor", firstSurname: "Mecanico",
      email: mechEmail, password: PASSWORD, rol: "MECANICO", country: "México", phone: `551${s}9`,
    });
    expect(m.status, `crear mecánico → ${JSON.stringify(m.data)}`).toBeLessThan(300);
    const v = await api(request, owner.token, "post", "/users", {
      idWorkshop: ID_WORKSHOP, name: "Backdoor", firstSurname: "Victima",
      email: victimEmail, password: PASSWORD, rol: "ASESOR", country: "México", phone: `551${s}8`,
    });
    expect(v.status).toBeLessThan(300);
    mech = await tokenFor(request, mechEmail, PASSWORD);
    victimUid = (await tokenFor(request, victimEmail, PASSWORD)).uid;
  });

  test("A) SECUESTRO DE CUENTA: el mecánico cambia la contraseña de otro usuario (PUT /users/password)", { tag: ["@backdoor", "@api", "@seguridad"] }, async ({ request }) => {
    // PUT /users/password no tiene authorize ni valida que el uid sea el propio;
    // por dentro llama admin.auth().updateUser(uid, {password}). Un mecánico
    // podría cambiarle la contraseña al DUEÑO y entrar como él.
    const res = await api(request, mech.token, "put", "/users/password", {
      uid: victimUid,
      password: "Hackeada_123",
    });
    // Lo correcto: 403 (o 401). Si responde 2xx, la puerta está abierta.
    expect(res.status, `cambiar contraseña ajena debería ser 403; fue ${res.status}`).toBe(403);

    // Prueba de vida del hueco: si NO se corrigió, la nueva contraseña funciona.
    if (res.status < 300) {
      const relogin = await request.post(
        `${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`,
        { data: { email: victimEmail, password: "Hackeada_123", returnSecureToken: true } },
      );
      expect(relogin.ok(), "⚠️ la cuenta ajena quedó secuestrada con la contraseña nueva").toBe(false);
    }
  });

  test("B) ESCALADA DE PRIVILEGIOS: el mecánico crea un usuario ADMIN (POST /users)", { tag: ["@backdoor", "@api", "@seguridad"] }, async ({ request }) => {
    // POST /users sí gatea con CAN_MANAGE_USERS → debería ser 403 para el mecánico.
    const res = await api(request, mech.token, "post", "/users", {
      idWorkshop: ID_WORKSHOP, name: "Escalada", firstSurname: "Admin",
      email: `backdoor.admin.${s}@ccc.test`, password: PASSWORD, rol: "ADMIN", country: "México", phone: `551${s}7`,
    });
    expect(res.status, "un mecánico no debe poder crear usuarios/roles").toBe(403);
  });

  test("C) BORRADO: el mecánico borra un usuario (DELETE /users/:id)", { tag: ["@backdoor", "@api", "@seguridad"] }, async ({ request }) => {
    const res = await api(request, mech.token, "delete", `/users/${victimUid}`);
    expect(res.status, "un mecánico no debe poder borrar usuarios").toBe(403);
  });

  test("D) CONFIG DEL TALLER: el mecánico cambia el Modelo Operativo (PUT /settings/operating-model)", { tag: ["@backdoor", "@api", "@seguridad"] }, async ({ request }) => {
    // Sin authorize: un mecánico puede cambiar osStart, horario y umbrales del taller.
    const res = await api(request, mech.token, "put", `/settings/operating-model?idWorkshop=${ID_WORKSHOP}`, {
      osStart: 99999,
    });
    expect(res.status, "un mecánico no debe poder editar la config del taller").toBe(403);
  });

  test("E) FUGA DE CONTACTO: el mecánico lee el perfil de otro usuario (GET /users/:id trae teléfono/correo)", { tag: ["@backdoor", "@api", "@seguridad"] }, async ({ request }) => {
    // El ejecutivo dice que el mecánico "nunca ve datos de contacto". Hoy
    // GET /users/:id no restringe a uid propio y devuelve email/phone.
    const res = await api(request, mech.token, "get", `/users/${victimUid}`);
    const leaked = res.status < 300 && (res.data?.email || res.data?.phone);
    expect(Boolean(leaked), "un mecánico no debería leer correo/teléfono de otro usuario").toBe(false);
  });
});
