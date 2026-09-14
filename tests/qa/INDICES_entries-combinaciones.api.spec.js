const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");
const { signIn } = require("../../qaAuth");
const { db: qaDb, auth: qaAdminAuth } = require("../../adminFlex");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ÍNDICES — las 24 combinaciones que `getEntries()` puede armar  @api
 * SPEC DE VERIFICACIÓN (nuevo) — punto 16 del BACKLOG_TECNICO, la barrida
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── QUÉ PRUEBA, Y POR QUÉ ES DISTINTO A TODO LO DEMÁS ─────────────────────
 *
 * No prueba lógica de negocio: prueba que EXISTA el índice compuesto de cada
 * consulta que el listado de OS puede construir. Por eso:
 *
 *   · **No necesita datos sembrados.** Firestore rechaza una consulta sin
 *     índice ANTES de mirar si hay documentos: un taller vacío da 200 con
 *     cero resultados, y un índice ausente da 500 con `FAILED_PRECONDITION`
 *     aunque no haya un solo auto. Un verde aquí significa "el índice está",
 *     nunca "había datos".
 *   · **Solo vale contra refac o prod.** Los emuladores de Firestore NO
 *     exigen índices compuestos (catch-mudo-listados.md): contra localhost
 *     este spec sale verde SIEMPRE y no prueba nada. Si `API` apunta a
 *     localhost, el spec se salta a sí mismo en vez de mentir.
 *
 * ── DE DÓNDE SALEN LAS 24 ─────────────────────────────────────────────────
 *
 * `entries.service.js:434 getEntries()` arma la consulta así:
 *
 *   base fija     : isDeleted == false  +  idWorkshop == X
 *   opcionales    : assigned_mechanic · status · statusService · approvalState
 *   orden         : createdAt desc  —  o  deliveredAt asc|desc, SOLO cuando
 *                   statusService == ENTREGADO y NO hay filtro de mecánico
 *                   (lista blanca de entries.service.js:443)
 *
 * → 2⁴ = 16 combinaciones con createdAt desc, más 4 combinaciones de
 *   entregados × 2 direcciones = 8. Total 24.
 *
 * `status`, `statusService` y `approvalState` llegan por `req.query`
 * (routes/V1/entries.js:525): cualquier cliente puede mandar cualquier
 * combinación, use o no la pantalla de hoy. `assigned_mechanic` NO: lo fuerza
 * el backend cuando el token es de un Mecánico. De ahí que las 12
 * combinaciones con mecánico exijan un token de Mecánico de verdad —
 * mandarlo por query no reproduce nada.
 *
 * ── POR QUÉ ESTE SPEC EXISTE ──────────────────────────────────────────────
 *
 * El 27-ago se desplegaron 15 índices y el ticket 16 se dio por cerrado del
 * lado del código, dejando escrita "la barrida completa" como pendiente. Al
 * medirla el 14-sep resultó que de las 24 combinaciones solo 12 estaban
 * declaradas. Las otras 12 no fallan en local (emuladores), no fallan en las
 * pantallas que nadie usa con dos filtros a la vez, y cuando fallan lo hacen
 * con un 500 en la cara del Mecánico — que es exactamente cómo nació el
 * ticket 16.
 *
 * ── CÓMO SE LEE EL RESULTADO ──────────────────────────────────────────────
 *
 * Cada caso recorre su lote COMPLETO antes de fallar y lista de un tirón lo
 * que encontró, separando ÍNDICE QUE FALTA de ÍNDICE EN CONSTRUCCIÓN —
 * Firestore usa el mismo error para los dos y confundirlos manda a alguien a
 * re-desplegar un archivo que ya estaba bien. Con el enlace de consola que
 * regala en el mensaje. Así una corrida da la lista entera, en vez de una
 * combinación por corrida.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"
 *   $env:AUTH_REAL="1"; $env:SKIP_SEED="1"
 *   $env:ID_WORKSHOP="G85FhlhedkD4L4CEDWvW"
 *   $env:SEED_EMAIL="<Dueño o Admin>"; $env:SEED_PASSWORD="..."
 *   # las 8 del Mecánico NO necesitan credenciales: contra refac el spec crea
 *   # un mecánico de usar y tirar y lo borra al terminar. Solo si quieres usar
 *   # una cuenta concreta (o corres contra PROD, donde nunca se crea nada):
 *   $env:MECHANIC_EMAIL="<Mecánico>"; $env:MECHANIC_PASSWORD="..."
 *   npx playwright test --project=qa tests/qa/INDICES_entries-combinaciones.api.spec.js
 *
 * No escribe nada: son 24 GET. Se puede correr contra prod sin ensuciar.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP;
