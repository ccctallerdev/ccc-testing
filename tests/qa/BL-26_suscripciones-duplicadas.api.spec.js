const { test, expect } = require("@playwright/test");
const { db } = require("../../qaAdmin");
const { signIn, claimsOf, forget } = require("../../qaAuth");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-26 — Con suscripciones duplicadas, el API debe leer LA MÁS RECIENTE
 * PRUEBAS DE API (nuevas, no recicladas)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── QUÉ CUBRE ESTO Y QUÉ NO ───────────────────────────────────────────────
 *
 * La CARRERA (dos webhooks creando a la vez) NO se prueba aquí: por HTTP no se
 * puede forzar ese entrelazado de forma confiable y el resultado dependería de
 * la red. Eso está en el unitario
 * `ccc-backend/functions/tests/BL-26_suscripciones-duplicadas.unit.test.js`,
 * donde el doble permite intercalar las operaciones a mano.
 *
 * Lo que se prueba aquí es la OTRA mitad, y es la que le pega al usuario: con
 * duplicados YA EXISTENTES —que los hay, y seguirán habiéndolos hasta que se
 * consoliden— ¿qué documento lee el sistema? Sobre HTTP real y Firestore real.
 *
 * ── CÓMO SE FUERZA EL DUPLICADO ───────────────────────────────────────────
 *
 * Se planta a mano con el SDK admin, y los ids NO son al azar:
 *
 *     subscriptions/aaa-…-vieja     ← rancia, plan básico, trialing vencido
 *     subscriptions/zzz-…-nueva     ← buena, plan premium, activa, más reciente
 *
 * Firestore, sin `orderBy`, resuelve un `.limit(1)` por el orden implícito de
 * `__name__`. Con `aaa…` antes que `zzz…`, el código viejo devuelve SIEMPRE la
 * rancia. Es el mismo accidente que ocurrió en refac —ahí ganó la buena sólo
 * porque su id empezaba con `b` y el del duplicado con `q`—, pero al revés y
 * de forma determinista, para que la prueba no dependa de la suerte.
 *
 * ── QUÉ DEBE PASAR ────────────────────────────────────────────────────────
 *
 *   Contra el código VIEJO   → casos 2 y 3 en ROJO (lee la rancia)
 *   Contra el código de BL-26 → todo en verde (lee la reciente)
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *
 *   # terminal 1 — parado en la rama fix/bl26-suscripciones-duplicadas-api
 *   cd C:\Users\USER\Documents\TRABAJO\ccc-backend\functions
 *   npm run dev
 *
 *   # terminal 2 — LIMPIA (sin variables de emulador)
 *   cd C:\Users\USER\Documents\TRABAJO\ccc-testing
 *   $env:API="http://localhost:3001/v1"
 *   $env:BL26_CORREO_BASE="rsv_gpa@outlook.com"
 *   $env:SKIP_SEED="1"
 *   npx playwright test --project=qa tests/qa/BL-26_suscripciones-duplicadas.api.spec.js
 *
 * Opcionales:
 *   $env:BL26_PASSWORD="Demo1234!"
 *   $env:BL26_DEJAR_RASTRO="1"   # NO limpia al final (para inspeccionar a mano)
 *
 * REQUISITO: `ccc-backend/functions/serviceAccountKey.json` de refac.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const PASSWORD = process.env.BL26_PASSWORD || "Demo1234!";
// Se limpia por OMISIÓN, al revés que otros specs. Estos fixtures son dos
// suscripciones duplicadas a propósito, y el instrumento con el que vigilamos
// BL-26 —`scripts/duplicados-suscripciones.js`— las reporta como duplicados
// reales. Una prueba no debería ensuciar su propio aparato de medición.
// Para inspeccionar a mano: $env:BL26_DEJAR_RASTRO="1"
const DEJAR_RASTRO = process.env.BL26_DEJAR_RASTRO === "1";
const DIA_MS = 24 * 60 * 60 * 1000;

const S = Date.now().toString().slice(-8);
const SUB_EXT = `sub_1BL26Duplicada${S}`;

function correoDeCorrida() {
  const base = process.env.BL26_CORREO_BASE || process.env.BL21_CORREO_BASE;
  if (!base || !base.includes("@")) {
    throw new Error(
      "Falta BL26_CORREO_BASE con un correo tuyo real, p.ej. rsv_gpa@outlook.com.\n" +
        "El spec le agrega +bl26<sello> para que cada corrida sea una cuenta nueva.",
    );
  }
  const [usuario, dominio] = base.split("@");
  return `${usuario}+bl26${S.slice(-6)}@${dominio}`;
}

const ADMIN_CORREO = correoDeCorrida();
const SELLO = Date.now().toString().slice(-6);

