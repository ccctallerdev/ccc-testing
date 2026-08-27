const { test, expect, request: pwRequest } = require("@playwright/test");
// adminFlex decide solo: API en localhost → EMULADORES; otra cosa → refac.
const { db: qaDb, auth: qaAuth, modo } = require("../../adminFlex");
const { headersFor } = require("../../qaAuth");
const { authHeaders } = require("#apiToken");

/**
 * ─────────────────────────────────────────────────────────────────────────
 * LÍMITE DE ÓRDENES POR MES (D18/D19 — respuestas de Roberto 25/26-ago) @api
 *
 * El ÚNICO límite de los planes: órdenes de servicio por MES CALENDARIO
 * (30/70/150). Aviso al 80 %, al 100 % se bloquean solo las órdenes NUEVAS,
 * apoyo del 10 % que se descuenta del mes siguiente, y todo detrás de la
 * bandera global `system_settings/order_limits` (TECH_SUPPORT).
 *
 * CÓMO CORRE — en cualquiera de los dos mundos (adminFlex decide con la
 * misma regla que apiToken: API en localhost ⇒ emuladores):
 *
 *   EMULADORES (receta normal de la suite): emuladores + backend local con
 *   ORDER_LIMITS_CONFIG_TTL_MS=0 (el servicio cachea la bandera 60 s y este
 *   spec la prende/apaga). global-setup siembra `taller-prueba` y el admin.
 *     npx playwright test --project=qa tests/qa/limite-ordenes.qa.spec.js
 *
 *   REFAC: igual que los demás gemelos de qa/ (serviceAccountKey + taller real):
 *     $env:AUTH_REAL="1"  (si la API también es local)
 *     $env:ID_WORKSHOP="<taller refac>"; $env:SEED_EMAIL=...; $env:SEED_PASSWORD=...
 *     npx playwright test --project=qa tests/qa/limite-ordenes.qa.spec.js
 *
 * Reparto de roles (regla del 26-ago: cada llamada con el token de SU rol):
 *   · Dueño (claim ADMIN)      → medidor, alta de OS, ACEPTAR el apoyo
 *   · Asesor (claim ASESOR)    → medidor sí, aceptar apoyo NO (403)
 *   · TECH_SUPPORT             → bandera global on/off
 * Los usuarios Asesor y TECH_SUPPORT se crean efímeros con el Admin SDK y se
 * borran al final (la prueba es de API: sembrar precondiciones por Admin SDK
 * sí está permitido; lo que se prueba viaja siempre por la API).
 *
 * La precondición "taller al límite" NO se monta creando 30 OS: se fija un
 * `limit_override` chico en `order_usage/{taller}` (el mismo mecanismo que
 * usará TECH_SUPPORT para las cuentas internas/demo — D19).
 * ─────────────────────────────────────────────────────────────────────────
 */

const API = process.env.API || "http://localhost:3001/v1";
// En emuladores el taller sembrado por global-setup es `taller-prueba`; contra
// refac hay que decir contra qué taller real se corre.
const ID_WORKSHOP = process.env.ID_WORKSHOP || (modo === "emulador" ? "taller-prueba" : null);
if (!ID_WORKSHOP) {
  throw new Error('Falta ID_WORKSHOP (taller real de refac). Ej: $env:ID_WORKSHOP="05Pf..."');
}

/** Mismo reloj que el backend: mes calendario en hora de México (UTC-6 fija). */
const TZ_OFFSET_MS = 6 * 60 * 60 * 1000;
const monthKey = (d = new Date()) => {
  const local = new Date(d.getTime() - TZ_OFFSET_MS);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}`;
};
const monthRangeMs = (key) => {
  const [y, m] = key.split("-").map(Number);
  return [Date.UTC(y, m - 1, 1) + TZ_OFFSET_MS, Date.UTC(y, m, 1) + TZ_OFFSET_MS];
};
const prevMonthKey = (key) => {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

const suffix = `${String(Date.now()).slice(-7)}`;
const TECH_EMAIL = `tech.limites.${suffix}@ccc.test`;
const ASESOR_EMAIL = `asesor.limites.${suffix}@ccc.test`;
const PASSWORD = "Prueba1234!";

// Rastro para limpiar TODO al final aunque un paso falle.
const creados = { uids: [], entryIds: [] };
let settingsPrevios = null;

async function call(request, method, path, { body, headers } = {}) {
  const res = await request[method](`${API}${path}`, {
    headers: { ...(headers || (await authHeaders())) },
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json };
}

const usageDueno = async (request) =>
  call(request, "get", `/order-limits/usage?idWorkshop=${ID_WORKSHOP}`);

/** Payload mínimo válido para POST /v1/entries (el client/car no necesitan existir). */
const entryBody = () => ({
  idWorkshop: ID_WORKSHOP,
  clientId: `cliente-inexistente-${suffix}`,
  carId: `auto-limites-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
  assigned_mechanic: "",
  status: 1,
  observations: "spec limite-ordenes",
  registerDate: Date.now(),
});