const ES_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(API);

// Valores concretos; da igual si existen documentos con ellos (ver encabezado).
const STATUS = 6;
const ETAPA = "EN REPARACION";
const ENTREGADO = "ENTREGADO";
const APROBACION = "APROBADA";

/** Las 12 combinaciones que NO llevan filtro de mecánico. */
const SIN_MECANICO = [
  { nombre: "sin filtros", q: {} },
  { nombre: "status", q: { status: STATUS } },
  { nombre: "etapa", q: { statusService: ETAPA } },
  { nombre: "aprobación", q: { approvalState: APROBACION } },
  { nombre: "status + etapa", q: { status: STATUS, statusService: ETAPA } },
  { nombre: "status + aprobación", q: { status: STATUS, approvalState: APROBACION } },
  { nombre: "etapa + aprobación", q: { statusService: ETAPA, approvalState: APROBACION } },
  { nombre: "status + etapa + aprobación", q: { status: STATUS, statusService: ETAPA, approvalState: APROBACION } },
];

/** Vehículos entregados: deliveredAt en las dos direcciones. */
const ENTREGADOS = [];
for (const dir of ["desc", "asc"]) {
  ENTREGADOS.push(
    { nombre: `entregados, ${dir}`, q: { statusService: ENTREGADO, sortBy: "deliveredAt", sortDir: dir } },
    { nombre: `entregados + status, ${dir}`, q: { statusService: ENTREGADO, status: STATUS, sortBy: "deliveredAt", sortDir: dir } },
    { nombre: `entregados + aprobación, ${dir}`, q: { statusService: ENTREGADO, approvalState: APROBACION, sortBy: "deliveredAt", sortDir: dir } },
    { nombre: `entregados + status + aprobación, ${dir}`, q: { statusService: ENTREGADO, status: STATUS, approvalState: APROBACION, sortBy: "deliveredAt", sortDir: dir } },
  );
}

const qs = (q) =>
  Object.entries({ idWorkshop: ID_WORKSHOP, limit: 5, ...q })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

/**
 * Saca TODO el texto de error de una respuesta.
 *
 * ⚠️ La trampa que este spec casi se come: `routes/V1/entries.js:556` llama
 * `errorResponse(res, 500, err.message)`, pero la firma real del helper es
 * `(res, descripcion, errors, status = 400)`. O sea que un índice ausente NO
 * sale como HTTP 500: sale como **400**, con `descripcion: 500` y el mensaje
 * de Firestore enterrado en `errors[].message`. Mirar solo el código de
 * estado, o solo `descripcion`, daría VERDE con el índice faltando — que es
 * peor que no tener el spec.
 */
const textoDeError = (body) =>
  [
    body?.descripcion,
    body?.message,
    ...(Array.isArray(body?.errors) ? body.errors.map((e) => e?.message) : []),
    typeof body?.data === "string" ? body.data : null,
  ]
    .filter(Boolean)
    .join(" · ");

/** ¿El mensaje es el de un índice que Firestore no puede usar todavía? */
const esFaltaDeIndice = (texto) =>
  /FAILED_PRECONDITION|requires an index|necesita un índice|index.*console\.firebase/i.test(String(texto || ""));

/**
 * ¿Y es porque TODAVÍA SE ESTÁ CONSTRUYENDO?
 *
 * Firestore usa el MISMO `FAILED_PRECONDITION` para dos cosas muy distintas:
 * "ese índice no existe" y "ese índice existe pero aún se está construyendo".
 * Confundirlas manda a alguien a re-desplegar un archivo que ya estaba bien
 * — pasó el 14-sep, minutos después del primer deploy a refac. La única
 * diferencia está en el texto del mensaje, así que se separa aquí.
 */