/**
 * Teléfono de 10 dígitos EXACTOS (estándar OBS31-08: el backend limpia el
 * formato y rechaza lo que no quede en 10).
 *
 * Se CONSTRUYE para que sume, no se recorta: prefijo (3) + sello (6) +
 * dígito (1) = 10. Es el mismo helper del spec de BL-21, y copiarlo no es
 * pereza: la primera versión de este archivo armaba `55${S}`.slice(0, 10) y
 * salían NUEVE dígitos, con lo que signup-trial devolvía 422. Contar los
 * dígitos del prefijo en vez de los del resultado ya costó tres errores en
 * este proyecto.
 */
const telefono = (prefijo) => `${prefijo}${SELLO}${Math.floor(Math.random() * 10)}`;

// Candado: que un teléfono mal armado se vea aquí y no como un 422 opaco.
for (const t of [telefono("221"), telefono("222")]) {
  if (!/^[0-9]{10}$/.test(t)) {
    throw new Error(`Teléfono de ${t.length} dígitos, deben ser 10 limpios: "${t}"`);
  }
}

/**
 * La forma del payload es la que exige `signup-trial`, copiada del spec de
 * BL-21 en vez de reinventada: pide `workshop.email`, `workshop.address` y
 * `admin.firstSurname`, que la primera versión de este archivo no mandaba.
 */
const TALLER = {
  workshop: {
    name: `Taller BL26 ${SELLO}`,
    email: ADMIN_CORREO,
    address: "Av. de Pruebas 789, Puebla",
    phone: telefono("221"),
  },
  admin: {
    name: "Duplicadas",
    firstSurname: "Veintiseis",
    secondSurname: SELLO,
    email: ADMIN_CORREO,
    phone: telefono("222"),
    password: PASSWORD,
    country: "MX",
  },
  planKey: "basico",
  billingCycle: 0,
};

const ctx = { idWorkshop: null, subOriginal: null, idVieja: null, idNueva: null };