/** Siembra una OS "contable" directa en Firestore (solo para el conteo). */
async function sembrarEntry(createdAtMs) {
  const ref = await qaDb().collection("entries").add({
    idWorkshop: ID_WORKSHOP,
    isDeleted: false,
    createdAt: createdAtMs,
    status: 1,
    observations: "seed spec limite-ordenes",
    seedSpec: "limite-ordenes",
  });
  creados.entryIds.push(ref.id);
  return ref.id;
}

async function crearUsuarioEfimero(email, claims) {
  const user = await qaAuth().createUser({ email, password: PASSWORD });
  await qaAuth().setCustomUserClaims(user.uid, claims);
  creados.uids.push(user.uid);
  return user.uid;
}

test.describe.configure({ mode: "serial" });

test.describe("Límite de órdenes por mes @api", () => {
  let techHeaders;
  let asesorHeaders;

  test.beforeAll(async () => {
    await crearUsuarioEfimero(TECH_EMAIL, { role: "TECH_SUPPORT" });
    await crearUsuarioEfimero(ASESOR_EMAIL, { role: "ASESOR", idWorkshop: ID_WORKSHOP });
    techHeaders = await headersFor(TECH_EMAIL, PASSWORD);
    asesorHeaders = await headersFor(ASESOR_EMAIL, PASSWORD);
    // Estado limpio del taller de pruebas.
    await qaDb().collection("order_usage").doc(ID_WORKSHOP).delete().catch(() => {});
  });

  test.afterAll(async () => {
    // Restaurar la bandera como estaba (por la API, para refrescar el caché).
    // `request` no existe en afterAll: se crea un contexto propio.
    const ctx = await pwRequest.newContext();
    if (settingsPrevios) {
      await call(ctx, "put", "/order-limits/settings", {
        body: { enforcement: settingsPrevios.enforcement },
        headers: techHeaders,
      }).catch(() => {});
    }
    await ctx.dispose();
    await qaDb().collection("order_usage").doc(ID_WORKSHOP).delete().catch(() => {});
    for (const id of creados.entryIds) {
      await qaDb().collection("entries").doc(id).delete().catch(() => {});
    }
    for (const uid of creados.uids) {
      await qaAuth().deleteUser(uid).catch(() => {});
    }
  });

  test("la bandera global es de TECH_SUPPORT y arranca apagada para este spec", async ({ request }) => {
    // El Dueño NO puede tocar la bandera.
    const comoDueno = await call(request, "put", "/order-limits/settings", {
      body: { enforcement: "on" },
    });
    expect([401, 403]).toContain(comoDueno.status);

    const actual = await call(request, "get", "/order-limits/settings", { headers: techHeaders });
    expect(actual.status).toBe(200);
    settingsPrevios = actual.body.data;

    const off = await call(request, "put", "/order-limits/settings", {
      body: { enforcement: "off" },
      headers: techHeaders,
    });
    expect(off.status).toBe(200);
    expect(off.body.data.enforcement).toBe("off");
  });

  test("medidor: cuenta el MES CALENDARIO y trae el tope del plan", async ({ request }) => {
    const antes = await usageDueno(request);
    expect(antes.status).toBe(200);
    const u0 = antes.body.data;
    expect(u0.month).toBe(monthKey());
    expect(u0.limit).toBeGreaterThan(0);
    expect(u0.enforcement).toBe("off");
    expect(u0.blocked).toBe(false);

    // Una OS del mes PASADO no cuenta; una de ESTE mes sí.
    const [inicioMes] = monthRangeMs(monthKey());
    const [inicioPrev] = monthRangeMs(prevMonthKey(monthKey()));
    await sembrarEntry(inicioPrev + 60000);
    const conPrev = await usageDueno(request);
    expect(conPrev.body.data.used).toBe(u0.used);

    await sembrarEntry(inicioMes + 60000);
    const conActual = await usageDueno(request);
    expect(conActual.body.data.used).toBe(u0.used + 1);
  });

  test("con la bandera APAGADA no se bloquea nada aunque el tope esté rebasado", async ({ request }) => {
    const u = (await usageDueno(request)).body.data;
    // Tope de mentira: exactamente lo ya consumido (taller "al límite").
    await qaDb().collection("order_usage").doc(ID_WORKSHOP).set(
      { idWorkshop: ID_WORKSHOP, limit_override: u.used },
      { merge: true },
    );
    const alta = await call(request, "post", "/entries", { body: entryBody() });
    expect(alta.status).toBe(200); // la bandera manda: apagada, no hay bloqueo
    const id = alta.body?.data?.id;
    expect(id).toBeTruthy();
    creados.entryIds.push(id);
  });

  test("bandera ENCENDIDA: al tope se bloquean solo las órdenes NUEVAS con ORDER_LIMIT_REACHED", async ({ request }) => {
    const on = await call(request, "put", "/order-limits/settings", {
      body: { enforcement: "on" },
      headers: techHeaders,
    });
    expect(on.status).toBe(200);

    // Re-anclar el tope EXACTAMENTE en lo consumido: el alta del test anterior
    // (con la bandera apagada) dejó used = override+1, y con un tope chico el
    // apoyo del 10 % (1 OS) no alcanzaría a desbloquear en el test del Dueño.
    // Así el escenario es determinista: al tope, sin rebasarlo.
    const consumoActual = (await usageDueno(request)).body.data.used;
    await qaDb().collection("order_usage").doc(ID_WORKSHOP).set(
      { idWorkshop: ID_WORKSHOP, limit_override: consumoActual },
      { merge: true },
    );

    const u = (await usageDueno(request)).body.data;
    expect(u.enforcement).toBe("on");
    expect(u.used).toBe(u.limit); // exactamente al tope
    expect(u.blocked).toBe(true);
    expect(u.warned).toBe(true); // al 100 % el aviso del 80 % también aplica
    expect(u.tolerance.available).toBe(true);
    expect(u.tolerance.amount).toBe(Math.ceil(u.baseCap * 0.1));

    const alta = await call(request, "post", "/entries", { body: entryBody() });
    expect(alta.status).toBe(403);
    expect(alta.body.errors.code).toBe("ORDER_LIMIT_REACHED");
    expect(alta.body.errors.usage.used).toBe(u.used);

    // No se creó nada: el consumo no se movió.
    const despues = (await usageDueno(request)).body.data;
    expect(despues.used).toBe(u.used);
  });

  test("el Asesor NO puede aceptar el apoyo (Dueño/Administrador solamente)", async ({ request }) => {
    const r = await call(request, "post", "/order-limits/tolerance/accept", {
      body: { idWorkshop: ID_WORKSHOP },
      headers: asesorHeaders,
    });
    expect(r.status).toBe(403);
  });

  test("el Dueño acepta el apoyo del 10 %: se desbloquea este mes y solo UNA vez", async ({ request }) => {
    const antes = (await usageDueno(request)).body.data;

    const acepta = await call(request, "post", "/order-limits/tolerance/accept", {
      body: { idWorkshop: ID_WORKSHOP },
    });
    expect(acepta.status).toBe(200);
    const u = acepta.body.data;
    expect(u.toleranceExtra).toBe(antes.tolerance.amount);
    expect(u.limit).toBe(antes.limit + antes.tolerance.amount);
    expect(u.blocked).toBe(false);
    expect(u.tolerance.accepted).toBe(true);
    expect(u.tolerance.available).toBe(false);

    // Ahora sí se puede registrar (dentro del apoyo).
    const alta = await call(request, "post", "/entries", { body: entryBody() });
    expect(alta.status).toBe(200);
    creados.entryIds.push(alta.body.data.id);

    // El apoyo es uno por mes.
    const otraVez = await call(request, "post", "/order-limits/tolerance/accept", {
      body: { idWorkshop: ID_WORKSHOP },
    });
    expect(otraVez.status).toBe(409);
    expect(otraVez.body.errors.code).toBe("TOLERANCE_ALREADY_ACCEPTED");
  });

  test("lo usado del apoyo se DESCUENTA del mes siguiente (cierre perezoso)", async ({ request }) => {
    // Simular: el mes pasado aceptó apoyo de 3 con tope base N y usó 1 de más.
    const mesPasado = prevMonthKey(monthKey());
    const [inicioPrev] = monthRangeMs(mesPasado);
    // Ya hay 1 OS sembrada el mes pasado (test del medidor): tope base 0 haría
    // extraUsed=1..., mejor explícito: 2 OS del mes pasado con baseCap 1 → usó 1 de más.
    await sembrarEntry(inicioPrev + 120000);
    await qaDb().collection("order_usage").doc(ID_WORKSHOP).set(
      {
        idWorkshop: ID_WORKSHOP,
        limit_override: 10,
        tolerance: { month: mesPasado, granted: 3, baseCap: 1, acceptedAt: new Date(), acceptedByUid: "spec" },
      },
      { merge: false },
    );

    const u = (await usageDueno(request)).body.data;
    expect(u.debt).toBe(1); // min(3, max(0, 2 usadas - 1 de tope)) = 1
    expect(u.baseCap).toBe(10);
    expect(u.limit).toBe(9); // 10 - 1 de deuda
    expect(u.toleranceExtra).toBe(0); // la tolerancia vieja ya no aplica
    // Y el doc quedó saldado: la tolerancia se limpió, la deuda quedó escrita.
    const doc = (await qaDb().collection("order_usage").doc(ID_WORKSHOP).get()).data();
    expect(doc.tolerance).toBeUndefined();
    expect(doc.debt.month).toBe(monthKey());
  });

  test("taller SIN registro de suscripción: aplica el tope del plan más bajo, nunca 'sin límite' (D19)", async ({ request }) => {
    // El taller de pruebas puede o no tener suscripción; lo determinante es que
    // limit/baseCap NUNCA sean 0/infinito. Sin override, el backend cae en
    // cadena a billing_plans/catálogo y, sin nada, al plan más bajo (30).
    await qaDb().collection("order_usage").doc(ID_WORKSHOP).delete();
    const u = (await usageDueno(request)).body.data;
    expect(u.baseCap).toBeGreaterThan(0);
    expect(Number.isFinite(u.limit)).toBe(true);
    if (!u.hasSubscription) expect(u.baseCap).toBe(30);
  });
});
