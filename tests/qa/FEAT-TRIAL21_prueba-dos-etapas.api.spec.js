const { test, expect } = require("@playwright/test");
const { db, auth } = require("../../qaAdmin");
const { signIn, claimsOf, forget } = require("../../qaAuth");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FEAT-TRIAL21 — Prueba de dos etapas · PRUEBAS DE API (nuevas, no recicladas)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Cambio que valida: ccc-backend#42 (c059708) + ccc-frontend#48 (2c89780),
 * promovidos a qa-* el 2-sep-2026.
 *
 * Regla del negocio (functions/modules/billing/domain/trial.js):
 *   días 1-14  prueba SIN tarjeta   (trialType "cardless", no existe en Stripe)
 *   día 15     se corta el acceso   (nextStep "register_card")
 *   días 15-21 prueba CON tarjeta   (trialType "card", 7 días de Stripe)
 *   día 22     primer cargo
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *
 *   cd C:\Users\USER\Documents\TRABAJO\ccc-testing
 *   $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"     # el v1 de refac
 *   $env:TRIAL_CORREO_BASE="rsv_gpa@outlook.com"          # TU buzón real
 *   $env:SKIP_SEED="1"                                    # obligatorio: no hay emuladores
 *   npx playwright test --project=qa tests/qa/FEAT-TRIAL21_prueba-dos-etapas.api.spec.js
 *
 * Opcionales:
 *   $env:TRIAL_PLAN="basico"        # basico | premium | master  (default basico)
 *   $env:TRIAL_PASSWORD="Demo1234!" # debe traer mayúscula, minúscula, número y símbolo
 *   $env:TRIAL_LIMPIAR="1"          # borra al final el taller/usuario que creó
 *
 * REQUISITO: `ccc-backend/functions/serviceAccountKey.json` de **refac**
 * (lo usa qaAdmin para leer y mover el documento de `subscriptions`).
 * Si lo tienes en otra ruta: $env:SERVICE_ACCOUNT_KEY="C:\...\serviceAccountKey.json"
 *
 * NO corre contra producción a propósito: qaAdmin solo carga la llave de refac.
 *
 * ⚠️  SIN EMULADORES. Estas pruebas corren contra **refac (QA real)**: es el único
 *     lugar donde el webhook de Stripe puede llegar. Por eso:
 *       · NO levantes los emuladores ni `npm start` del frontend.
 *       · Usa una terminal LIMPIA: si quedaron AUTH_EMU o FIRESTORE_EMULATOR_HOST
 *         de una corrida local, el login se iría al emulador. El spec aborta si
 *         los encuentra.
 *       · `SKIP_SEED="1"` es obligatorio: sin él, el global-setup intenta sembrar
 *         en 127.0.0.1 y truena con ECONNREFUSED antes de correr un solo test.
 *     La API key de Firebase se lee sola de `ccc-frontend/.env`
 *     (REACT_APP_FIREBASE_APIKEY, proyecto ccc-taller-refac).
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "https://v1-hirpfgw7sa-uc.a.run.app/v1";
const PLAN = process.env.TRIAL_PLAN || "basico";
const PASSWORD = process.env.TRIAL_PASSWORD || "Demo1234!";
const LIMPIAR = process.env.TRIAL_LIMPIAR === "1";

const DIA_MS = 24 * 60 * 60 * 1000;

/** Topes de órdenes por plan (plans.catalog.js). El trial NO los quita. */
const TOPE_POR_PLAN = { basico: 30, premium: 70, master: 150 };

/** Correo único por corrida sobre TU buzón: Gmail/Outlook entregan los "+". */
function correoDeCorrida() {
  const base = process.env.TRIAL_CORREO_BASE;
  if (!base || !base.includes("@")) {
    throw new Error(
      "Falta TRIAL_CORREO_BASE con un correo tuyo real, p.ej. rsv_gpa@outlook.com.\n" +
        "El spec le agrega +trialapi<sello> para que cada corrida sea una cuenta nueva.",
    );
  }
  const [usuario, dominio] = base.split("@");
  return `${usuario}+trialapi${Date.now().toString().slice(-6)}@${dominio}`;
}

const SELLO = Date.now().toString().slice(-6);
const ADMIN_CORREO = correoDeCorrida();

