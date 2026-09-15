// `request` es un fixture de test: no llega a un beforeAll de archivo. Para
// el alta se abre un contexto propio con `peticiones.newContext()`.
const { test, expect, request: peticiones } = require("@playwright/test");
const { db, auth } = require("../../qaAdmin");
const { signIn, claimsOf, forget, apiKeyPublica } = require("../../qaAuth");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-20 — Verificar el correo del admin del taller y condicionar el ALTA DE
 *         LA SUSCRIPCIÓN a esa verificación  ·  PRUEBAS DE API (en ROJO)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Hermano del unitario `ccc-backend/functions/tests/BL-20_verificacion-correo-admin.unit.test.js`,
 * pero NO lo repite: aquel observa el servicio con dobles (que se mande el
 * correo, que el checkout se niegue sin tocar la pasarela). Este mide lo que
 * un taller vive de verdad contra refac — Auth real, Firestore real, HTTP
 * real — y sobre todo cubre la parte que el unitario no puede tocar: el
 * CAMBIO DE CORREO, que vive en Firebase Auth y no en BillingService.
 *
 * ── LA REGLA DE NEGOCIO (Enrique, 2-sep · confirmada el 14-sep) ────────────
 *
 * El taller se registra con el correo que quiera — falso incluido. Cero
 * fricción, 14 días. Usa la app normal, con un aviso de que le falta
 * confirmar. El muro aparece SOLO cuando va a pagar, y la misma pantalla le
 * da las dos salidas:
 *
 *      reenviar  (se perdió en spam)      cambiar el correo  (lo tecleó mal)
 *
 * Esa segunda salida es la que de verdad importa: la causa número uno de no
 * recibir el correo es haberlo escrito mal, y contra eso reenviar no sirve —
 * manda el mensaje al mismo buzón equivocado. Por eso cambiar el correo NO
 * exige tener verificado el anterior: exigirlo encierra justo al caso que
 * BL-20 existe para resolver.
 *
 * ⚠️ **Lo que BL-20 NO es.** No es una defensa contra cuentas basura, y el
 * spec no debe escribirse como si lo fuera. Quien crea cuentas basura no
 * quiere pagar, así que nunca llega al muro; y con los alias `+` un solo
 * buzón real da cuentas verificables infinitas (BL-22 existió para que el `+`
 * funcionara). Lo que BL-20 garantiza es otra cosa, más modesta y más útil:
 * **todo taller que PAGA tiene un correo que existe y que alguien lee** — ahí
 * llegan las facturas, los avisos de cobro y el enlace de recuperación.
 *
 * ── EL CAMBIO DE CORREO SE APOYA EN AUTH, NO SE INVENTA ───────────────────
 *
 * `admin.auth().generateVerifyAndChangeEmailLink(actual, nuevo)` (existe en
 * firebase-admin 12.7.0, el que ya usa el backend) hace exactamente lo que
 * pide la regla: manda el enlace al correo NUEVO y, al confirmarlo, Auth
 * cambia el correo y lo marca verificado. Mientras tanto el anterior sigue
 * vigente. No hay que inventar máquina de estados: `pendingEmail` en
 * `users/{uid}` es solo para que la pantalla pueda decir "te falta confirmar
 * tal correo".
 *
 * ── QUÉ SE ESPERA HOY, ANTES DEL ARREGLO ──────────────────────────────────
 *
 *   1  VERDE  el alta deja al admin SIN verificar y CON acceso (ya es así)
 *   2  ROJO   el checkout no mira la verificación: deja abrir la sesión de pago
 *   3  VERDE  /public/resend-verification ya existe (la salida "se perdió")
 *   4  ROJO   no hay endpoint de cambio de correo (404)
 *   5  ROJO   ni el trato no-oraculo de un correo ya registrado
 *   6  ROJO   ni la sincronización de `users` cuando el cambio entra en vigor
 *   7  VERDE  con el correo verificado el checkout procede (debe SEGUIR verde)
 *
 * El caso 7 es el que protege al taller que sí puede pagar: si el arreglo lo
 * pone en rojo, el muro quedó de más y hay que rehacerlo.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"
 *   $env:AUTH_REAL="1"; $env:SKIP_SEED="1"
 *   $env:BL20_CORREO_BASE='rsv_gpa@outlook.com'
 *   npx playwright test --project=qa tests/qa/BL-20_verificacion-correo-admin.api.spec.js
 *
 * Da de alta UN taller nuevo por corrida (etapa sin tarjeta, sin tocar la
 * pasarela) con alias `+bl20<sello>`. Para que se borre solo al terminar:
 *   $env:BL20_LIMPIAR="1"     ← recomendado SIEMPRE, ver el aviso de abajo
 *
 * El caso 5 necesita además un correo YA registrado; por omisión usa
 * BL20_CORREO_BASE sin alias (el Dueño de refac) y NO le toca nada. Si ese no
 * existiera, pásale otro con BL20_CORREO_OCUPADO.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "https://v1-hirpfgw7sa-uc.a.run.app/v1";