const seEstaConstruyendo = (texto) =>
  /currently building|construyéndose/i.test(String(texto || ""));

/**
 * Recorre el lote entero — nunca corta en el primero — y reparte cada
 * combinación en tres montones: falta, se está construyendo, o rara.
 */
async function recorrer(request, lote, headers) {
  const faltan = [], construyendo = [], raras = [];
  for (const caso of lote) {
    const res = await request.get(`${API}/entries?${qs(caso.q)}`, { headers });
    const body = await res.json().catch(() => null);
    const texto = textoDeError(body);

    if (esFaltaDeIndice(texto) && seEstaConstruyendo(texto)) {
      construyendo.push(`  ⏳ ${caso.nombre}`);
      console.log(`  ⏳ ${caso.nombre} — el índice existe, Firebase lo está construyendo`);
    } else if (esFaltaDeIndice(texto)) {
      faltan.push(`  ✗ FALTA ÍNDICE · ${caso.nombre} → ${String(texto).slice(0, 500)}`);
    } else if (res.status() !== 200) {
      // No es falta de índice, pero tampoco pasó: casi siempre es el spec mal
      // configurado (token sin permiso, idWorkshop de otro taller). Se marca
      // distinto para que nadie lo lea como un índice faltante.
      raras.push(`  ✗ RESPUESTA INESPERADA (${res.status()}) · ${caso.nombre} → ${String(texto).slice(0, 300)}`);
    } else {
      console.log(`  ✓ ${caso.nombre} (200)`);
    }
  }
  return { faltan, construyendo, raras };
}

/**
 * Los tres montones en UN mensaje. Falla igual en los tres casos — la
 * consulta está rota AHORA — pero diciendo qué hacer con cada uno, que es
 * lo único que distingue "hay trabajo" de "hay que esperar".
 */
function veredicto({ faltan, construyendo, raras }, etiqueta = "") {
  const partes = [];
  if (faltan.length) {
    partes.push(`ÍNDICES QUE FALTAN${etiqueta} — agrégalos a firestore.indexes.json y despliega:\n${faltan.join("\n")}`);
  }
  if (raras.length) {
    partes.push(`RESPUESTAS INESPERADAS — esto NO es falta de índice; revisa el token y el ID_WORKSHOP:\n${raras.join("\n")}`);
  }
  if (construyendo.length) {
    partes.push(
      `ÍNDICES AÚN EN CONSTRUCCIÓN${etiqueta} — el deploy SÍ sirvió; Firebase todavía los arma.\n` +
      `NO vuelvas a desplegar: espera unos minutos (el avance se ve en la consola de Firestore) y vuelve a correr el spec.\n${construyendo.join("\n")}`,
    );
  }
  return partes.join("\n\n");
}

