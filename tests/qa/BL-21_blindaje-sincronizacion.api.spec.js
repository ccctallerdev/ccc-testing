const { test, expect } = require("@playwright/test");
const { db, auth } = require("../../qaAdmin");
const { signIn, claimsOf, forget } = require("../../qaAuth");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-21 — Blindaje de la sincronización de suscripciones · PRUEBAS DE API
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Hermana de FEAT-TRIAL21 y de BL-19, pero NUEVA: aquella prueba que la etapa
 * SIN tarjeta se vence contra el reloj, y pasa en verde sin tocar una línea de
 * BL-21 — el agujero está justo del otro lado del `if`.
 *
 * Lo que se valida aquí, sobre HTTP real y Firestore real (no dobles):
 *
 *   1. NO-REGRESIÓN de BL-19: la prueba SIN tarjeta vencida sigue devolviendo
 *      402 en las rutas de negocio.
 *   2. La GRACIA: un trial CON tarjeta recién vencido NO se corta mientras el
 *      webhook va en camino.
 *   3. El caso del incidente del 9-sep sobre el stack real: documento rancio
 *      (trialing con trial_end vencido) cuya suscripción la pasarela NO puede
 *      resolver -> el sistema FALLA ABIERTO. Es la garantía de que el blindaje
 *      no le tumba el sistema a nadie.
 *   4. Coherencia: lo que dice `/billing/status` (lo que lee la web) es lo
 *      mismo que decide el muro del API.
 *   5. Un taller sano no se ve afectado: 200 en todo.
 *
 * ── LO QUE ESTE SPEC **NO** PUEDE CUBRIR, Y DÓNDE SE CUBRE ────────────────
 *
 *   · "doc rancio + la pasarela dice CANCELADA -> se corta" (caso 1b) necesita
 *     una suscripción REAL cancelada en la pasarela cuyo metadata.idWorkshop
 *     apunte a este taller de prueba. No se puede fabricar por API sin pasar
 *     por Checkout. Está cubierto en el unitario
 *     (ccc-backend/functions/tests/BL-21_blindaje-sincronizacion.unit.test.js,
 *     caso 1b) y va al script manual con el test clock DESPUÉS del deploy a QA.
 *   · El barrido `reconcileStaleSubscriptions()` todavía no tiene endpoint, así
 *     que no se puede disparar por HTTP. Cubierto en el unitario (caso 7).
 *   · `invoice.paid` mueve el estado: llega por webhook FIRMADO por Stripe, no
 *     se puede invocar desde aquí. Cubierto en el unitario (casos 3 y 4).
 *
 * ── CÓMO CORRERLO ─────────────────────────────────────────────────────────
 *
 * ► ANTES DEL MERGE (lo que valida la rama, que es de lo que se trata).
 *   QA todavía corre el código VIEJO, así que apuntar el spec a QA no probaría
 *   el arreglo. Se levanta el backend de la RAMA en local; sigue hablándole a
 *   Firestore y Auth de refac (serviceAccountKey.json), así que es el stack
 *   real salvo por dónde vive el proceso.
 *
 *     # terminal 1 — en la rama fix/bl21-blindaje-suscripcion-api
 *     cd C:\Users\USER\Documents\TRABAJO\ccc-backend\functions
 *     npm run dev                     # queda escuchando en localhost:3001
 *
 *     # terminal 2 — LIMPIA (sin variables de emulador)
 *     cd C:\Users\USER\Documents\TRABAJO\ccc-testing
 *     $env:API="http://localhost:3001/v1"
 *     $env:BL21_CORREO_BASE="rsv_gpa@outlook.com"
 *     $env:SKIP_SEED="1"
 *     npx playwright test --project=qa tests/qa/BL-21_blindaje-sincronizacion.api.spec.js
 *
 * ► DESPUÉS DEL DEPLOY A QA (la misma suite, sin tocar el archivo):
 *     $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"
 *
 * Opcionales:
 *   $env:BL21_PLAN="premium"         # basico | premium | master (default basico)
 *   $env:BL21_PASSWORD="Demo1234!"
 *   $env:BL21_LIMPIAR="1"            # borra al final el taller/usuario creado
 *
 * REQUISITO: `ccc-backend/functions/serviceAccountKey.json` de **refac**.
 * NO corre contra producción a propósito: qaAdmin solo carga la llave de refac.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "https://v1-hirpfgw7sa-uc.a.run.app/v1";