async function api(request, { metodo = "get", ruta, token, body }) {
  const res = await request[metodo](`${API}${ruta}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), json, data: json?.data ?? json };
}

/** El muro cachea 30 s por taller; sin esperar se leería la decisión anterior. */
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

test.describe("BL-26 — con duplicados, el API lee la suscripción MÁS RECIENTE", () => {
  test.beforeAll(() => {
    abortarSiEmuladores();
    console.log(`\n   API bajo prueba: ${API}`);
    if (!API.includes("localhost")) {
      console.log(
        "   ⚠️  Apuntas a un ambiente desplegado. Si BL-26 no está ahí todavía,\n" +
          "      los casos 2 y 3 van a fallar: estarías probando el código viejo.\n",
      );
    }
  });

  test("1) se crea el taller y se PLANTAN dos suscripciones vivas", { tag: ["@api"] }, async ({ request }) => {
    const res = await api(request, { metodo: "post", ruta: "/billing/signup-trial", body: TALLER });
    expect(res.status, `signup-trial respondió ${res.status}: ${JSON.stringify(res.json)}`).toBe(201);

    const idToken = await signIn(ADMIN_CORREO, PASSWORD);
    ctx.idWorkshop = claimsOf(idToken).idWorkshop;
    expect(ctx.idWorkshop, "el claim debe traer el taller recién creado").toBeTruthy();

    // La que nació con el alta: se da de baja para dejar el escenario limpio y
    // que sólo existan las dos plantadas.
    const original = await db()
      .collection("subscriptions")
      .where("idReference", "==", ctx.idWorkshop)
      .where("isDeleted", "==", false)
      .get();
    for (const d of original.docs) {
      ctx.subOriginal = d.id;
      await d.ref.update({ isDeleted: true });
    }

    // Los ids se eligen para que el orden implícito por `__name__` entregue LA
    // RANCIA: es lo que hace la prueba determinista en vez de depender de qué
    // id aleatorio le toque.
    ctx.idVieja = `aaa-bl26-${S}-vieja`;
    ctx.idNueva = `zzz-bl26-${S}-nueva`;

    const comun = {
      idReference: ctx.idWorkshop,
      externalSubscriptionId: SUB_EXT,
      isDeleted: false,
      trialType: "card",
    };

    await db().collection("subscriptions").doc(ctx.idVieja).set({
      ...comun,
      createdAt: new Date(Date.now() - 10 * DIA_MS),
      status: 1,                       // TRIAL
      stripeStatus: "trialing",
      trial_end: new Date(Date.now() - 5 * DIA_MS), // vencido: si se lee ésta, no hay acceso
      plan_name: "basico",
      max_orders: 30,
    });

    await db().collection("subscriptions").doc(ctx.idNueva).set({
      ...comun,
      createdAt: new Date(),
      status: 2,                       // ACTIVE
      stripeStatus: "active",
      current_period_end: new Date(Date.now() + 20 * DIA_MS),
      plan_name: "premium",
      max_orders: 70,
    });

    const vivas = await db()
      .collection("subscriptions")
      .where("idReference", "==", ctx.idWorkshop)
      .where("isDeleted", "==", false)
      .get();
    expect(vivas.size, "el escenario debe quedar con EXACTAMENTE dos duplicadas").toBe(2);
  });

  test("2) /billing/status lee la más reciente, no la que salga primero", { tag: ["@api"] }, async ({ request }) => {
    await esperarCacheDelMuro();
    const token = await signIn(ADMIN_CORREO, PASSWORD);

    const estado = await api(request, { ruta: `/billing/status/${ctx.idWorkshop}`, token });
    expect(estado.status, JSON.stringify(estado.json)).toBe(200);

    expect(
      estado.data?.stripeStatus,
      "BL-26: con dos documentos vivos se está leyendo el RANCIO. El `.limit(1)` " +
        "sin orden entrega el primero por `__name__`, y aquí ese es el viejo.",
    ).toBe("active");
    expect(estado.data?.hasAccess, "y por tanto el taller conserva su acceso").toBe(true);
  });

  test("3) el muro deja pasar: no se corta a quien tiene una suscripción activa", { tag: ["@api"] }, async ({ request }) => {
    const token = await signIn(ADMIN_CORREO, PASSWORD);
    const entradas = await api(request, { ruta: `/entries?idWorkshop=${ctx.idWorkshop}`, token });
    expect(
      entradas.status,
      "leer el documento rancio dejaría FUERA a un taller que está al corriente — " +
        "es el daño real de BL-26, no una molestia cosmética",
    ).toBe(200);
  });

  test("4) el TOPE DE OS del mes sale del plan vigente, no del viejo", { tag: ["@api"] }, async ({ request }) => {
    const token = await signIn(ADMIN_CORREO, PASSWORD);
    const uso = await api(request, { ruta: `/order-limits/usage?idWorkshop=${ctx.idWorkshop}`, token });

    // El endpoint es de staff con CAN_REGISTER_VEHICLE_ENTRY; el Dueño lo tiene.
    expect(uso.status, `order-limits/usage respondió ${uso.status}: ${JSON.stringify(uso.json)}`).toBe(200);

    // Se afirma `baseCap` y NO `limit`: el `limit` ya trae override, tolerancia
    // y deuda encima, así que un fallo ahí no diría si el problema fue el plan
    // o cualquiera de esos ajustes. `baseCap` y `planKey` salen directo de
    // `_getPlanInfo`, que es lo que BL-26 tocó.
    expect(
      uso.data?.planKey,
      "BL-26 en orderLimits._getPlanInfo: con duplicados, el plan lo decidía el " +
        "documento que saliera primero. El vigente es premium.",
    ).toBe("premium");
    expect(
      Number(uso.data?.baseCap),
      "y con él el TOPE DE OS del mes: premium son 70, el rancio daría 30",
    ).toBe(70);
  });

  test("5) ninguna lectura resucita la suscripción dada de baja", { tag: ["@api"] }, async ({ request }) => {
    // No-regresión del filtro `isDeleted` que BL-26 agregó a upsertSubscription
    // y a updateSubscriptionByExternalId.
    const doc = await db().collection("subscriptions").doc(ctx.subOriginal).get();
    expect(doc.exists && doc.data().isDeleted === true, "la dada de baja sigue de baja").toBe(true);

    const token = await signIn(ADMIN_CORREO, PASSWORD);
    const estado = await api(request, { ruta: `/billing/status/${ctx.idWorkshop}`, token });
    expect(estado.data?.stripeStatus, "y el estado sigue saliendo de la vigente").toBe("active");
  });

  test.afterAll(async () => {
    forget(ADMIN_CORREO);
    if (DEJAR_RASTRO) {
      console.log(
        `\n   🧹 Rastro CONSERVADO a petición (BL26_DEJAR_RASTRO=1).\n` +
          `      taller ${ctx.idWorkshop} · subs ${ctx.idVieja}, ${ctx.idNueva}\n` +
          `      Para borrarlo después:\n` +
          `      node scripts/limpiar-talleres-e2e.js ./serviceAccountKey.ccc-taller-refac.json ` +
          `--taller=${ctx.idWorkshop} --apply\n`,
      );
      return;
    }
    console.log("\n   🧹 Limpiando los duplicados plantados…\n");
    for (const id of [ctx.idVieja, ctx.idNueva, ctx.subOriginal]) {
      if (id) await db().collection("subscriptions").doc(id).delete().catch(() => {});
    }
    if (ctx.idWorkshop) await db().collection("workshops").doc(ctx.idWorkshop).delete().catch(() => {});
    const { auth } = require("../../qaAdmin");
    await auth()
      .getUserByEmail(ADMIN_CORREO)
      .then(async (u) => {
        await db().collection("users").doc(u.uid).delete().catch(() => {});
        await auth().deleteUser(u.uid);
      })
      .catch(() => {});
  });
});