test.describe("Índices de entries — las 24 combinaciones de getEntries()", () => {
  test.skip(
    ES_LOCAL,
    "Los emuladores NO exigen índices compuestos: contra localhost este spec saldría verde sin probar nada. Apunta API a refac.",
  );
  test.skip(!ID_WORKSHOP, 'Falta ID_WORKSHOP. Ej: $env:ID_WORKSHOP="G85F..."');

  test("1) las 8 combinaciones del listado normal (createdAt desc)", { tag: ["@api"] }, async ({ request }) => {
    const r = await recorrer(request, SIN_MECANICO, await authHeaders());
    expect(veredicto(r), veredicto(r)).toBe("");
  });

  test("2) las 8 de Vehículos entregados (deliveredAt asc/desc)", { tag: ["@api"] }, async ({ request }) => {
    const r = await recorrer(request, ENTREGADOS, await authHeaders());
    expect(veredicto(r), veredicto(r)).toBe("");
  });

  // ── El Mecánico de usar y tirar ───────────────────────────────────────────
  // `assigned_mechanic` lo pone el BACKEND según el rol del token
  // (routes/V1/entries.js:532), nunca el query: sin un token de Mecánico de
  // verdad, estas 8 combinaciones no se pueden reproducir — y son las del rol
  // que originó el ticket 16. Buscar una cuenta a mano cada vez es fricción
  // que termina en "lo corro luego", así que el spec se la fabrica.
  //
  // ⚠️ SOLO contra refac. Si el proyecto no es refac (o sea: prod), NO se crea
  // nada — ahí hay que pasar MECHANIC_EMAIL / MECHANIC_PASSWORD de una cuenta
  // que ya exista. Un spec de solo-lectura no da de alta usuarios en producción.
  const creados = { uids: [] };
  let mecanico = null;
  let motivoSinMecanico = null;

  test.beforeAll(async () => {
    if (ES_LOCAL || !ID_WORKSHOP) return;

    const correo = process.env.MECHANIC_EMAIL;
    const password = process.env.MECHANIC_PASSWORD;
    if (correo && password) {
      mecanico = { correo, password };
      return;
    }

    let proyecto = "";
    try {
      proyecto = require("../../qaAdmin").projectId() || "";
    } catch (err) {
      motivoSinMecanico = `no se pudo leer el proyecto (¿falta el serviceAccountKey de refac?): ${err.message}`;
      return;
    }
    if (!/refac/i.test(proyecto)) {
      motivoSinMecanico =
        `el proyecto es "${proyecto}", no refac: aquí NO se crean usuarios. ` +
        "Pasa MECHANIC_EMAIL / MECHANIC_PASSWORD de un Mecánico que ya exista.";
      return;
    }

    try {
      const S = String(Date.now()).slice(-6);
      const nuevo = { correo: `mecanico.indices.${S}@ccc.test`, password: "Prueba1234!" };
      const user = await qaAdminAuth().createUser({ email: nuevo.correo, password: nuevo.password });
      // El claim es MECANICO (permissions.config.js:49 lo mapea a `mechanic`).
      // Ojo con la trampa de los nombres: ADMIN es el Dueño, no el Mecánico.
      await qaAdminAuth().setCustomUserClaims(user.uid, { role: "MECANICO", idWorkshop: ID_WORKSHOP });
      creados.uids.push(user.uid);
      const ahora = Date.now();
      await qaDb().collection("users").doc(user.uid).set({
        uid: user.uid, name: "Mecánico", firstSurname: "Índices", secondSurname: "",
        email: nuevo.correo, rol: "MECANICO", idWorkshop: ID_WORKSHOP,
        isActive: true, isDeleted: false, createdAt: ahora, updatedAt: ahora,
      }, { merge: true });
      mecanico = nuevo;
    } catch (err) {
      motivoSinMecanico = `no se pudo crear el mecánico de prueba: ${err.message}`;
    }
  });

  test.afterAll(async () => {
    // Se borra siempre, incluso si el caso falló: un mecánico huérfano por
    // corrida ensucia la lista de Usuarios del taller de pruebas.
    for (const uid of creados.uids) {
      await qaDb().collection("users").doc(uid).delete().catch(() => {});
      await qaAdminAuth().deleteUser(uid).catch(() => {});
    }
  });

  test("3) las 8 del Mecánico (assigned_mechanic forzado por el token)", { tag: ["@api"] }, async ({ request }) => {
    // Se salta CON MOTIVO, nunca en silencio: dar por buenas estas 8 sin
    // haberlas pedido sería mentir justo sobre el rol que originó el ticket.
    test.skip(!mecanico, motivoSinMecanico || "sin Mecánico disponible");

    const token = await signIn(mecanico.correo, mecanico.password);
    const headers = { Authorization: `Bearer ${token}` };
    // El Mecánico nunca entra por deliveredAt: la lista blanca del service lo
    // excluye a propósito (no hay índice de assigned_mechanic + deliveredAt, y
    // tampoco debe haberlo). Solo se recorren las 8 de createdAt.
    const r = await recorrer(request, SIN_MECANICO, headers);
    const ETIQUETA = " (rol Mecánico)";
    expect(veredicto(r, ETIQUETA), veredicto(r, ETIQUETA)).toBe("");
  });
});
