const { test, expect } = require("@playwright/test");

/**
 * Seguridad — estado/aprobación FORZADOS al CREAR (entries / quotes / diagnostics).
 *
 * El cliente NO debe poder nacer una OS ya "APROBADA" ni fijar el `status`
 * inicial: el backend impone el estado inicial (OS nueva → EN ESPERA / status 1;
 * quote → 2; diagnóstico → 1). Aprobar/avanzar es por endpoints dedicados
 * (PUT /:id con su gating de rol, approve-selection / approve-concepts), no al crear.
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

test.describe.serial("Seguridad — no forzar estado/aprobación al crear", () => {
  let token;
  let entryId;

  test.beforeAll(async ({ request }) => {
    token = await tokenFor(request, OWNER_EMAIL, OWNER_PASSWORD);
  });

  test("1) crear entrada: no se puede auto-aprobar ni fijar status — el backend impone el inicial", { tag: ["@api"] }, async ({ request }) => {
    const u = String(Date.now());
    const created = await api(request, token, "post", "/entries", {
      idWorkshop: ID_WORKSHOP,
      clientId: `c-${u}`,
      carId: `car-${u}`, // carro fresco: sin OS activa que bloquee el alta
      assigned_mechanic: "mecanico-prueba",
      registerDate: Date.now(),
      observations: "obs legitima",
      // Campos de flujo INYECTADOS (intento de saltarse la aprobación):
      status: 99,
      approvalState: "APROBADA",
      approvedDate: Date.now(),
    });
    expect(created.status, `crear entrada → ${JSON.stringify(created.data)}`).toBeLessThan(300);
    entryId = created.data.id;
    expect(entryId, "debe devolver el id de la entrada").toBeTruthy();

    // El backend impuso el estado inicial (lo inyectado NO coló):
    expect(created.data.status, "status forzado a 1").toBe(1);
    expect(created.data.approvalState, "approvalState forzado a EN ESPERA").toBe("EN ESPERA");
    expect(created.data.approvalDate, "no debe quedar approvalDate (no nació aprobada)").toBeFalsy();
    // El contenido legítimo sí se guardó:
    expect(created.data.observations, "el campo legítimo sí persiste").toBe("obs legitima");
  });

  test("2) crear cotización: el status inicial lo pone el backend, no el cliente", { tag: ["@api"] }, async ({ request }) => {
    const created = await api(request, token, "post", `/entries/${entryId}/quotes`, {
      diagnostic: "",
      labor: [],
      parts: [],
      stage: "COSTEO",
      status: 99, // inyectado
    });
    expect(created.status, `crear quote → ${JSON.stringify(created.data)}`).toBeLessThan(300);
    expect(created.data.status, "status de la quote forzado a 2").toBe(2);
  });

  test("3) crear diagnóstico: status impuesto por backend y summary derivado (no del cliente)", { tag: ["@api"] }, async ({ request }) => {
    const created = await api(request, token, "post", `/entries/${entryId}/diagnostics`, {
      generalObservations: "revision",
      findings: [{ system: "frenos", finding: "fuga de liquido", severity: "ROJO" }],
      status: 99, // inyectado
      summary: { red: 0, yellow: 0, green: 99 }, // inyectado (debe ignorarse)
    });
    expect(created.status, `crear diagnóstico → ${JSON.stringify(created.data)}`).toBeLessThan(300);
    expect(created.data.status, "status del diagnóstico forzado a 1").toBe(1);
    // El summary lo calcula el backend a partir de los findings (1 ROJO):
    expect(created.data.summary?.red, "summary derivado en backend (1 rojo)").toBe(1);
    expect(created.data.summary?.green, "el summary inyectado se ignora").toBe(0);
  });
});