const PLAN = process.env.BL20_PLAN || "basico";
const PASSWORD = process.env.BL20_PASSWORD || "Demo1234!";
const LIMPIAR = process.env.BL20_LIMPIAR === "1";

function correoDeCorrida(etiqueta) {
  const base = process.env.BL20_CORREO_BASE || process.env.TRIAL_CORREO_BASE;
  if (!base || !base.includes("@")) {
    throw new Error(
      "Falta BL20_CORREO_BASE con un correo tuyo real, p.ej. rsv_gpa@outlook.com.\n" +
        "El spec le agrega +bl20<sello> para que cada corrida sea una cuenta nueva.",
    );
  }
  const [usuario, dominio] = base.split("@");
  return `${usuario}+${etiqueta}${Date.now().toString().slice(-6)}@${dominio}`;
}

const SELLO = Date.now().toString().slice(-6);
const CORREO_MALO = correoDeCorrida("bl20malo"); // el que "tecleó mal" al registrarse
const CORREO_BUENO = correoDeCorrida("bl20bueno"); // al que se quiere cambiar
// Una cuenta que YA existe en refac, para el caso de unicidad. Por omisión el
// propio correo base sin alias (es el Dueño de refac). No se le toca nada.
const CORREO_OCUPADO =
  process.env.BL20_CORREO_OCUPADO || process.env.BL20_CORREO_BASE || process.env.TRIAL_CORREO_BASE;

/** 10 dígitos exactos (estándar OBS31-08) y únicos por corrida. */
const telefono = (prefijo) => `${prefijo}${SELLO}${Math.floor(Math.random() * 10)}`;

const TALLER = {
  workshop: {
    name: `Taller BL20 ${SELLO}`,
    email: CORREO_MALO,
    address: "Av. de Pruebas 789, Puebla",
    phone: telefono("221"),
  },
  admin: {
    name: "Verificacion",
    firstSurname: "Veinte",
    secondSurname: SELLO,
    email: CORREO_MALO,
    phone: telefono("222"),
    password: PASSWORD,
    country: "MX",
  },
  planKey: PLAN,
  billingCycle: 0,
};

const ctx = { idWorkshop: null, uid: null, correoVigente: CORREO_MALO, ajeno: null };