const PLAN = process.env.BL21_PLAN || "basico";
const PASSWORD = process.env.BL21_PASSWORD || "Demo1234!";
const LIMPIAR = process.env.BL21_LIMPIAR === "1";

const DIA_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

/**
 * Un id de suscripción con la forma correcta pero que la pasarela NO conoce.
 * Es la manera honesta de provocar "no puedo resolver esto" sin inventar
 * suscripciones de verdad ni tocar datos reales.
 */
const SUB_FANTASMA = `sub_1BL21NoExiste${Date.now().toString().slice(-8)}`;

function correoDeCorrida() {
  const base = process.env.BL21_CORREO_BASE || process.env.TRIAL_CORREO_BASE;
  if (!base || !base.includes("@")) {
    throw new Error(
      "Falta BL21_CORREO_BASE con un correo tuyo real, p.ej. rsv_gpa@outlook.com.\n" +
        "El spec le agrega +bl21<sello> para que cada corrida sea una cuenta nueva.",
    );
  }
  const [usuario, dominio] = base.split("@");
  return `${usuario}+bl21${Date.now().toString().slice(-6)}@${dominio}`;
}

const SELLO = Date.now().toString().slice(-6);
const ADMIN_CORREO = correoDeCorrida();

/** 10 dígitos exactos (estándar OBS31-08) y únicos por corrida. */
const telefono = (prefijo) => `${prefijo}${SELLO}${Math.floor(Math.random() * 10)}`;

const TALLER = {
  workshop: {
    name: `Taller BL21 ${SELLO}`,
    email: ADMIN_CORREO,
    address: "Av. de Pruebas 456, Puebla",
    phone: telefono("221"),
  },
  admin: {
    name: "Blindaje",
    firstSurname: "Veintiuno",
    secondSurname: SELLO,
    email: ADMIN_CORREO,
    phone: telefono("222"),
    password: PASSWORD,
    country: "MX",
  },
  planKey: PLAN,
  billingCycle: 0,
};

const ctx = { idWorkshop: null, subId: null, uid: null };