/**
 * Teléfono único por corrida. Desde el fix del 27-ago el teléfono es ÚNICO
 * sobre users+clients ("Ese número de teléfono ya está registrado con otro
 * correo"), así que un número fijo hace que la segunda corrida choque con la
 * primera. 10 dígitos, formato mexicano plausible.
 */
const telefono = (prefijo) => `${prefijo}${SELLO}${Math.floor(Math.random() * 10)}`;

const TALLER = {
  workshop: {
    name: `Taller Trial21 ${SELLO}`,
    email: ADMIN_CORREO,
    address: "Av. de Pruebas 123, Puebla",
    phone: telefono("221"),
  },
  admin: {
    name: "Trial",
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

/** Estado compartido entre los tests de este archivo (corren en serie). */
const ctx = { idWorkshop: null, subId: null, trialEndOriginalMs: null, uid: null };

async function api(request, { metodo = "get", ruta, token, body }) {
  const res = await request[metodo](`${API}${ruta}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), json, data: json?.data ?? json };
}

/** El documento vivo de `subscriptions` de ese taller. */
async function subscriptionDe(idWorkshop) {
  const snap = await db()
    .collection("subscriptions")
    .where("idReference", "==", idWorkshop)
    .where("isDeleted", "==", false)
    .limit(1)
    .get();
  return snap.empty ? null : { id: snap.docs[0].id, data: snap.docs[0].data() };
}

/** Firestore devuelve Timestamp, Date o número según cómo se escribió. */
function aMs(valor) {
  if (!valor) return null;
  if (typeof valor === "number") return valor;
  if (valor.toMillis) return valor.toMillis();
  if (valor.toDate) return valor.toDate().getTime();
  return new Date(valor).getTime();
}

async function moverTrialEnd(fecha) {
  await db().collection("subscriptions").doc(ctx.subId).update({ trial_end: fecha });
}


/** Estas pruebas son contra refac: si quedó puesto un emulador, abortar claro. */
function abortarSiEmuladores() {
  const restos = ["AUTH_EMU", "FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST"].filter(
    (v) => process.env[v],
  );
  if (restos.length) {
    throw new Error(
      `Esta prueba corre contra refac (QA real), no contra emuladores, pero la terminal trae ${restos.join(", ")}.\n` +
        "Abre una terminal nueva (o limpia esas variables) y vuelve a correrla.",
    );
  }
}

test.describe.serial("FEAT-TRIAL21 · prueba de dos etapas (API, contra refac)", () => {
  test.beforeAll(abortarSiEmuladores);

  test("1) POST /billing/signup-trial da de alta el taller SIN pedir tarjeta", { tag: ["@api"] }, async ({ request }) => {
    const res = await api(request, { metodo: "post", ruta: "/billing/signup-trial", body: TALLER });

    expect(res.status, `signup-trial respondió ${res.status}: ${JSON.stringify(res.json)}`).toBe(201);

    // El id del taller puede venir con distintos nombres según la capa; lo
    // tomamos de donde esté y, si no viene, lo sacamos del claim más abajo.
    ctx.idWorkshop =
      res.data?.idWorkshop || res.data?.workshopId || res.data?.workshop?.id || res.data?.id || null;

    // La respuesta NO debe traer una URL de checkout: esa es la del alta CON
    // tarjeta (/billing/signup). Si aparece aquí, el alta gratis está mandando
    // a Stripe y el punto entero de la promoción se pierde.
    const crudo = JSON.stringify(res.json || {});
    expect(crudo, "el alta sin tarjeta NO debe devolver una URL de Stripe").not.toMatch(/checkout\.stripe\.com/);
  });

  test("2) el admin puede iniciar sesión y su claim trae el taller", { tag: ["@api"] }, async () => {
    const idToken = await signIn(ADMIN_CORREO, PASSWORD);
    const claims = claimsOf(idToken);

    expect(claims.idWorkshop, "el claim debe traer idWorkshop").toBeTruthy();
    if (ctx.idWorkshop) {
      expect(claims.idWorkshop, "el taller del claim debe ser el que se acaba de crear").toBe(ctx.idWorkshop);
    } else {
      ctx.idWorkshop = claims.idWorkshop;
    }
    // El claim ADMIN es el DUEÑO (ver roles-nombres-claim: SUPER_ADMIN es el Administrador).
    expect(claims.role, "quien se registra queda como Dueño").toBe("ADMIN");
    ctx.uid = claims.user_id || claims.sub || null;
  });

  test("3) en Firestore la suscripción queda cardless, 14 días y SIN nada en Stripe", { tag: ["@api"] }, async () => {
    const sub = await subscriptionDe(ctx.idWorkshop);
    expect(sub, `no encontré la suscripción del taller ${ctx.idWorkshop}`).not.toBeNull();
    ctx.subId = sub.id;

    const d = sub.data;
    expect(d.trialType, "etapa 1 = prueba sin tarjeta").toBe("cardless");
    expect(d.status, "status 1 = Trial").toBe(1);
    expect(d.isTrial).toBe(true);
    expect(d.externalSubscriptionId, "en la etapa 1 no debe existir nada en Stripe").toBeFalsy();
    expect(d.plan_name, "debe respetar el plan elegido").toBe(PLAN);
    expect(d.max_orders, `el tope del plan ${PLAN} aplica durante la prueba, no es ilimitado`).toBe(
      TOPE_POR_PLAN[PLAN],
    );
    expect(d.cardTrialDays, "la etapa 2 son 7 días").toBe(7);

    ctx.trialEndOriginalMs = aMs(d.trial_end);
    const diasRestantes = Math.round((ctx.trialEndOriginalMs - Date.now()) / DIA_MS);
    expect(diasRestantes, `la prueba sin tarjeta debe durar 14 días (calculé ${diasRestantes})`).toBeGreaterThanOrEqual(13);
    expect(diasRestantes).toBeLessThanOrEqual(14);
  });

  test("4) GET /billing/status responde acceso abierto y sin nada pendiente", { tag: ["@api"] }, async ({ request }) => {
    const token = await signIn(ADMIN_CORREO, PASSWORD);
    const res = await api(request, { ruta: `/billing/status/${ctx.idWorkshop}`, token });

    expect(res.status).toBe(200);
    expect(res.data.hasAccess, "con la prueba vigente debe haber acceso").toBe(true);
    expect(res.data.trialType).toBe("cardless");
    expect(res.data.trialDaysLeft, "debe contar los días que faltan").toBeGreaterThan(0);
    expect(res.data.trialDaysLeft, "recién registrado le quedan 14 días").toBeLessThanOrEqual(14);

    // OJO con `nextStep`: durante TODA la etapa sin tarjeta vale "register_card",
    // esté vigente o vencida (BillingService.getBillingStatus: `sinTarjeta ?
    // REGISTER_CARD : ...`). Es coherente —lo que le falta a esa cuenta es
    // registrar tarjeta, y puede hacerlo antes del día 15 conservando los días
    // que le quedan— pero significa que `nextStep` NO distingue "te quedan N
    // días" de "se te acabó". Quien distingue es `hasAccess`. No cambiar esta
    // expectativa a "none" sin cambiar antes el backend.
    expect(res.data.nextStep, "en la etapa sin tarjeta siempre pide tarjeta").toBe("register_card");
    expect(res.data.status, "status 1 = Trial vigente").toBe(1);
  });

  test("5) al vencer la prueba, status cierra el acceso y pide la tarjeta", { tag: ["@api"] }, async ({ request }) => {
    // Simular el día 15: no hay que esperar, se mueve la fecha de fin.
    await moverTrialEnd(new Date(Date.now() - DIA_MS));

    const token = await signIn(ADMIN_CORREO, PASSWORD);
    const res = await api(request, { ruta: `/billing/status/${ctx.idWorkshop}`, token });

    expect(res.status).toBe(200);
    expect(res.data.hasAccess, "con la prueba vencida NO debe haber acceso").toBe(false);
    expect(res.data.status, "status 3 = vencida").toBe(3);
    expect(res.data.nextStep, "sigue siendo registrar tarjeta (igual que vigente)").toBe("register_card");
    expect(res.data.trialDaysLeft, "ya no quedan días que contar").toBeFalsy();
    // Lo ÚNICO que cambia entre vigente y vencida es `hasAccess` (y el status
    // derivado). Es el dato del que debe colgar el muro de la UI.
    expect(res.data.trialType, "sigue siendo la etapa sin tarjeta").toBe("cardless");
  });

  test("6) al devolver la fecha, el acceso se reabre (no se perdió nada)", { tag: ["@api"] }, async ({ request }) => {
    await moverTrialEnd(new Date(ctx.trialEndOriginalMs));

    const token = await signIn(ADMIN_CORREO, PASSWORD);
    const res = await api(request, { ruta: `/billing/status/${ctx.idWorkshop}`, token });

    expect(res.data.hasAccess, "el taller vuelve a entrar y conserva sus datos").toBe(true);
    expect(res.data.status, "vuelve a estar en Trial vigente").toBe(1);
    expect(res.data.trialDaysLeft, "y vuelve a contar los días").toBeGreaterThan(0);
    // Sigue siendo "register_card": mientras la etapa sea sin tarjeta, ese es
    // el paso pendiente (ver el comentario del caso 4). El acceso lo dice hasAccess.
    expect(res.data.nextStep).toBe("register_card");
  });

  test("7) el mismo correo no puede registrarse dos veces", { tag: ["@api"] }, async ({ request }) => {
    const res = await api(request, { metodo: "post", ruta: "/billing/signup-trial", body: TALLER });

    expect(res.status, "un correo repetido no debe crear un segundo taller").toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.json), "debe decir que ya existe la cuenta").toMatch(/ya existe|EMAIL_EXISTS|inicia sesión/i);
  });

  test("8) un plan inventado se rechaza", { tag: ["@api"] }, async ({ request }) => {
    const res = await api(request, {
      metodo: "post",
      ruta: "/billing/signup-trial",
      body: { ...TALLER, planKey: "plan-que-no-existe", admin: { ...TALLER.admin, email: correoDeCorrida() } },
    });

    expect(res.status, "no debe aceptar un plan que no está en el catálogo").toBeGreaterThanOrEqual(400);
  });

  test("9) EL MURO: con la prueba vencida, el API responde 402 (BL-19)", { tag: ["@api", "@brecha"] }, async ({ request }) => {
    // Se vence otra vez: el caso 6 devolvió la fecha a su lugar.
    await moverTrialEnd(new Date(Date.now() - DIA_MS));

    const token = await signIn(ADMIN_CORREO, PASSWORD);
    const res = await api(request, { ruta: `/clients?idWorkshop=${ctx.idWorkshop}`, token });

    // BL-19. Este test nació en rojo el 2-sep (el API respondía 200: el muro
    // vivía solo en el frontend) y es el que cierra el ticket cuando pasa.
    // Lo hace pasar `middlewares/requireActiveSubscription.middleware.js`,
    // montado en los routers de negocio de routes/V1/index.js.
    //
    // NO lo "arregles" cambiando la expectativa a 200: eso reabre la puerta.
    expect(
      res.status,
      "el backend debe responder 402 cuando la prueba venció; 200 = el muro es solo de UI (brecha confirmada el 2-sep)",
    ).toBe(402);
    expect(res.json?.data?.nextStep).toBe("register_card");
  });


  test("10) NO-REGRESIÓN: un taller PAGADO no se ve afectado por el muro", { tag: ["@api", "@lento"] }, async ({ request }) => {
    // El riesgo real de BL-19 no es dejar pasar de más, es bloquear de más: si
    // el muro se equivoca, deja fuera a quien SÍ paga. Aquí se convierte el
    // taller de prueba en uno pagado y se comprueba que vuelve a entrar.
    await db().collection("subscriptions").doc(ctx.subId).update({
      status: 2, // Active
      isTrial: false,
      trialType: "card",
      externalSubscriptionId: "sub_de_prueba_no_existe_en_stripe",
      current_period_end: new Date(Date.now() + 30 * DIA_MS),
    });

    // El muro cachea el estado 30 s por instancia (ver TTL_MS del middleware),
    // así que hay que darle tiempo a que expire lo que quedó del caso 9.
    const token = await signIn(ADMIN_CORREO, PASSWORD);
    let res = null;
    for (let i = 0; i < 10; i++) {
      res = await api(request, { ruta: `/clients?idWorkshop=${ctx.idWorkshop}`, token });
      if (res.status === 200) break;
      await new Promise((r) => setTimeout(r, 5000));
    }

    expect(
      res.status,
      "un taller con suscripción activa debe seguir trabajando; si sale 402, el muro bloquea de más",
    ).toBe(200);
  });

  test.afterAll(async () => {
    forget(ADMIN_CORREO);
    if (!LIMPIAR) {
      console.log(
        `\n   ℹ️  Taller de prueba conservado: ${ADMIN_CORREO} (taller ${ctx.idWorkshop}).\n` +
          `      Para que el spec lo borre solo:  $env:TRIAL_LIMPIAR="1"\n`,
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
