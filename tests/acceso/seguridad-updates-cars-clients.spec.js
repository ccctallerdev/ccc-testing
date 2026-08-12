const { test, expect } = require("@playwright/test");

/**
 * Seguridad — mass-assignment en UPDATE de cars y clients (#2).
 *
 * - PUT /cars/:id NO debe permitir borrar el auto inyectando `isDeleted:true`
 *   (la baja lógica es DELETE /cars/:id). El campo legítimo sí se aplica.
 * - PUT /clients/:id NO debe permitir borrar (`isDeleted`), desactivar
 *   (`isActive`) ni mover de taller (`idWorkshop`) por update. Solo datos de
 *   contacto. (idWorkshop además ya lo bloquea verifyWorkshopAccess si es ajeno.)
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

test.describe.serial("Seguridad — mass-assignment en update (cars / clients)", () => {
  let token;
  test.beforeAll(async ({ request }) => {
    token = await tokenFor(request, OWNER_EMAIL, OWNER_PASSWORD);
  });

  test("1) PUT /cars/:id: no se puede borrar por isDeleted; el campo legítimo sí aplica", { tag: ["@api"] }, async ({ request }) => {
    const u = String(Date.now());
    const created = await api(request, token, "post", "/cars", {
      clientId: `cli-${u}`,
      brand: "Nissan",
      model: "Versa",
      year: 2020,
      vin: `VIN${u}`,
      codeCar: `CC${u}`,
      color: "ROJO",
      fuel: "gasolina",
      transmition: "manual",
      km: 1000,
    });
    expect(created.status, `crear auto → ${JSON.stringify(created.data)}`).toBeLessThan(300);
    const carId = created.data.id;
    expect(carId).toBeTruthy();

    // Update legítimo (color) + inyección prohibida (isDeleted).
    const upd = await api(request, token, "put", `/cars/${carId}`, {
      color: "AZUL",
      isDeleted: true,
    });
    expect(upd.status, "el update debe responder OK").toBeLessThan(300);

    // El auto sigue accesible (NO se borró) y con el color nuevo:
    const got = await api(request, token, "get", `/cars/${carId}`);
    expect(got.status, "el auto NO debe quedar borrado (getCarById devuelve null si isDeleted)").toBe(200);
    expect(got.data.color, "el color legítimo sí se actualizó").toBe("AZUL");
    expect(got.data.isDeleted, "isDeleted NO debe fijarse a true").not.toBe(true);
  });

  test("2) PUT /clients/:id: no se puede borrar/desactivar por update; el contacto sí aplica", { tag: ["@api"] }, async ({ request }) => {
    const u = String(Date.now());
    const created = await api(request, token, "post", "/clients", {
      fullName: "Cliente Seg",
      email: `seg.${u}@ccc.test`,
      phone: `555${u}`.slice(0, 12),
      idWorkshop: ID_WORKSHOP,
      createdBy: "test",
    });
    expect(created.status, `crear cliente → ${JSON.stringify(created.data)}`).toBeLessThan(300);
    const clientId = created.data.id;
    expect(clientId).toBeTruthy();

    // Update legítimo (fullName) + inyecciones prohibidas.
    const upd = await api(request, token, "put", `/clients/${clientId}`, {
      fullName: "Cliente Nuevo",
      isDeleted: true,
      isActive: false,
    });
    expect(upd.status, "el update debe responder OK").toBeLessThan(300);

    // El cliente sigue vivo y activo; solo cambió el nombre:
    const got = await api(request, token, "get", `/clients/${clientId}`);
    expect(got.status, "el cliente debe seguir accesible").toBe(200);
    expect(got.data.fullName, "el nombre legítimo sí se actualizó").toBe("Cliente Nuevo");
    expect(got.data.isDeleted, "isDeleted NO debe fijarse a true").not.toBe(true);
    expect(got.data.isActive, "isActive NO debe fijarse a false por update").not.toBe(false);
  });
});