async function api(request, { metodo = "get", ruta, token, body }) {
  const res = await request[metodo](`${API}${ruta}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), json, data: json?.data ?? json };
}

/** Todo el texto de error de una respuesta, venga por donde venga. */
const textoDeError = (json) =>
  [
    json?.descripcion,
    json?.message,
    ...(Array.isArray(json?.errors) ? json.errors.map((e) => e?.message) : []),
  ]
    .filter(Boolean)
    .join(" · ");

/** Código de negocio del error, en cualquiera de los lugares donde vive. */
const codigoDe = (r) => r?.json?.data?.code || r?.json?.code || r?.data?.code || null;

const usuarioEnAuth = (correo) => auth().getUserByEmail(correo).catch(() => null);
const docDeUsuario = async (uid) => (await db().collection("users").doc(uid).get()).data() || {};

/**
 * Simula el clic del dueño en "confirma tu correo nuevo".
 *
 * `generateVerifyAndChangeEmailLink` devuelve el enlace que Firebase mandaría
 * al buzón NUEVO; aplicar su oobCode es lo que hace el cambio efectivo. Es el
 * equivalente exacto de lo que hará el usuario, no un atajo por Admin: si el
 * backend no dejó la cuenta en el estado correcto, esto falla igual que le
 * fallaría a él.
 */
async function confirmarCambioDeCorreo(correoActual, correoNuevo) {
  const enlace = await auth().generateVerifyAndChangeEmailLink(correoActual, correoNuevo);
  const oobCode = new URL(enlace).searchParams.get("oobCode");
  if (!oobCode) throw new Error(`No pude extraer el oobCode del enlace de cambio para ${correoNuevo}`);

  const key = process.env.FIREBASE_API_KEY || apiKeyPublica?.();
  if (!key) throw new Error("Falta la API key web para confirmar el cambio (FIREBASE_API_KEY).");

  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:update?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oobCode }),
  });
  if (!res.ok) throw new Error(`La confirmación del cambio falló (${res.status}): ${await res.text()}`);
  return res.json();
}

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

/**
 * El alta vive en el beforeAll, no en el caso 1, y los casos van en DOS
 * describes. La razon la dio la primera corrida (14-sep): con todo el archivo
 * en `mode: "serial"`, el rojo esperado del caso 2 salto los cinco restantes
 * y la corrida no dijo nada de lo que de verdad hacia falta. Un spec de
 * reproduccion tiene que entregar el MAPA completo, no el primer obstaculo.
 *
 *   · "estado inicial y muro" (1, 2, 3): independientes entre si. Que el muro
 *     no exista no impide medir si la salida de reenvio ya esta.
 *   · "cambio de correo" (4-7): encadenados de verdad. Si el 4 esta en rojo
 *     los siguientes se saltan A PROPOSITO: sin el endpoint no hay nada que
 *     medir, y correrlos solo produciria ruido.
 *
 * ⚠️ EFECTO SECUNDARIO, y NO es un bug del producto: Playwright RECICLA el
 * worker despues de cada fallo. El worker nuevo vuelve a evaluar este modulo
 * -> nuevo SELLO, nuevos correos, y el beforeAll da de alta OTRO taller. En
 * una corrida con dos grupos en rojo veras DOS altas y dos talleres. Cada
 * grupo queda coherente consigo mismo (usa el taller de su propio worker) y
 * el afterAll de cada worker limpia lo suyo, asi que:
 *
 *      corre esto SIEMPRE con  $env:BL20_LIMPIAR="1"
 *
 * o iras dejando un taller por grupo en rojo, corrida tras corrida. Con el
 * archivo entero en `mode: "serial"` esto no pasaba, pero tampoco se veia mas
 * que el primer obstaculo; se eligio ver el mapa y pagar la limpieza.
 */
let http;

test.beforeAll(async () => {
  abortarSiEmuladores();
  console.log(`\n   API bajo prueba: ${API}`);
  console.log(`   Correo "mal tecleado": ${CORREO_MALO}`);
  console.log(`   Correo al que se cambia: ${CORREO_BUENO}\n`);
  if (!API.includes("localhost") && !API.includes("127.0.0.1")) {
    // ⚠️ LA TRAMPA DEL DEPLOY-DESDE-RAMA (volvió a morder el 14-sep).
    // Un ambiente desplegado corre lo que esté MERGEADO Y SUBIDO, no tu rama.
    // Si BL-20 vive solo en `feat/bl20-...` sin desplegar, los casos 2 y 4 salen
    // en rojo diciendo "no está implementado" — y no lo está: ahí no. Para probar
    // LA RAMA se levanta el backend en local contra Firestore/Auth reales de
    // refac, igual que se hizo con BL-21:
    //
    //   terminal 1 (ccc-backend/functions):  npm run dev
    //   terminal 2 (ccc-testing):            $env:API="http://localhost:3001/v1"
    //                                        $env:AUTH_REAL="1"
    console.log(
      "   ⚠️  Estás apuntando a un ambiente DESPLEGADO. Si BL-20 solo vive en tu rama,\n" +
        "      los casos 2 y 4-7 fallarán: estarías probando el código viejo.\n" +
        "      Para probar la rama: backend local + API=http://localhost:3001/v1 con AUTH_REAL=1\n" +
        "      (Firestore y Auth siguen siendo los de refac).\n",
    );
  }

  http = await peticiones.newContext();
  const res = await api(http, { metodo: "post", ruta: "/billing/signup-trial", body: TALLER });
  if (res.status !== 201) {
    throw new Error(`No pude dar de alta el taller de prueba (${res.status}): ${JSON.stringify(res.json)}`);
  }
  const claims = claimsOf(await signIn(CORREO_MALO, PASSWORD));
  ctx.idWorkshop = claims.idWorkshop;
  ctx.uid = claims.user_id || claims.sub || null;
});

test.describe("BL-20 · estado inicial y muro del checkout", () => {
  test("1) el alta deja al admin SIN verificar, pero CON acceso", { tag: ["@api"] }, async ({ request }) => {
    const idToken = await signIn(CORREO_MALO, PASSWORD);
    expect(ctx.idWorkshop, "el claim debe traer el taller recién creado").toBeTruthy();

    const user = await usuarioEnAuth(CORREO_MALO);
    expect(user, "el admin debe existir en Auth").not.toBeNull();
    expect(
      user.emailVerified,
      "nace SIN verificar: el alta no comprueba el correo, solo manda el enlace",
    ).toBe(false);

    // La regla, textual: durante la prueba NO se le corta el acceso por esto.
    const entradas = await api(request, { ruta: `/entries?idWorkshop=${ctx.idWorkshop}`, token: idToken });
    expect(
      entradas.status,
      "sin verificar puede usar la app durante la prueba; cortar aquí sería otro producto",
    ).toBe(200);
  });

  test("2) el checkout se NIEGA mientras el correo no esté verificado", { tag: ["@api"] }, async ({ request }) => {
    const token = await signIn(CORREO_MALO, PASSWORD);
    const res = await api(request, {
      metodo: "post",
      ruta: "/billing/checkout-session",
      token,
      body: { idWorkshop: ctx.idWorkshop, planKey: PLAN, billingCycle: 0 },
    });

    expect(
      res.status,
      `el alta de la suscripción exige correo verificado. Llegó ${res.status}: ${textoDeError(res.json)}`,
    ).toBe(409);
    expect(codigoDe(res), "el front necesita distinguir esto de cualquier otro 409").toBe("EMAIL_NOT_VERIFIED");

    // ⚠️ AL IMPLEMENTAR: este error NO puede pasar por `errorResponse`.
    // El helper normaliza `errors` a [{message}] y se lleva por delante
    // cualquier dato de negocio — está documentado en billing.router.js:36
    // (backlog n10, el auto-login que perdía su `code`). `EMAIL_NOT_VERIFIED`
    // tiene que responder el JSON crudo, como CODIGOS_AUTOLOGIN:
    //   { status, descripcion, errors, code, email, canResend }
    // Si se "arregla" pasándolo por el helper, estos dos asserts caen y la
    // pantalla se queda sin saber a qué buzón reenviar.
    const cuerpo = { ...(res.json || {}), ...(res.json?.data || {}) };
    expect(cuerpo.email, "el error dice a qué buzón se mandó, para poder ofrecer reenviar").toBe(CORREO_MALO);
    expect(cuerpo.canResend, "y que el reenvío es posible").toBe(true);

    expect(
      res.json?.data?.url || res.json?.url,
      "y NO se abre sesión de pago: si hay URL, el muro no sirvió de nada",
    ).toBeFalsy();
  });

  test("3) SALIDA A: reenviar la verificación ya existe y no es un oráculo", { tag: ["@api"] }, async ({ request }) => {
    const res = await api(request, {
      metodo: "post",
      ruta: "/public/resend-verification",
      body: { email: CORREO_MALO },
    });
    expect(res.status, "la ruta de reenvío ya existe desde antes de BL-20").toBe(200);

    // Respuesta idéntica para un correo que no existe: no se puede usar para
    // averiguar quién está registrado.
    const fantasma = await api(request, {
      metodo: "post",
      ruta: "/public/resend-verification",
      body: { email: `noexiste.bl20.${SELLO}@ccc.test` },
    });
    expect(fantasma.status, "mismo estado para un correo inexistente").toBe(200);
    expect(
      JSON.stringify(fantasma.json?.descripcion || ""),
      "y mismo mensaje: si difieren, la ruta delata qué correos existen",
    ).toBe(JSON.stringify(res.json?.descripcion || ""));
  });

});

test.describe.serial("BL-20 · cambio de correo", () => {
  test("4) SALIDA B: pedir el cambio de correo NO exige tener verificado el actual", { tag: ["@api"] }, async ({ request }) => {
    const token = await signIn(CORREO_MALO, PASSWORD);
    const res = await api(request, {
      metodo: "post",
      ruta: "/users/me/email-change",
      token,
      body: { email: CORREO_BUENO },
    });

    expect(
      res.status,
      `pedir el cambio debe poderse SIN el actual verificado — es el caso del correo mal tecleado, ` +
        `el que BL-20 existe para resolver. Llegó ${res.status}: ${textoDeError(res.json)}`,
    ).toBe(200);

    // Lo pedido queda registrado para que la pantalla pueda decirlo...
    const doc = await docDeUsuario(ctx.uid);
    expect(doc.pendingEmail, "la pantalla necesita saber qué correo está pendiente de confirmar").toBe(CORREO_BUENO);

    // ...pero NADA cambia todavía. Si el correo cambiara al pedirlo, un dedazo
    // dejaría al dueño fuera de su propia cuenta — que es peor que el bug.
    const user = await usuarioEnAuth(CORREO_MALO);
    expect(user, "el correo anterior sigue siendo la identidad hasta que se confirme el nuevo").not.toBeNull();
    expect(doc.email, "y `users` tampoco se adelanta").toBe(CORREO_MALO);

    const sesion = await signIn(CORREO_MALO, PASSWORD).catch(() => null);
    expect(sesion, "y puede seguir entrando con el correo viejo").toBeTruthy();
  });

  test("5) pedir un correo que ya es de otra cuenta NO lo delata (y no cambia nada)", { tag: ["@api"] }, async ({ request }) => {
    // El correo "ocupado" es una cuenta que YA existe en refac — el mismo
    // BL20_CORREO_BASE, sin alias. No se da de alta un segundo taller solo
    // para esto: cada alta deja taller + usuario + suscripción de basura, y
    // ya hay ~9 talleres de corridas e2e sin limpiar. Nada se le toca.
    const ajeno = CORREO_OCUPADO;
    const dueno = await usuarioEnAuth(ajeno);
    test.skip(
      !dueno,
      `Para este caso hace falta un correo YA registrado en refac. ${ajeno} no existe: ` +
        `pasa BL20_CORREO_OCUPADO con una cuenta real.`,
    );

    const token = await signIn(CORREO_MALO, PASSWORD);
    const res = await api(request, {
      metodo: "post",
      ruta: "/users/me/email-change",
      token,
      body: { email: ajeno },
    });

    // ⚠️ EL CONTRATO CAMBIÓ el 15-sep, y a mejor: esta ruta NO DELATA que el
    // correo ya existe. Antes respondía 409 EMAIL_EXISTS, y eso la convertiía
    // en un buscador de cuentas ajenas — con cualquier sesión se sondea correo
    // por correo y se averigua quién está registrado en CCC. Es el mismo
    // criterio no-oráculo de /public/forgot y /public/resend-verification.
    //
    // La unicidad SIGUE respetándose: simplemente no se manda el enlace, y sin
    // enlace no hay cambio. Quien reciba un correo que no pidió, lo ignora.
    expect(res.status, "responder distinto aquí delataría quién tiene cuenta").toBe(200);
    expect(codigoDe(res), "y sin código de error que lo delate").toBeNull();

    const doc = await docDeUsuario(ctx.uid);
    // El estado observable también tiene que ser el mismo: si `pendingEmail`
    // solo se guardara cuando el correo está libre, bastaría leer el propio
    // perfil para saberlo y el oráculo volvería por la puerta de atrás.
    expect(doc.pendingEmail, "el pendiente se guarda igual, exista o no el correo").toBe(ajeno);

    // Y lo que de verdad importa: NADA cambió en la cuenta ajena ni en la propia.
    const duenoAjeno = await usuarioEnAuth(ajeno);
    expect(duenoAjeno.uid, "la cuenta ajena queda intacta").toBe(dueno.uid);
    const propia = await usuarioEnAuth(CORREO_MALO);
    expect(propia, "y el correo propio sigue siendo el de siempre").not.toBeNull();
  });

  test("5-bis) se vuelve a pedir el correo bueno, para dejar el pendiente correcto", { tag: ["@api"] }, async ({ request }) => {
    // El caso 5 dejo `pendingEmail` apuntando al correo ajeno (a proposito: el
    // estado no puede delatar nada). Antes de confirmar hay que volver a pedir
    // el bueno, que es lo que haria el dueno al ver que no le llego nada.
    const token = await signIn(CORREO_MALO, PASSWORD);
    const res = await api(request, {
      metodo: "post",
      ruta: "/users/me/email-change",
      token,
      body: { email: CORREO_BUENO },
    });
    expect(res.status).toBe(200);
    const doc = await docDeUsuario(ctx.uid);
    expect(doc.pendingEmail).toBe(CORREO_BUENO);
  });

  test("6) al confirmar, el correo nuevo entra en vigor y `users` queda sincronizado", { tag: ["@api"] }, async ({ request }) => {
    await confirmarCambioDeCorreo(CORREO_MALO, CORREO_BUENO);
    ctx.correoVigente = CORREO_BUENO;
    forget(CORREO_MALO);

    // ⚠️ Firebase NO avisa a nadie cuando el usuario confirma: no hay webhook
    // de Auth. Así que Firestore se entera en la siguiente lectura del PERFIL
    // PROPIO, comparando el correo del token contra `users` — el mismo
    // auto-sanado de BL-21, y ahí sale gratis porque el documento ya se leyó y
    // el correo viene dentro del ID token. Por eso aquí se inicia sesión y se
    // pide el perfil ANTES de comprobar: es exactamente lo que hace el front al
    // entrar. Exigir la sincronización sin darle ocasión de ocurrir sería un
    // rojo imposible de cerrar, y el spec estaría mintiendo sobre el bug.
    const token = await signIn(CORREO_BUENO, PASSWORD);
    const perfil = await api(request, { ruta: `/users/${ctx.uid}`, token });
    expect(perfil.status, "la lectura del perfil propio es la que sincroniza").toBe(200);

    const user = await usuarioEnAuth(CORREO_BUENO);
    expect(user, "Auth debe tener ya el correo nuevo").not.toBeNull();
    expect(
      user.emailVerified,
      "confirmarlo ES verificarlo: el dueño acaba de demostrar que lee ese buzón",
    ).toBe(true);

    const viejo = await usuarioEnAuth(CORREO_MALO);
    expect(viejo, "y el anterior deja de existir como identidad").toBeNull();

    // Aquí está el trabajo que NO hace Auth: Firestore no se entera solo. Sin
    // esto, `users.email` se queda con el correo malo para siempre y las
    // pantallas del taller siguen mostrándolo.
    const doc = await docDeUsuario(ctx.uid);
    expect(doc.email, "`users` tiene que seguir a Auth, o quedan dos verdades").toBe(CORREO_BUENO);
    expect(doc.pendingEmail || null, "y el pendiente se limpia al cumplirse").toBeNull();
  });

  test("7) NO-REGRESIÓN: con el correo verificado, el checkout procede", { tag: ["@api"] }, async ({ request }) => {
    const token = await signIn(CORREO_BUENO, PASSWORD);
    const res = await api(request, {
      metodo: "post",
      ruta: "/billing/checkout-session",
      token,
      body: { idWorkshop: ctx.idWorkshop, planKey: PLAN, billingCycle: 0 },
    });

    expect(
      res.status,
      `este es el caso que el muro NO puede romper: el taller que sí quiere pagar. ` +
        `Llegó ${res.status}: ${textoDeError(res.json)}`,
    ).toBe(201);
    expect(res.json?.data?.url || res.json?.url, "debe devolver la URL de la pasarela").toBeTruthy();
  });

});

test.afterAll(async () => {
  if (http) await http.dispose().catch(() => {});
  forget(CORREO_MALO);
    forget(CORREO_BUENO);
    if (ctx.ajeno) forget(ctx.ajeno);

    if (!LIMPIAR) {
      console.log(
        `\n   ℹ️  Talleres de prueba conservados: ${ctx.correoVigente}` +
          `${ctx.ajeno ? ` y ${ctx.ajeno}` : ""} (taller ${ctx.idWorkshop}).\n` +
          `      Para que el spec los borre solo:  $env:BL20_LIMPIAR="1"\n`,
      );
      return;
    }
    // Se borra SOLO lo que este spec creó: los correos llevan el sello de la
    // corrida, así que no hay forma de llevarse por delante algo ajeno.
    for (const correo of [CORREO_MALO, CORREO_BUENO, ctx.ajeno].filter(Boolean)) {
      try {
        const user = await usuarioEnAuth(correo);
        if (!user) continue;
        const doc = await docDeUsuario(user.uid);
        if (doc.idWorkshop) {
          await db().collection("workshops").doc(doc.idWorkshop).delete().catch(() => {});
          const subs = await db()
            .collection("subscriptions")
            .where("idReference", "==", doc.idWorkshop)
            .get();
          await Promise.all(subs.docs.map((d) => d.ref.delete().catch(() => {})));
        }
        await db().collection("users").doc(user.uid).delete().catch(() => {});
        await auth().deleteUser(user.uid);
      } catch (e) {
        console.log(`\n   ⚠️  No pude limpiar ${correo} (${e.message}). Revísalo a mano.\n`);
      }
    }
    console.log(`\n   🧹 Limpieza hecha.\n`);
  });