async function api(request, { metodo = "get", ruta, token, body }) {
  const res = await request[metodo](`${API}${ruta}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), json, data: json?.data ?? json };
}

async function subscriptionDe(idWorkshop) {
  const snap = await db()
    .collection("subscriptions")
    .where("idReference", "==", idWorkshop)
    .where("isDeleted", "==", false)
    .limit(1)
    .get();
  return snap.empty ? null : { id: snap.docs[0].id, data: snap.docs[0].data() };
}

const sembrar = (campos) => db().collection("subscriptions").doc(ctx.subId).update(campos);

/**
 * El muro tiene caché de 30 s por taller (requireActiveSubscription.TTL_MS).
 * Después de mover el documento hay que dejarla vencer o el test leería la
 * decisión anterior y pasaría/fallaría por la razón equivocada.
 */
const CACHE_MURO_MS = 31 * 1000;
const esperarCacheDelMuro = () => new Promise((r) => setTimeout(r, CACHE_MURO_MS));

function abortarSiEmuladores() {
  const restos = ["AUTH_EMU", "FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST"].filter(
    (v) => process.env[v],
  );
  if (restos.length) {
    throw new Error(
      `Esta prueba corre contra Firestore/Auth reales de refac, no contra emuladores, ` +
        `pero la terminal trae ${restos.join(", ")}.\nAbre una terminal nueva y vuelve a correrla.`,
    );
  }
}

test.describe.configure({ mode: "serial" });

test.describe("BL-21 — el acceso no cuelga de un solo evento de la pasarela", () => {
  test.beforeAll(() => {
    abortarSiEmuladores();
    console.log(`\n   API bajo prueba: ${API}`);
    if (!API.includes("localhost")) {
      console.log(
        "   ⚠️  Estás apuntando a un ambiente desplegado. Si BL-21 todavía no está\n" +
          "      ahí, los casos 3 y 4 fallarán: estarías probando el código viejo.\n",
      );
    }
  });

  test("1) se crea el taller de prueba (etapa sin tarjeta)", { tag: ["@api"] }, async ({ request }) => {
    const res = await api(request, { metodo: "post", ruta: "/billing/signup-trial", body: TALLER });
    expect(res.status, `signup-trial respondió ${res.status}: ${JSON.stringify(res.json)}`).toBe(201);

    const idToken = await signIn(ADMIN_CORREO, PASSWORD);
    const claims = claimsOf(idToken);
    ctx.idWorkshop = claims.idWorkshop;
    ctx.uid = claims.user_id || claims.sub || null;
    expect(ctx.idWorkshop, "el claim debe traer el taller recién creado").toBeTruthy();

    const sub = await subscriptionDe(ctx.idWorkshop);
    expect(sub, `no encontré la suscripción del taller ${ctx.idWorkshop}`).not.toBeNull();
    ctx.subId = sub.id;
    expect(sub.data.trialType, "nace en la etapa sin tarjeta").toBe("cardless");
  });

  test("2) NO-REGRESIÓN BL-19: la prueba SIN tarjeta vencida sigue dando 402", { tag: ["@api"] }, async ({ request }) => {
    await sembrar({ trial_end: new Date(Date.now() - DIA_MS) });
    await esperarCacheDelMuro();
    const token = await signIn(ADMIN_CORREO, PASSWORD);

    const entradas = await api(request, { ruta: `/entries?idWorkshop=${ctx.idWorkshop}`, token });
    expect(entradas.status, "con la prueba sin tarjeta vencida, /entries debe cerrar").toBe(402);
    expect(entradas.json?.data?.nextStep, "y debe pedir la tarjeta, no una suscripción nueva").toBe("register_card");

    const clientes = await api(request, { ruta: `/clients?idWorkshop=${ctx.idWorkshop}`, token });
    expect(clientes.status, "el muro cubre todas las rutas de negocio, no solo /entries").toBe(402);
  });

  test("3) GRACIA: un trial CON tarjeta recién vencido NO se corta", { tag: ["@api"] }, async ({ request }) => {
    // Se pasa el documento a la etapa 2 tal como lo dejaría el checkout, con el
    // reloj apenas vencido: el webhook puede tardar segundos. Cortar aquí sería
    // peor que el bug que BL-21 arregla.
    await sembrar({
      trialType: "card",
      status: 1,
      stripeStatus: "trialing",
      isTrial: true,
      externalSubscriptionId: SUB_FANTASMA,
      trial_end: new Date(Date.now() - 5 * MIN_MS),
      current_period_end: new Date(Date.now() - 5 * MIN_MS),
    });
    await esperarCacheDelMuro();
    const token = await signIn(ADMIN_CORREO, PASSWORD);

    const res = await api(request, { ruta: `/entries?idWorkshop=${ctx.idWorkshop}`, token });
    expect(
      res.status,
      "dentro de la gracia el acceso se conserva; si sale 402, le estamos cortando a quien acaba de pagar",
    ).toBe(200);
  });

  test("4) EL CASO DEL 9-SEP: documento rancio y pasarela que no resuelve -> FALLA ABIERTO", { tag: ["@api"] }, async ({ request }) => {
    // Reproducción del incidente: el webhook nunca llegó, el documento se quedó
    // en "trialing" con el reloj vencido hace días. Aquí la suscripción NO existe
    // en la pasarela, así que el auto-sanado no puede resolverla.
    //
    // Lo que se exige: que el sistema NO tumbe al taller ni truene. Un incidente
    // de la pasarela no puede dejar sin sistema a quien paga; el muro falla
    // abierto a propósito (middlewares/requireActiveSubscription, decisión 2).
    await sembrar({
      trial_end: new Date(Date.now() - 2 * DIA_MS),
      current_period_end: new Date(Date.now() - 2 * DIA_MS),
    });
    await esperarCacheDelMuro();
    const token = await signIn(ADMIN_CORREO, PASSWORD);

    const res = await api(request, { ruta: `/entries?idWorkshop=${ctx.idWorkshop}`, token });
    expect(res.status, "sin respuesta de la pasarela se DEJA PASAR, no se corta").toBe(200);

    // Y el documento no se corrompe en el intento: sigue completo y legible.
    const sub = await subscriptionDe(ctx.idWorkshop);
    expect(sub, "el documento debe seguir existiendo").not.toBeNull();
    expect(sub.data.idReference, "no se debe perder el taller dueño").toBe(ctx.idWorkshop);
    expect(sub.data.externalSubscriptionId, "ni el id de la pasarela").toBe(SUB_FANTASMA);
  });

  test("5) /billing/status dice lo MISMO que decide el muro", { tag: ["@api"] }, async ({ request }) => {
    // La web decide con /billing/status y el API con el muro. Si se contradicen,
    // el usuario ve una pantalla que no corresponde a lo que el API le permite:
    // exactamente el síntoma que reportó Enrique el 9-sep.
    const token = await signIn(ADMIN_CORREO, PASSWORD);
    const estado = await api(request, { ruta: `/billing/status/${ctx.idWorkshop}`, token });
    expect(estado.status).toBe(200);

    const entradas = await api(request, { ruta: `/entries?idWorkshop=${ctx.idWorkshop}`, token });
    const muroDejaPasar = entradas.status === 200;
    expect(
      estado.data?.hasAccess,
      `/billing/status dice hasAccess=${estado.data?.hasAccess} pero el muro respondió ${entradas.status}`,
    ).toBe(muroDejaPasar);
  });

  test("6) NO-REGRESIÓN: un taller sano no se ve afectado por el blindaje", { tag: ["@api"] }, async ({ request }) => {
    await sembrar({
      status: 2,
      stripeStatus: "active",
      isTrial: false,
      current_period_end: new Date(Date.now() + 25 * DIA_MS),
    });
    await esperarCacheDelMuro();
    const token = await signIn(ADMIN_CORREO, PASSWORD);

    const entradas = await api(request, { ruta: `/entries?idWorkshop=${ctx.idWorkshop}`, token });
    expect(entradas.status, "un taller con suscripción activa debe trabajar sin estorbos").toBe(200);

    const clientes = await api(request, { ruta: `/clients?idWorkshop=${ctx.idWorkshop}`, token });
    expect(clientes.status).toBe(200);

    const estado = await api(request, { ruta: `/billing/status/${ctx.idWorkshop}`, token });
    expect(estado.data?.hasAccess).toBe(true);
    expect(estado.data?.nextStep, "nada pendiente que hacer").toBe("none");
  });

  test.afterAll(async () => {
    forget(ADMIN_CORREO);
    if (!LIMPIAR) {
      console.log(
        `\n   ℹ️  Taller de prueba conservado: ${ADMIN_CORREO} (taller ${ctx.idWorkshop}).\n` +
          `      Para que el spec lo borre solo:  $env:BL21_LIMPIAR="1"\n`,
      );
      return;
    }
    try {
      if (ctx.subId) await db().collection("subscriptions").doc(ctx.subId).delete();
      if (ctx.idWorkshop) await db().collection("workshops").doc(ctx.idWorkshop).delete().catch(() => {});
      const user = await auth().getUserByEmail(ADMIN_CORREO).catch(() => null);
      if (user) {
        await auth().deleteUser(user.uid);
        await db().collection("users").doc(user.uid).delete().catch(() => {});
      }
      console.log(`\n   🧹 Limpieza hecha: ${ADMIN_CORREO}\n`);
    } catch (e) {
      console.log(`\n   ⚠️  No pude limpiar del todo (${e.message}). Revísalo a mano.\n`);
    }
  });
});
