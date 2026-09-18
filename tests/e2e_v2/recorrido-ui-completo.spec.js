const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * e2e_v2 — DOS AUTOS DE PUNTA A PUNTA, POR INTERFAZ, SIN ATAJOS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Todo lo que aquí ocurre pasa por la pantalla, clicando como una persona:
 * el registro del taller, el alta del equipo, la recepción de los autos, el
 * diagnóstico, el costeo, la cotización, la aprobación del cliente desde su
 * celular, el abastecimiento, la reparación y la entrega. NO hay una sola
 * llamada al backend para sembrar, avanzar ni verificar.
 *
 * Es el hermano estricto de tests/demo/recorrido-multirol-qa.spec.js: aquel
 * cambia de sesión por UI pero ejecuta las acciones por API (rápido y robusto,
 * pero ciego a las pantallas). Este no: si un formulario se rompe, este truena.
 *
 * ── EL RECORRIDO ──────────────────────────────────────────────────────────
 *
 *   1   Dueño     Registra el taller (14 días gratis, SIN tarjeta).
 *   2   Dueño     Da de alta al Asesor, al Mecánico y a Compras.
 *   3-8 (varios)  AUTO 1: recepción → diagnóstico → costeo → cotización →
 *                 aprobación del cliente → abastecimiento → reparación.
 *   9   Asesor    AUTO 1 entregado.
 *   3-8 (varios)  AUTO 2: el mismo ciclo completo.
 *   10  Asesor    Intenta dar entrada a un auto que YA está en el taller.
 *                 Debe avisar el motivo y NO dejar avanzar (observación #1).
 *   9   Asesor    AUTO 2 entregado.
 *
 * Dos autos, no uno, a propósito: el segundo es el que destapa lo que solo
 * falla cuando ya hay historia — folios repetidos, selectores que enganchan la
 * tarjeta del auto anterior, contadores que no se reinician.
 *
 * ── POR QUÉ YA NO HAY ATAJOS (9-sep-2026) ─────────────────────────────────
 *
 * Este archivo tenía dos escapes, y los dos saltaban justo lo más real:
 *
 *   · `E2E_TALLER_EMAIL` reutilizaba un taller ya registrado y se brincaba la
 *     etapa 1 entera. Era la receta recomendada "para el día a día", así que
 *     en la práctica el alta casi nunca se probaba — y cuando FEAT-TRIAL21
 *     cambió el registro (1-sep), esta prueba no se enteró.
 *   · `APROBAR_EN_WEB=1` aprobaba desde la pantalla del taller en vez de
 *     esperar al cliente. Aprobar es del cliente: saltárselo es dejar de
 *     probar el producto.
 *
 * Los dos se quitaron. Cada corrida registra un taller nuevo y espera las DOS
 * aprobaciones reales desde el celular. Tarda más; ese es el punto.
 *
 * ── LA PAUSA DEL CELULAR ──────────────────────────────────────────────────
 *
 * Dos veces (una por auto) el recorrido se detiene y espera a que el cliente
 * apruebe la cotización desde la app. Mientras tanto vigila la PANTALLA del
 * taller, recargando hasta que diga "Aprobada". Si nadie aprueba en el plazo,
 * la corrida falla — no hay modo sin celular.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *
 *      cd C:\Users\USER\Documents\TRABAJO\ccc-testing
 *      $env:BASE_URL="https://ccc-frontend-qa.vercel.app"
 *      $env:SKIP_SEED="1"
 *      npm run test:e2e2:recorrido
 *
 *    OJO: `npm run test:e2e2` a secas corre TODO el project, y ahi vive tambien
 *    FEAT-TRIAL21_prueba-dos-etapas.ui.spec.js, que aborta al cargarse si no
 *    tiene su propia TRIAL_CORREO_BASE. Por eso este recorrido tiene su script.
 *
 *    Ten a la mano el celular con la app y la sesión del cliente
 *    (E2E_CLIENTE_EMAIL, por omisión rsv.cup@gmail.com): te va a tocar aprobar
 *    dos cotizaciones.
 *
 *    Para presentarlo en vivo, con pausas visibles entre pasos:
 *      $env:E2E_LENTO="1"
 *
 * ── CUANDO FALLA ──────────────────────────────────────────────────────────
 *
 * Cada etapa deja captura + HTML en `scripts/debug-e2e2/`, nombrados con la
 * etapa y la hora. Ese HTML es lo más útil para saber por qué no apareció un
 * campo: se abre y se busca el selector a mano.
 *
 *      npx playwright show-report      # el reporte con video de la corrida
 *
 * El prefijo de cada etapa dice de qué auto se trata ("Auto 1 · 4) Mecánico…"),
 * así que en el reporte no hay que adivinar cuál de las dos vueltas reventó.
 *
 * ── LIMPIEZA DEL TALLER DE PRUEBAS ────────────────────────────────────────
 *
 * Cada corrida crea un Asesor, un Mecánico y un Compras NUEVOS. No es descuido:
 * el selector de mecánico es un CreatableSelect que filtra por nombre, y con
 * tres "Javier Mora" en el taller elegiría al de otra corrida — la OS quedaría
 * asignada a un mecánico que no es el que va a iniciar sesión, y la etapa 8
 * reventaría con 403. Por eso los apellidos llevan el sello de la corrida.
 *
 * a) AUTOMÁTICO — si la corrida FALLA, este archivo borra al final lo que
 *    alcanzó a crear (los tres usuarios, las dos OS y los dos autos). Si PASA,
 *    no borra nada: el rastro sirve de evidencia. Nunca toca al cliente
 *    (rsv.cup@gmail.com es una cuenta real de la demo; la corrida la reutiliza).
 *
 *      $env:E2E_SIN_LIMPIEZA="1"   # conservar el rastro aunque falle
 *
 * b) A MANO — para vaciar lo que dejaron corridas viejas:
 *      node scripts/limpiar-taller-pruebas.js ./serviceAccountKey.json --dueno=<correo>
 *
 * ── VARIABLES ─────────────────────────────────────────────────────────────
 *
 *   BASE_URL              La app de QA.
 *   SKIP_SEED=1           No sembrar datos (aquí siempre, no hay emuladores).
 *   E2E_CLIENTE_EMAIL     Correo REAL del cliente, para poder aprobar desde el
 *                         celular. Default: rsv.cup@gmail.com
 *   E2E_ESPERA_MS         Cuánto espera al celular, por auto. Default 10 min.
 *   E2E_SONDEO_MS         Cada cuánto recarga para ver si ya se aprobó. 5s.
 *   E2E_LENTO=1           Mete pausas visibles entre pasos (para presentar).
 *   E2E_SIN_LIMPIEZA=1    No borrar nada aunque la corrida falle.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const CLIENTE_EMAIL = process.env.E2E_CLIENTE_EMAIL || "rsv.cup@gmail.com";
const ESPERA_MS = Number(process.env.E2E_ESPERA_MS) || 10 * 60_000;
const SONDEO_MS = Number(process.env.E2E_SONDEO_MS) || 5000;
const RITMO_MS = process.env.E2E_LENTO === "1" ? 900 : 0;

// Sello único por corrida: placas, VIN y correo del taller nuevo.
const S = String(Date.now()).slice(-6);

const TARJETA = { numero: "4242424242424242", vence: "12/34", cvc: "123" };

const TALLER = {
  nombre: `Taller E2E ${S}`,
  correo: `rsv_gpa+e2e${S}@outlook.com`,
  telefono: `55${S}01`.slice(0, 10),
  direccion: "Av. Insurgentes Sur 1602, Benito Juárez, CDMX",
  admin: {
    nombre: "Rodrigo",
    apellidoP: "Salazar",
    apellidoM: "Vega",
    correo: `rsv_gpa+e2e${S}@outlook.com`,
    telefono: `55${S}02`.slice(0, 10),
    password: "Demo1234",
    etiqueta: "Dueño",
  },
};

// OJO: UserForm.jsx exige mayuscula + minuscula + numero + caracter especial
// (isSecurePassword). "Demo1234" NO pasa: deja «Crear usuario» deshabilitado.
const EQUIPO_PASSWORD = "Demo1234!";

/**
 * Lo que ESTA corrida creo en QA. Solo se usa para la limpieza de abajo, que
 * corre UNICAMENTE si la prueba falla: una corrida verde deja su rastro intacto
 * por si quieres revisarlo o enseñarlo.
 */
const creado = { usuarios: [], entryIds: [] };

/** El equipo. `rol` es la etiqueta del <select>, tal como se lee en pantalla. */
const EQUIPO = {
  asesor: {
    etiqueta: "Asesor",
    rol: "Asesor",
    nombre: "Daniela", apellidoP: "Rios", apellidoM: `Campos ${S}`,
    correo: `rsv_gpa+e2e${S}.asesor@outlook.com`,
    telefono: `55${S}11`.slice(0, 10),
    password: EQUIPO_PASSWORD,
    veEnMenu: "Entrada de Vehículo",
    noVeEnMenu: "Abastecimiento",
  },
  mecanico: {
    etiqueta: "Mecánico",
    rol: "Mecánico",
    // El apellido lleva el sello de la corrida a proposito: el taller se
    // reutiliza y el selector de mecanico es un CreatableSelect que filtra por
    // nombre. Con tres "Javier Mora Téllez" de corridas viejas, Enter elegiria
    // al de otra corrida y el Mecanico de HOY se quedaria sin OS asignada.
    nombre: "Javier", apellidoP: "Mora", apellidoM: `Téllez ${S}`,
    correo: `rsv_gpa+e2e${S}.mecanico@outlook.com`,
    telefono: `55${S}12`.slice(0, 10),
    password: EQUIPO_PASSWORD,
    horas: "8",
    veEnMenu: "Producción",
    noVeEnMenu: "Clientes",
  },
  compras: {
    etiqueta: "Compras",
    rol: "Compras",
    nombre: "Ricardo", apellidoP: "Peña", apellidoM: `Lozano ${S}`,
    correo: `rsv_gpa+e2e${S}.compras@outlook.com`,
    telefono: `55${S}13`.slice(0, 10),
    password: EQUIPO_PASSWORD,
    veEnMenu: "Abastecimiento",
    noVeEnMenu: "Clientes",
  },
};

const CLIENTE = {
  nombre: "Patricia Gómez Vidal",
  telefono: "5522330001",
  correo: CLIENTE_EMAIL,
};

/**
 * DOS autos del mismo cliente. El recorrido los lleva a los dos de punta a
 * punta, porque un taller real no atiende un solo coche: el segundo es el que
 * destapa lo que solo falla cuando ya hay historia (folios que se repiten,
 * selectores que enganchan la tarjeta del auto anterior, contadores).
 *
 * Placas y VIN llevan el sello de la corrida y un sufijo distinto por auto: si
 * dos corridas comparten placas, el bloqueo de OS duplicada salta cuando no
 * debe y el recorrido muere sin razon aparente.
 */
/**
 * VIN de cada auto de la corrida. 17 caracteres EXACTOS, y el backend los exige
 * UNICOS: `car.service.js` → "El VIN ya está registrado" → 400 en POST /v1/cars.
 *
 * OJO CON EL RECORTE. Antes se armaba `` `3N1CN7AD5PL${S}${i}`.slice(0, 17) ``,
 * y como el prefijo (11) + el sello (6) ya sumaban 17, el `slice` se comia
 * justo el digito que distinguia a un auto del otro: los DOS nacian con el
 * mismo VIN. El auto 1 pasaba, y el 2 moria con un 400 que la pantalla no
 * explicaba — se veia como "no avanza el asistente".
 *
 * Ahora el indice va ANTES del sello y la cuenta da 17 sin recortar nada:
 *   3N1CN7AD5P (10) + indice (1) + S (6) = 17
 */
const vinDeAuto = (i) => `3N1CN7AD5P${i}${S}`;

const AUTOS = [
  {
    marca: "Nissan",
    modelo: "Versa",
    anio: "2023",
    color: "Blanco",
    placas: `E2A${S}`.slice(0, 8),
    vin: vinDeAuto(0),
    transmision: "Automática",
    km: "15000",
    combustible: "Gasolina",
    falla: "El cliente reporta ruido metálico al frenar y el pedal se siente bajo.",
  },
  {
    marca: "Nissan",
    modelo: "Versa",
    anio: "2021",
    color: "Gris",
    placas: `E2B${S}`.slice(0, 8),
    vin: vinDeAuto(1),
    transmision: "Manual",
    km: "82000",
    combustible: "Gasolina",
    falla: "Se enciende el testigo del motor y pierde fuerza al subir pendientes.",
  },
];

// Candado: que un VIN repetido o de largo equivocado se vea AQUI, al arrancar,
// y no como un 400 a media corrida despues de una aprobacion por celular.
const VINS = AUTOS.map((a) => a.vin);
if (new Set(VINS).size !== VINS.length) {
  throw new Error(`Los autos de la corrida comparten VIN (${VINS.join(", ")}). El backend rechaza el segundo con 400.`);
}
for (const v of VINS) {
  if (v.length !== 17) {
    throw new Error(`VIN de largo ${v.length}, deben ser 17 exactos: "${v}".`);
  }
}

/**
 * Las variables de los atajos se quitaron (9-sep-2026). Si quedaron puestas en
 * la terminal, quien corre esto cree que esta probando algo que ya no prueba:
 * `E2E_TALLER_EMAIL` haria que el registro intentara dar de alta un taller con
 * un correo ya usado y fallaria de forma confusa, y `APROBAR_EN_WEB` daria la
 * falsa impresion de que no hace falta el celular. Se aborta y se dice.
 */
const ATAJOS_RETIRADOS = ["E2E_TALLER_EMAIL", "E2E_TALLER_PASSWORD", "APROBAR_EN_WEB"];
const puestas = ATAJOS_RETIRADOS.filter((v) => process.env[v]);
if (puestas.length) {
  throw new Error(
    `Estas variables ya no existen en este recorrido: ${puestas.join(", ")}.\n` +
      "Se quitaron a proposito: cada corrida registra un taller nuevo y espera las\n" +
      "dos aprobaciones reales del cliente desde el celular. Limpialas y vuelve a correr\n" +
      "(en PowerShell: $env:E2E_TALLER_EMAIL=\"\").",
  );
}

const DEBUG_DIR = path.join(__dirname, "..", "..", "scripts", "debug-e2e2");

// ── Utilería ────────────────────────────────────────────────────────────────

/** Respiro opcional, solo si se corre en modo presentación. */
const respiro = (page) => (RITMO_MS ? page.waitForTimeout(RITMO_MS) : Promise.resolve());

/**
 * Captura de pantalla + HTML cuando algo no sale como se espera. Sin esto,
 * depurar un fallo de UI contra un entorno remoto es adivinar.
 */
async function evidencia(page, etiqueta) {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = path.join(DEBUG_DIR, `${etiqueta}-${stamp}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => null);
    if (html) fs.writeFileSync(`${base}.html`, html);
    console.log(`   🩺 Evidencia: ${base}.png  (url: ${page.url()})`);
  } catch (e) {
    console.error(`   (no se pudo guardar evidencia: ${e.message})`);
  }
}

/** Envuelve una etapa: si truena, deja evidencia antes de propagar el error. */
let PREFIJO_ETAPA = "";

async function etapa(page, nombre, fn) {
  return test.step(`${PREFIJO_ETAPA}${nombre}`, async () => {
    try {
      await fn();
    } catch (err) {
      await evidencia(page, nombre.replace(/[^a-z0-9]+/gi, "-").slice(0, 40));
      throw err;
    }
  });
}

// ── Sesión (todo por UI) ────────────────────────────────────────────────────

const itemMenu = (page, nombre) =>
  page.locator("aside").getByRole("button", { name: nombre, exact: true });

async function iniciarSesion(page, persona) {
  await page.goto("/login");
  await page.locator("#email").fill(persona.correo);
  await page.locator("#password").fill(persona.password);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 30000 });
  await respiro(page);
}

/**
 * Cierre de sesión REAL: botón del header → modal de confirmación → confirmar.
 * Sin fallback silencioso: si esto se rompe, es una regresión de la UI y el
 * test debe enterarse, no disimularla limpiando el almacenamiento.
 */
async function cerrarSesion(page) {
  await page.locator('button[aria-label="Cerrar sesión"]').first().click({ timeout: 15000 });
  await expect(page.getByText(/cerrar sesion|cerrar sesión/i).first()).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: /^cerrar sesión$/i }).last().click();
  await page.waitForURL(/\/login/, { timeout: 20000 });
  await respiro(page);
}

/** Entra como `persona` y comprueba que su menú es el que le corresponde. */
async function entrarComo(page, persona) {
  console.log(`\n   👤 ${persona.etiqueta} — ${persona.correo}`);
  await iniciarSesion(page, persona);

  if (persona.veEnMenu) {
    await expect(
      itemMenu(page, persona.veEnMenu),
      `${persona.etiqueta} DEBE ver "${persona.veEnMenu}"`,
    ).toBeVisible({ timeout: 20000 });
  }
  if (persona.noVeEnMenu) {
    await expect(
      itemMenu(page, persona.noVeEnMenu),
      `${persona.etiqueta} NO debe ver "${persona.noVeEnMenu}"`,
    ).toHaveCount(0);
  }
}

/**
 * Escapa un texto para meterlo en un RegExp literal.
 * Sin esto, un correo como `rsv_gpa+e2e1.asesor@outlook.com` se interpreta como
 * patron: el `+` significa "una o mas veces" y el `.` "cualquier caracter", asi
 * que la busqueda falla aunque el texto SI este en pantalla. Nos costo una
 * corrida entera.
 */
const literal = (texto) => String(texto).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── Buscadores tipo "escribe y elige de la lista" ────────────────────────────

/**
 * Marca, modelo y color son comboboxes: escribir NO basta, hay que hacer clic
 * en la opción. Si solo se teclea, el campo queda vacío aunque se vea el texto
 * — es el error más fácil de cometer en este formulario.
 */
async function elegirDeLista(page, placeholderRe, valor) {
  const input = page.getByPlaceholder(placeholderRe);
  await input.fill(valor);
  const opcion = page.getByRole("button", { name: new RegExp(`^${literal(valor)}$`) }).first();
  await opcion.waitFor({ timeout: 10000 });
  await opcion.click();
}

/**
 * El selector de mecánico es un CreatableSelect: teclear + Enter.
 *
 * OJO: es "Creatable". Si el texto no coincide con ningun mecanico, Enter no
 * falla — INVENTA una opcion cuyo value es el texto tecleado, y la entrada
 * queda con un `assigned_mechanic` que no es el uid de nadie. El sintoma
 * aparece dos pasos despues, cuando el Mecanico recibe 403 en su propia OS.
 * Por eso se verifica que el nombre haya quedado pintado en el control.
 */
async function elegirMecanico(page, nombreCompleto) {
  const input = page.locator('input[id^="react-select"][id$="-input"]').first();
  await input.click({ force: true });
  await input.pressSequentially(nombreCompleto);

  // NO se usa Enter. Es un CreatableSelect: si el texto no casa con ningun
  // mecanico de la lista, Enter no falla — inventa una opcion cuyo `value` es
  // el TEXTO tecleado. La entrada queda entonces con un `assigned_mechanic`
  // que no es el uid de nadie, y el sintoma aparece cuatro pasos despues:
  // "No tienes autos asignados" en Produccion.
  //
  // Se hace clic en la opcion real, localizada por su texto EXACTO — la opcion
  // de crear dice `Create "..."`, asi que el ancla ^...$ la descarta sola.
  const opcion = page
    .locator('[id*="-option-"]')
    .filter({ hasText: new RegExp(`^${literal(nombreCompleto)}$`) })
    .first();
  await expect(
    opcion,
    `«${nombreCompleto}» no aparece en la lista de mecánicos: ¿se creó bien la cuenta?`,
  ).toBeVisible({ timeout: 10000 });
  await opcion.click();

  await expect(
    page.getByText(new RegExp(literal(nombreCompleto), "i")).first(),
    `el mecánico «${nombreCompleto}» no quedó seleccionado`,
  ).toBeVisible({ timeout: 10000 });
}

// ── Buscar la OS en /registro (se usa en varias etapas) ─────────────────────

/**
 * Localiza la tarjeta de NUESTRA entrada en /registro.
 *
 * Busca por PLACAS, no por folio de OS: las placas las decide el test (son
 * unicas por corrida) y existen desde antes de registrar, mientras que el folio
 * lo asigna el backend y no se conoce hasta despues. El buscador de esa
 * pantalla acepta ambos ("No. OS, placas, cliente o telefono") y del lado del
 * backend `getEntries` filtra por `codeCar`.
 *
 * OJO CON LA PESTAÑA. /registro no es UNA lista: son TRES, y el filtro es del
 * SERVIDOR, no de la pantalla. `Entrada.jsx` → `getListFiltersForTab()`:
 *
 *     Activos       → getEntries({ approvalState: "EN ESPERA" })
 *     No Aprobados  → getEntries({ approvalState: "NO APROBADA" })
 *     Aprobados     → getEntries({ approvalState: "APROBADA" })
 *
 * Es decir: en cuanto el cliente aprueba desde el celular, la OS DESAPARECE de
 * "Activos" (la pestaña por omision). No cambia de etiqueta: se va. Cualquier
 * paso posterior a la aprobacion tiene que pedir `{ tab: "aprobados" }`.
 *
 * Y OJO CON EL BUSCADOR: NO respeta la pestaña. `runOsSearch` (Entrada.jsx)
 * llama `getEntries({ status: 1, search })` SIN `approvalState`, y `visibleRows`
 * devuelve `searchResults` tal cual. O sea: buscando, la OS sale en CUALQUIER
 * pestaña, incluida una a la que no pertenece. Si se busca dentro de la
 * pestaña "Aprobados", la tarjeta aparece aunque la OS siga EN ESPERA — y
 * entonces la pestaña deja de significar nada. Por eso, cuando se pide una
 * pestaña, NO se busca: se deja que mande el filtro del servidor.
 *
 * @param {object} [opciones]
 * @param {string|null} [opciones.tab]  "aprobados" | "no-aprobados" | null (Activos)
 * @param {boolean} [opciones.blando]   true: devuelve el locator SIN afirmar que
 *   exista. Para sondeos, donde "todavia no esta" es una respuesta valida y no
 *   un fallo del test.
 * @param {boolean} [opciones.buscar]   por omision se busca SOLO sin pestaña.
 */
async function tarjetaDeEntrada(
  page,
  AUTO,
  { tab = null, timeout = 20000, blando = false, buscar = tab === null } = {},
) {
  await page.goto(tab ? `/registro?tab=${tab}` : "/registro");

  // /registro es de Asesor/Dueño. Con un rol que no lo ve (Compras, Mecanico)
  // el router rebota a /dashboard y la tarjeta "no aparece" — un mensaje que
  // manda a buscar el problema donde no esta. Se dice lo que realmente pasó.
  if (!blando && !/\/registro/.test(page.url())) {
    throw new Error(
      `/registro rebotó a ${page.url()}: el rol con el que está abierta la ` +
        "sesión no puede ver la Entrada de Vehículos. Entra como Asesor (o " +
        "Dueño) antes de mirar el tablero.",
    );
  }

  // `goto` vuelve cuando llega el HTML, no cuando React monto y el API
  // respondio. Sin esperar aqui, `count()` da 0, la busqueda se salta y la
  // lista se lee vacia aunque la OS si este.
  const buscador = page.getByRole("textbox", { name: /buscar por no\. de os/i });
  await buscador.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  if (buscar && (await buscador.count())) {
    // El input es CONTROLADO (`value={osSearch}` en Entrada.jsx). Si el
    // componente se re-monta mientras AuthContext resuelve, React lo repinta
    // con "" y se pierde lo tecleado: `runOsSearch` nunca corre y la pantalla
    // se queda con el listado de la pestaña. Paso silencioso, y costo una
    // corrida entera. Por eso se verifica que el texto se haya QUEDADO antes
    // de pulsar "Buscar".
    for (let intento = 0; intento < 3; intento += 1) {
      await buscador.fill(AUTO.placas);
      if ((await buscador.inputValue()) === AUTO.placas) break;
      await page.waitForTimeout(500);
    }
    if ((await buscador.inputValue()) === AUTO.placas) {
      await page.getByRole("button", { name: /^buscar$/i }).click();
    }
  }

  // `:visible` importa: la lista se pinta DOS veces (CardsSmall y CardsLarge,
  // esta ultima oculta con `hidden` para pantallas grandes). Sin el filtro se
  // puede enganchar la copia invisible y `toBeVisible` falla para siempre.
  const tarjeta = page.locator("div.rounded-xl:visible", { hasText: AUTO.placas }).first();
  if (blando) {
    // Aun en modo blando hay que ESPERAR. Un `isVisible()` seco justo despues
    // del `goto` siempre da false —la lista todavia no se pinta— y el sondeo
    // se cicla para siempre recargando. Se espera poco, porque "todavia no"
    // es una respuesta legitima y el que manda es el reloj del sondeo.
    await tarjeta.waitFor({ state: "visible", timeout }).catch(() => {});
    return tarjeta;
  }
  await expect(
    tarjeta,
    `no encuentro la entrada de las placas ${AUTO.placas} en ` +
      `/registro${tab ? ` (pestaña «${tab}»)` : " (pestaña «Activos»)"}`,
  ).toBeVisible({ timeout });
  return tarjeta;
}

/**
 * Escribe en un campo CONTROLADO y comprueba que el texto se haya quedado.
 *
 * Los formularios de la app guardan cada tecla en redux y repintan con
 * `value={...}`. Si el componente se remonta mientras tanto (auth resolviendo,
 * un draft que se limpia, un paso que se vuelve a montar), React repinta con el
 * valor viejo —vacio— y lo tecleado se pierde SIN error: el `fill` ya ocurrio.
 * Despues falla otra cosa, lejos de aqui, y parece un bug del producto.
 *
 * Ya mordio dos veces en este recorrido: el buscador de /registro y el "Estado
 * general del vehiculo" del paso 3. Por eso se verifica y se reintenta.
 */
async function escribirSeguro(campo, texto, { intentos = 3, etiqueta = "" } = {}) {
  for (let i = 0; i < intentos; i += 1) {
    await campo.fill(texto);
    if ((await campo.inputValue()) === texto) return;
    await campo.page().waitForTimeout(400);
  }
  throw new Error(
    `no se quedo lo escrito en ${etiqueta || "el campo"} (quedo en ` +
      `"${await campo.inputValue()}"). Es un input controlado que se repinto ` +
      "mientras se tecleaba; sube `intentos` o espera a que el paso termine de montar.",
  );
}

/**
 * ¿La OS esta en esa pestaña de /registro? Devuelve booleano, nunca lanza.
 *
 * Es la pregunta del sondeo de la etapa 6: "¿ya la aprobo?" no es una
 * afirmacion que deba tumbar el test si la respuesta es "todavia no".
 *
 * NUNCA busca — ni siquiera con `tab` en null (pestaña "Activos"). El buscador
 * de /registro ignora la pestaña (`runOsSearch` no manda `approvalState`), asi
 * que buscando la tarjeta sale SIEMPRE y la pregunta "¿en que pestaña esta?"
 * se responde sola que si. Eso invalida la respuesta por construccion: quien
 * tiene que decidir es el filtro del servidor, no el buscador.
 */
async function estaEnPestania(page, AUTO, tab = null, timeout = 8000) {
  const tarjeta = await tarjetaDeEntrada(page, AUTO, {
    tab,
    blando: true,
    timeout,
    buscar: false,
  });
  return tarjeta.isVisible().catch(() => false);
}

/** El folio de OS, leido de la tarjeta ("OS: 41"). */
async function folioDeLaTarjeta(tarjeta) {
  const texto = await tarjeta.innerText();
  return (texto.match(/OS:\s*(\d+)/i) || [])[1] || null;
}

// ═══════════════════════════════════════════════════════════════════════════

test.describe.configure({ mode: "serial" });

test(
  "e2e_v2 · todo por UI, sin atajos: registro del taller → equipo → DOS autos de la recepción a la entrega → un tercer intento con un auto ya en taller queda bloqueado",
  { tag: ["@ui", "@lento", "@e2e2"] },
  async ({ page }) => {
    test.setTimeout(ESPERA_MS + 20 * 60_000);

    // ── 1. Registrar el taller ──────────────────────────────────────────────
    //
    // Desde FEAT-TRIAL21 (1-sep-2026) esta pantalla YA NO cobra: crea la cuenta
    // con 14 dias gratis SIN pedir tarjeta y hace auto-login ahi mismo. La
    // version anterior de este recorrido buscaba un boton "Continuar al pago
    // seguro" y esperaba un redirect a checkout.stripe.com; ninguno de los dos
    // existe ya. La tarjeta se registra despues, dentro de la app, en
    // /suscripcion — eso es otra etapa del producto y no parte del alta.
    //
    // No hay atajo: cada corrida registra un taller NUEVO. Reutilizar uno
    // saltaba justo la parte que mas se rompe.
    await etapa(page, "1) Registro del taller (14 dias gratis, sin tarjeta)", async () => {
      await page.goto("/registro-taller?plan=premium&cycle=0");

      await page.locator('input[name="workshopName"]').fill(TALLER.nombre);
      await page.locator('input[name="workshopEmail"]').fill(TALLER.correo);
      await page.locator('input[name="workshopPhone"]').fill(TALLER.telefono);
      await page.locator('input[name="workshopAddress"]').fill(TALLER.direccion);

      await page.locator('input[name="name"]').fill(TALLER.admin.nombre);
      await page.locator('input[name="firstSurname"]').fill(TALLER.admin.apellidoP);
      await page.locator('input[name="secondSurname"]').fill(TALLER.admin.apellidoM);
      await page.locator('input[name="email"]').fill(TALLER.admin.correo);
      await page.locator('input[name="phone"]').fill(TALLER.admin.telefono);
      await page.locator('input[name="password"]').fill(TALLER.admin.password);
      await page.locator('input[name="confirmPassword"]').fill(TALLER.admin.password);

      // El label alterna con "Creando tu cuenta..." mientras envia, asi que se
      // busca por el texto estable del principio.
      await page.getByRole("button", { name: /crear mi cuenta/i }).click();

      // Dos aterrizajes posibles (RegistroTallerPage.jsx): auto-login en la
      // misma pagina, o caida a /login si el signIn no prendio. Los dos son
      // validos para el producto; lo que NO puede pasar es quedarse en el
      // formulario.
      await page.waitForURL(
        (u) => !/registro-taller/.test(u.pathname),
        { timeout: 60000 },
      );
      if (/\/login/.test(new URL(page.url()).pathname)) {
        console.log("   ℹ️  No hubo auto-login: entro con las credenciales del Dueño.");
        await iniciarSesion(page, TALLER.admin);
      }

      // Verificacion real de que la cuenta quedo usable: el menu del Dueño.
      await expect(
        itemMenu(page, "Usuarios"),
        "el Dueño no ve «Usuarios»: la cuenta no quedo bien creada",
      ).toBeVisible({ timeout: 30000 });
      console.log(
        `\n   🏪 Taller creado: «${TALLER.nombre}»\n` +
          `      Dueño: ${TALLER.correo} / ${TALLER.admin.password}\n` +
          `      Autos de esta corrida: ${AUTOS.map((a) => a.placas).join(" y ")}\n`,
      );
      await respiro(page);
    });

    // ── 2. El Dueño da de alta al equipo ────────────────────────────────────
    await etapa(page, "2) El Dueño crea las cuentas del equipo", async () => {
      // Venimos de la etapa 1 ya dentro (el registro deja la sesion abierta).
      // Si por lo que sea no quedo, se entra con las credenciales del Dueño.
      if (/\/login/.test(new URL(page.url()).pathname)) {
        await iniciarSesion(page, TALLER.admin);
      }
      await expect(
        itemMenu(page, "Usuarios"),
        "el Dueño debe ver «Usuarios» en el menú",
      ).toBeVisible({ timeout: 30000 });

      for (const persona of Object.values(EQUIPO)) {
        await page.goto("/usuarios");

        const agregar = page
          .getByRole("button", { name: /agregar|nuevo usuario|añadir|\+/i })
          .first();
        await agregar.click({ timeout: 15000 });

        // OJO: en esta pantalla los <label> NO tienen `for=` y los primeros
        // campos no traen id/name/placeholder, así que `getByLabel` no
        // funciona (ver el punto 11 del BACKLOG_TECNICO: es un problema de
        // accesibilidad real, no solo una molestia para el test).
        // Mientras eso no se arregle, se localizan por atributo cuando lo hay
        // y por posición cuando no. El orden viene de UserForm.jsx:
        //   0 Nombre · 1 Apellido paterno · 2 Apellido materno · 3 Correo(email)
        await expect(page.getByText(/Apellido paterno/i).first()).toBeVisible({ timeout: 15000 });

        const textos = page.locator('input:not([type]), input[type="text"]');
        await textos.nth(0).fill(persona.nombre);
        await textos.nth(1).fill(persona.apellidoP);
        await textos.nth(2).fill(persona.apellidoM);

        await page.locator('input[type="email"]').first().fill(persona.correo);
        await page.getByPlaceholder(/Mínimo 8 caracteres/i).fill(persona.password);
        await page.getByPlaceholder(/Repite la contraseña/i).fill(persona.password);
        await page.getByPlaceholder(/555-123-4567/).fill(persona.telefono);
        await page.locator("select").first().selectOption({ label: persona.rol });

        if (persona.horas) {
          const horas = page.locator('input[type="number"]');
          if (await horas.count()) await horas.first().fill(persona.horas);
        }

        // El botón nace deshabilitado y se activa cuando el formulario valida:
        // si sigue deshabilitado, es que algún campo no quedó bien.
        const crear = page.getByRole("button", { name: /^crear usuario$/i });
        await expect(crear, "«Crear usuario» sigue deshabilitado: algún campo no pasó la validación").toBeEnabled({
          timeout: 10000,
        });
        await crear.click();
        await expect(
          page.getByText(persona.correo, { exact: false }).first(),
          `se creo ${persona.etiqueta} pero no aparece ${persona.correo} en la tabla`,
        ).toBeVisible({ timeout: 20000 });
        creado.usuarios.push(persona.correo);
        console.log(`   + ${persona.etiqueta}: ${persona.correo}`);
        await respiro(page);
      }
    });


    /**
     * El ciclo completo de UN auto, de la recepcion hasta dejarlo listo para
     * entregar. Se llama una vez por auto; el prefijo de las etapas dice cual
     * es cual en el reporte.
     *
     * `AUTO` es un PARAMETRO a proposito: sombrea la constante del modulo, asi
     * que el cuerpo de las etapas —que ya hablaba de `AUTO`— no cambia ni una
     * linea al pasar de un auto a dos.
     */
    async function recorridoDeUnAuto(AUTO) {
      let os = null;      // folio visible ("OS: 2")
      let entryId = null; // id del documento, para las pantallas sin menu

      // ── 3. El Asesor recibe el auto ─────────────────────────────────────────
      await etapa(page, "3) Asesor: cliente, vehículo y hoja de servicio", async () => {
        await cerrarSesion(page);
        await entrarComo(page, EQUIPO.asesor);

        await page.goto("/registro");
        await page.getByRole("button", { name: /nueva entrada/i }).click();
        await page.getByRole("button", { name: /cliente y veh[ií]culo nuevo/i }).click();
        await expect(page).toHaveURL(/crear-cliente-vehiculo/, { timeout: 20000 });

        // Paso 1 — cliente (crea su cuenta de app y dispara el correo de activación)
        await page.locator("#name").fill(CLIENTE.nombre);
        await page.locator("#phone").fill(CLIENTE.telefono);
        await page.locator("#email").fill(CLIENTE.correo);
        await page.getByRole("button", { name: /^siguiente$/i }).click();

        // OJO: el aviso de "este cliente ya esta registrado" NO sale aqui. Lo
        // dispara `createClientInternal`, y a esa la llama `registerAll` — o sea
        // el boton «Registrar y continuar» del FINAL del asistente. Buscarlo en
        // este punto (como se hacia antes) no encontraba nada, el test seguia de
        // largo, y el modal aparecia despues bloqueando «Finalizar». Se atiende
        // mas abajo, donde de verdad ocurre.

        // Paso 2 — vehículo
        await expect(page.locator("#codeCar")).toBeVisible({ timeout: 20000 });
        await elegirDeLista(page, /escribe o selecciona una marca/i, AUTO.marca);
        await elegirDeLista(page, /el modelo|modelo \(libre\)|primero elige/i, AUTO.modelo);
        await page.locator("#year").fill(AUTO.anio);
        await elegirDeLista(page, /escribe o selecciona un color/i, AUTO.color);
        await page.locator("#codeCar").fill(AUTO.placas);
        await page.locator("#vin").fill(AUTO.vin);
        await page.locator("#transmition").selectOption(AUTO.transmision);
        await page.locator("#car-km").fill(AUTO.km);
        await page.locator("#car-fuel").selectOption(AUTO.combustible);
        await elegirMecanico(
          page,
          `${EQUIPO.mecanico.nombre} ${EQUIPO.mecanico.apellidoP} ${EQUIPO.mecanico.apellidoM}`,
        );
        await page.locator("#car-issue-desc").fill(AUTO.falla);
        await page.getByRole("button", { name: /^siguiente$/i }).click();

        // Paso 3 — hoja de servicio
        await expect(page.locator("#selectAll")).toBeVisible({ timeout: 20000 });
        await page.locator("#selectAll").check();
        const tanque = page.locator('[data-entry-sheet-field="fuel_tank"]');
        if (await tanque.count()) await tanque.getByText("1/2", { exact: true }).click();
        else await page.getByRole("button", { name: "1/2" }).first().click();

        await page.getByRole("button", { name: /diagn[oó]stico\/fallas reportadas/i }).click();
        await page
          .locator("label", { has: page.locator('input[type="checkbox"]') })
          .filter({ hasText: /frenos|ruido/i })
          .first()
          .click();
        // `#sheet-observations` es OBLIGATORIO: `validateAllFields()` lo pide como
        // "Observaciones" y, si viene vacio, `registerAll` saca un toast
        // «Faltan datos» y el asistente NO avanza. Sin este campo el paso 3 se
        // queda quieto y el fallo aparece 45 s despues, buscando un boton que
        // nunca iba a salir.
        const observaciones = page.locator("#sheet-observations");
        await escribirSeguro(
          observaciones,
          "Ingresa por ruido en frenos. Cliente autoriza revisión.",
          { etiqueta: "«Estado general del vehículo»" },
        );

        // Se escuchan los avisos ANTES de pulsar: si la validacion se queja, hay
        // que poder decir DE QUE se queja, no solo que no aparecio un boton.
        const avisos = [];
        page.on("console", (m) => {
          if (m.type() === "error") avisos.push(m.text().slice(0, 200));
        });
        const toastFaltan = page.getByText(/faltan datos|informaci[oó]n con errores/i).first();

        await page.getByRole("button", { name: /registrar y continuar/i }).click();

        // El cliente de este recorrido es FIJO (tiene que serlo: es el buzon
        // real desde el que se aprueba en el celular), asi que a partir de la
        // segunda corrida SIEMPRE existe ya y la app pide afiliarlo. No es un
        // caso raro: es el caso normal.
        //
        // Se corre una carrera entre el modal y el boton «Finalizar» en vez de
        // esperar un tiempo fijo: el aviso depende de un lookup contra la API y
        // tarda lo que tarde la red.
        const afiliar = page.getByRole("button", { name: /^afiliar y continuar$/i });
        const finalizarTmp = page.getByRole("button", { name: /^finalizar$/i });
        try {
          await expect(afiliar.or(finalizarTmp).first()).toBeVisible({ timeout: 45000 });
        } catch (err) {
          const queja = (await toastFaltan.count())
            ? await toastFaltan.innerText().catch(() => "")
            : "";
          throw new Error(
            "tras «Registrar y continuar» no salio ni el aviso de afiliacion ni «Finalizar».\n" +
              `   sigue en el paso: ${(await page.locator("#sheet-observations").count()) ? "3 (hoja de servicio)" : "otro"}\n` +
              `   «Estado general del vehículo»: "${await page
                .locator("#sheet-observations")
                .inputValue()
                .catch(() => "(no existe)")}"\n` +
              (queja ? `   la app se quejo: ${queja}\n` : "") +
              (avisos.length ? `   consola: ${avisos.slice(0, 3).join(" | ")}\n` : ""),
          );
        }
        if (await afiliar.isVisible().catch(() => false)) {
          console.log("   ℹ️  El cliente ya existía en CCC: lo afilio a este taller.");
          await afiliar.click();
          // El modal de antd deja su capa encima un momento y se traga los clics.
          await expect(
            page.locator(".ant-modal-wrap:visible"),
            "el aviso de afiliación no se cerró",
          ).toHaveCount(0, { timeout: 25000 });
        }

        // Paso 4 del asistente: "Subir evidencias" (opcional para la demo).
        // OJO: el resumen de este paso muestra «OS:» VACIO. No es un error de la
        // app: el folio lo asigna el backend al registrar y el asistente no lo
        // vuelve a leer. Por eso el folio se lee despues, ya en la lista.
        const finalizar = page.getByRole("button", { name: /^finalizar$/i });
        await expect(finalizar).toBeVisible({ timeout: 45000 });
        await finalizar.click();
        await expect(page).toHaveURL(/\/registro/, { timeout: 20000 });

        const tarjetaNueva = await tarjetaDeEntrada(page, AUTO);
        os = await folioDeLaTarjeta(tarjetaNueva);
        expect(os, "no pude leer el folio de OS en la tarjeta de la entrada").toBeTruthy();

        // El id del documento se toma de la URL al abrir el diagnostico desde la
        // tarjeta. Lo necesita el Mecanico en el paso 4, porque su rol no puede
        // entrar a /registro (ver el punto 12 del BACKLOG_TECNICO).
        await tarjetaNueva.getByRole("button", { name: /diagn[oó]stico/i }).first().click();
        await expect(page).toHaveURL(/\/diagnostico-vista\/[^/]+/, { timeout: 20000 });
        entryId = (page.url().match(/\/diagnostico-vista\/([^/?#]+)/) || [])[1];
        expect(entryId, "no pude leer el id de la entrada desde la URL").toBeTruthy();
        creado.entryIds.push(entryId);
        console.log(`\n   📋 OS ${os} · placas ${AUTO.placas} · id ${entryId}\n`);
      });

      // ── 4. El Mecánico diagnostica ──────────────────────────────────────────
      await etapa(page, "4) Mecánico: diagnóstico con semáforo", async () => {
        await cerrarSesion(page);
        await entrarComo(page, EQUIPO.mecanico);

        // OJO — hueco real de navegacion, no del test:
        // el Mecanico SI tiene CAN_CREATE_DIAGNOSTIC, pero la unica pantalla que
        // enlaza al diagnostico es la lista de /registro, que exige
        // CAN_REGISTER_VEHICLE_ENTRY — capability que su rol NO tiene. Con el menu
        // en la mano (Agenda / Servicio / Produccion / Configuracion) no hay forma
        // de llegar: Servicio solo lista entradas ya aprobadas y Produccion solo
        // autos en reparacion. Se entra por URL directa, que su rol si permite.
        // Anotado como punto 12 del BACKLOG_TECNICO.
        await page.goto(`/diagnostico-vista/${entryId}`);

        const nuevo = page.getByRole("button", { name: /nuevo diagn[oó]stico/i }).first();
        await expect(
          nuevo,
          "el Mecanico no pudo abrir la vista de diagnostico de su OS",
        ).toBeVisible({ timeout: 25000 });
        await nuevo.click();

        // Hallazgo 1 — el que genera la venta.
        await page.getByPlaceholder(/Ej\. Frenos/i).first().fill("Frenos");
        await page.getByPlaceholder(/Ej\. Balatas delanteras/i).first().fill("Balatas delanteras");
        const rojo = page.getByRole("radio", { name: /rojo/i }).first();
        if (await rojo.count()) await rojo.click();
        else await page.getByText(/^ROJO$/i).first().click();

        await page
          .getByPlaceholder(/Describe lo encontrado por el técnico/i)
          .first()
          .fill("Balatas delanteras al límite, contacto metal-metal y disco con estrías.");
        await page
          .getByPlaceholder(/Acción sugerida/i)
          .first()
          .fill("Reemplazo inmediato de balatas delanteras y rectificado de discos.");

        // El lente comercial NO va aqui: el Mecanico solo captura lo tecnico
        // (sistema, componente, semaforo, hallazgo y accion sugerida). Traducir eso
        // a lenguaje de cliente es pantalla aparte —"Comercial", /diagnostico-comercial/:id,
        // protegida por CAN_CREATE_QUOTE— y le toca al Asesor. Va en el paso 5.

        const generales = page.getByPlaceholder(/Notas globales del técnico/i);
        if (await generales.count()) {
          await generales.fill("Lo urgente son los frenos delanteros; el resto puede esperar.");
        }

        await page.getByRole("button", { name: /guardar diagn[oó]stico/i }).click();
        // El aviso de validacion real dice "Cada hallazgo necesita sistema,
        // descripcion y clasificacion" — no contiene la palabra "error".
        await expect(
          page.getByText(/cada hallazgo necesita|no se pudo guardar/i).first(),
          "el diagnóstico no pasó la validación de la pantalla",
        ).toHaveCount(0, { timeout: 15000 });
        // Al guardar bien, la app navega sola a la lista de diagnosticos.
        await expect(page).toHaveURL(/\/diagnostico-vista\//, { timeout: 20000 });
        await respiro(page);
      });

      // ── 5A. El Dueño costea ─────────────────────────────────────────────────
      // OJO — el Asesor NO puede costear. `/costeo/:id` exige
      // CAN_VIEW_COST_VS_PRICE, que solo tienen owner y admin: el costo de
      // proveedor y el margen no son cosa suya. (El botón «Costeo» sí se le
      // muestra y lo bota al dashboard sin avisar: punto 13 del BACKLOG_TECNICO.)
      await etapa(page, "5A) Dueño: costeo (costo de proveedor y margen)", async () => {
        await cerrarSesion(page);
        await entrarComo(page, TALLER.admin);

        // El boton "Costeo" agrega ?diagnosticId= a la URL; sin ese parametro la
        // pantalla dice "Falta el diagnóstico de origen". Por eso se entra con
        // clic desde la vista del diagnostico y no con un goto a /costeo.
        await page.goto(`/diagnostico-vista/${entryId}`);
        await page.getByRole("button", { name: /^costeo$/i }).first().click();
        await expect(page.getByRole("heading", { name: /^Costeo$/ })).toBeVisible({ timeout: 20000 });

        // OJO: "Trabajos a realizar" NO se escribe aqui. Son los hallazgos que
        // capturo el Mecanico: el ROJO viene bloqueado (obligatorio) y los
        // amarillos vienen marcados. Esta pantalla define ALCANCE, no texto libre.
        await expect(
          page.getByText(/el diagn[oó]stico no tiene hallazgos/i),
          "el costeo llegó sin hallazgos: el diagnóstico del paso 4 no se guardó",
        ).toHaveCount(0, { timeout: 15000 });

        // Refacción — SIN vincular a inventario: así queda faltante para Compras.
        // Columnas del renglon: 0 Descripcion · 1 Cantidad · 2 Costo proveedor ·
        // 3 Utilidad % · 4 Precio cliente · 5 Subtotal (el Proveedor es <select>).
        const filaCosteo = page
          .locator("div.grid")
          .filter({ has: page.getByPlaceholder(/Ej\. Filtro de aceite OEM/i) })
          .last();
        await filaCosteo
          .getByPlaceholder(/Ej\. Filtro de aceite OEM/i)
          .fill("Juego de balatas delanteras");
        const camposCosteo = filaCosteo.locator("input");
        await camposCosteo.nth(1).fill("2");
        await camposCosteo.nth(2).fill("600");
        await camposCosteo.nth(4).fill("850");

        const guardarCosteo = page.getByRole("button", { name: /guardar costeo/i });
        await expect(
          guardarCosteo,
          "«Guardar costeo» sigue deshabilitado: ni trabajos ni refacciones válidas",
        ).toBeEnabled({ timeout: 10000 });
        await guardarCosteo.click();
        // Guardar el costeo CREA la cotización (stage COSTEO, sin precios de mano
        // de obra) y lleva a la lista. No hay que crear otra después: si se crean
        // dos, al aprobar sale la pantalla de selección oficial.
        await expect(page).toHaveURL(/\/cotizacion-vista\//, { timeout: 20000 });
        await respiro(page);
      });

      // ── 5B. El Asesor traduce y pone precios ────────────────────────────────
      await etapa(page, "5B) Asesor: traducción comercial y precios", async () => {
        await cerrarSesion(page);
        await entrarComo(page, EQUIPO.asesor);

        // ── Traducción comercial ──────────────────────────────────────────────
        // Es lo que el cliente leerá en su celular. Sin esto, la aprobación le
        // llega en lenguaje de taller ("contacto metal-metal") y el paso 6 pierde
        // todo su sentido. La secuencia que marca la propia pantalla es
        // 1.Costeo · 2.Comercial · 3.Cotización.
        await page.goto(`/diagnostico-vista/${entryId}`);
        await page.getByRole("button", { name: /^comercial$/i }).first().click();
        await expect(
          page.getByRole("heading", { name: /traducci[oó]n comercial/i }),
        ).toBeVisible({ timeout: 20000 });

        await page
          .getByPlaceholder(/lenguaje claro, sin tecnicismos/i)
          .first()
          .fill(
            "Las balatas de adelante ya se acabaron y están rozando el disco. Por eso escucha el ruido metálico al frenar.",
          );
        await page
          .getByPlaceholder(/riesgo o costo implica posponerlo/i)
          .first()
          .fill(
            "La distancia de frenado aumenta y el disco se daña, lo que encarece la reparación más adelante.",
          );

        await page.getByRole("button", { name: /guardar traducci[oó]n/i }).click();
        // Al guardar, la app NO regresa a la lista de diagnosticos: lleva a
        // /diagnostico-cliente/:id — la "Vista del cliente", el reporte tal como
        // lo vera en su telefono. Es solo lectura (su unico boton es "Editar
        // traduccion"); la aprobacion no se hace aqui.
        await expect(page).toHaveURL(/\/diagnostico-cliente\//, { timeout: 20000 });
        await expect(
          page.getByRole("heading", { name: /reporte de diagn[oó]stico/i }),
        ).toBeVisible({ timeout: 20000 });
        // Lo que el cliente leera debe estar en cristiano, no en jerga de taller.
        await expect(page.getByText(/ya se acabaron y est[aá]n rozando el disco/i)).toBeVisible();
        await respiro(page);

        // ── Precios sobre la cotización que nació del costeo ──────────────────
        // Se EDITA, no se crea una nueva: la refacción ya trae su precio al
        // cliente y la mano de obra ya trae su descripción (viene del hallazgo).
        // Aquí solo faltan la promesa de entrega y el precio de la mano de obra.
        // /cotizacion-vista/:id es una LISTA de cotizaciones, no una cotizacion.
        // Hay que abrir el renglon ("Costeo · histórico … Ver detalle / editar →"),
        // que despliega un cajon lateral, y ahi esta «Editar cotización».
        await page.goto(`/cotizacion-vista/${entryId}`);
        const renglonCotizacion = page.getByRole("button", { name: /ver detalle/i }).first();
        await expect(
          renglonCotizacion,
          "no hay ninguna cotización listada: ¿se guardó el costeo del paso 5A?",
        ).toBeVisible({ timeout: 20000 });
        await renglonCotizacion.click();

        const editar = page.getByRole("button", { name: /editar cotizaci[oó]n/i }).first();
        await expect(
          editar,
          "el cajón no trae «Editar cotización»: ¿la OS ya no está en espera?",
        ).toBeVisible({ timeout: 20000 });
        await editar.click();
        await expect(page).toHaveURL(/\/cotizacion-editar\//, { timeout: 20000 });
        await expect(page.getByText(/esta cotización viene del/i)).toBeVisible({ timeout: 20000 });

        const manana = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const dosDigitos = (n) => String(n).padStart(2, "0");
        await page
          .locator('input[type="datetime-local"]')
          .first()
          .fill(
            `${manana.getFullYear()}-${dosDigitos(manana.getMonth() + 1)}-${dosDigitos(
              manana.getDate(),
            )}T17:00`,
          );

        // OJO: `isQuotePartsValid`/`isQuoteLaborValid` (src/handle/quote.js) exigen
        // descripcion + cantidad > 0 + costo > 0 en CADA renglon. Si falta uno, el
        // boton no falla: sale un toast "Información incompleta o valores
        // invalidos" y no se guarda nada. La mano de obra llega del costeo con
        // count=1 y cost="", asi que hay que ponerle horas y precio.
        // ✅ ARREGLADO — punto 15 del BACKLOG_TECNICO / obs 19-20 de Roberto.
        // Aqui habia un WORKAROUND: al Asesor le llegaba el "Precio unitario"
        // VACIO porque el campo se llamaba `cost` y `SENSITIVE_FIELDS` lo trataba
        // como costo de proveedor, aunque en una cotizacion sea el precio AL
        // CLIENTE. Habia que recapturar el 850 para que la corrida siguiera.
        // Ahora el precio al cliente se llama `unitPrice` (CAN_VIEW_SELL_PRICE),
        // asi que al Asesor SI le llega: en vez de recapturarlo, se comprueba.
        const filaRefaccion = page
          .locator("div.grid")
          .filter({ has: page.getByPlaceholder(/Ej\. Filtro de aceite OEM/i) })
          .last();
        await expect(
          filaRefaccion.locator("input").nth(2),
          "punto 15: el Asesor debe recibir el precio al cliente ya capturado en el Costeo",
        ).toHaveValue(/850/, { timeout: 15000 });

        // La mano de obra arranca OCULTA. QuoteEdit nace con `laborNA` en true
        // (o sea "Sin cotizar" marcado) y LaborList esconde la lista entera
        // mientras lo este. Antes esto no hacia falta: el Costeo mandaba las
        // lineas de mano de obra ya armadas desde los hallazgos incluidos.
        // Hoy manda `labor: []` a proposito —"QuoteEdit arranca con su propio
        // renglon editable"— asi que la casilla nunca se destapa sola y es el
        // Asesor quien decide cotizar mano de obra. Se destapa como el:
        const sinCotizar = page.getByRole("checkbox", { name: /sin cotizar/i }).first();
        await expect(
          sinCotizar,
          "no encontre la casilla «Sin cotizar» de Mano de obra",
        ).toBeVisible({ timeout: 20000 });
        if (await sinCotizar.isChecked()) await sinCotizar.uncheck();

        const filaManoObra = page
          .locator("div.grid")
          .filter({ has: page.getByPlaceholder(/Ej\. Cambio de aceite/i) })
          .last();
        const camposManoObra = filaManoObra.locator("input");
        // La DESCRIPCION tambien hay que teclearla. Antes venia puesta: el
        // Costeo mandaba las lineas de mano de obra armadas desde los hallazgos.
        // Hoy el renglon de QuoteEdit nace vacio, y `isValid` (handle/quote.js)
        // exige descripcion + cantidad > 0 + precio > 0 en CADA linea; sin ella
        // el guardado se rechaza con «Informacion incompleta o valores
        // invalidos» y la pantalla se queda donde estaba, sin decir cual falto.
        await camposManoObra.nth(0).fill("Cambio de balatas delanteras");
        await camposManoObra.nth(1).fill("2");
        await camposManoObra.nth(2).fill("450");

        await expect(
          page.getByText(/\$\s*2,600\.00/).first(),
          "el total no cuadró: 2×850 de refacción + 2×450 de mano de obra",
        ).toBeVisible({ timeout: 10000 });

        await page.getByRole("button", { name: /^guardar$/i }).first().click();
        // Al guardar bien, la app regresa sola a la lista. Si no se mueve, casi
        // siempre es el toast "Información incompleta o valores invalidos" — que
        // NO contiene la palabra "error", por eso se busca por su texto.
        await expect(
          page,
          "la cotización no se guardó (revisa si salió «Información incompleta»)",
        ).toHaveURL(/\/cotizacion-vista\//, { timeout: 20000 });
        console.log("   💰 Cotización con precios; la OS queda en espera del cliente.");
        await respiro(page);
      });

      // ── 6. LA PAUSA: el cliente aprueba desde su celular ────────────────────
      await etapa(page, "6) Aprobación del cliente", async () => {
        // El cliente es el MISMO en todas las corridas (tiene que serlo: es el
        // buzon real), asi que a estas alturas esta afiliado a decenas de
        // talleres de prueba... y en todos su orden es la "OS 1". Decir solo
        // "aprueba la OS 1" no identifica nada. Por eso se imprimen el taller,
        // las placas y el auto: eso si es unico por corrida.
        console.log(
          "\n" +
            "   ┌──────────────────────────────────────────────────────────────\n" +
            "   │  AHORA EN EL CELULAR:\n" +
            "   │\n" +
            `   │  Cuenta:  ${CLIENTE.correo}\n` +
            "   │           ('Activa tu cuenta' desde el correo si es la 1a vez)\n" +
            "   │\n" +
            "   │  BUSCA ESTA, no otra — el cliente esta afiliado a varios talleres:\n" +
            `   │    Taller:  ${TALLER.nombre}\n` +
            `   │    Placas:  ${AUTO.placas}\n` +
            `   │    Auto:    ${AUTO.marca} ${AUTO.modelo} ${AUTO.anio} ${AUTO.color}\n` +
            `   │    Orden:   OS ${os}\n` +
            "   │\n" +
            "   │  Abre su cotizacion y toca APROBAR.\n" +
            "   └──────────────────────────────────────────────────────────────\n",
        );

        // Se vigila la PANTALLA del taller, no la API.
        //
        // Se vigila la pestaña "Aprobados", NO "Activos". El API filtra por
        // `approvalState` segun la pestaña (Entrada.jsx → getListFiltersForTab),
        // asi que al aprobar la OS se va de "Activos": la version anterior de
        // este sondeo esperaba a que la tarjeta cambiara de etiqueta ahi, y lo
        // que pasaba era que la tarjeta desaparecia. El test reventaba
        // justo cuando el cliente HACIA lo que se le pedia.
        //
        // Que la tarjeta APAREZCA en "Aprobados" ES la aprobacion: lo afirma el
        // servidor, no una etiqueta de la UI. Y de paso deja de ser posible
        // confundirla con "No aprobada", que vive en otra pestaña.
        const limite = Date.now() + ESPERA_MS;
        let vueltas = 0;
        let aprobada = false;
        let rechazada = false;

        while (Date.now() < limite) {
          if (await estaEnPestania(page, AUTO, "aprobados")) {
            aprobada = true;
            break;
          }

          // Un rechazo no se puede quedar esperando 20 minutos a que expire el
          // reloj: se detecta y se dice lo que paso.
          if (vueltas % 4 === 0) {
            if (await estaEnPestania(page, AUTO, "no-aprobados", 4000)) {
              rechazada = true;
              break;
            }
            const restan = Math.round((limite - Date.now()) / 1000);
            console.log(`   ⏳ Esperando la aprobación en la app... (${restan}s)`);
          }
          vueltas += 1;
          await page.waitForTimeout(SONDEO_MS);
        }

        expect(
          rechazada,
          "El cliente RECHAZÓ la cotización desde la app: la OS aparecio en " +
            "«No Aprobados». El recorrido necesita que se APRUEBE.",
        ).toBe(false);
        expect(
          aprobada,
          `El cliente no aprobó en ${Math.round(ESPERA_MS / 60000)} min. ` +
            "Sube E2E_ESPERA_MS si necesitas mas tiempo. No hay modo sin celular: " +
            "aprobar es del cliente, y saltarselo es dejar de probar el producto.",
        ).toBe(true);
        // Contraprueba: si de verdad esta aprobada, el servidor ya NO la puede
        // devolver en "Activos" (esa pestaña pide approvalState = EN ESPERA).
        // Es barato y cierra la puerta a que el sondeo vuelva a cantar victoria
        // antes de tiempo: fue exactamente lo que paso cuando el buscador
        // colaba la tarjeta en una pestaña que no le tocaba.
        expect(
          await estaEnPestania(page, AUTO, null, 6000),
          "el sondeo dio por aprobada la OS, pero el servidor la sigue " +
            "devolviendo en «Activos» (approvalState = EN ESPERA). La señal de " +
            "aprobacion esta mintiendo.",
        ).toBe(false);
        console.log("\n   ✅ ¡Aprobada desde el celular!\n");

        // OBS31-01 — la mitad que nadie estaba probando.
        //
        // Antes, aprobar la cotizacion mandaba el auto directo a "Refacciones",
        // aunque no hubiera llegado una sola pieza. La regla nueva
        // (routes/V1/entries.js: al aprobar solo se avanza a EN_ESPERA) es que
        // el auto queda EN ESPERA y a Refacciones lo dispara el abastecimiento.
        //
        // Sin estas dos lineas el recorrido pasaba IGUAL con el bug viejo.
        const trasAprobar = await tarjetaDeEntrada(page, AUTO, { tab: "aprobados" });
        await expect(
          trasAprobar,
          "tras aprobar, el auto deberia quedar En espera",
        ).toContainText(/en espera/i, { timeout: 20000 });
        await expect(
          trasAprobar,
          "REGRESION OBS31-01: el auto salto a Refacciones con solo aprobar, " +
            "sin que Abastecimiento hubiera recibido nada",
        ).not.toContainText(/refacciones/i);
      });

      // ── 7. Compras recibe la refacción ──────────────────────────────────────
      await etapa(page, "7) Compras: recepción de la refacción faltante", async () => {
        await cerrarSesion(page);
        await entrarComo(page, EQUIPO.compras);

        // La pantalla de Abastecimiento pinta EXACTAMENTE el mismo vacio
        // ("Sin ordenes de compra") cuando no hay pedidos y cuando la respuesta
        // del API no trae lo que el front espera. Con eso solo, el fallo no dice
        // nada: hay que ver el cuerpo que llego. Mismo criterio que la etapa 8.
        const respuestasPedidos = [];
        page.on("response", async (res) => {
          if (!res.url().includes("/purchase-orders")) return;
          try {
            const cuerpo = await res.text();
            respuestasPedidos.push(
              `${res.status()} ${res.url()}\n         ${cuerpo.slice(0, 900)}`,
            );
          } catch (_) {
            respuestasPedidos.push(`${res.status()} ${res.url()} (sin cuerpo legible)`);
          }
        });

        await page.goto("/abastecimiento");
        // Al aprobar, el sistema generó el pedido solo: aquí solo se recibe.
        const recibir = page.getByRole("button", { name: /^recibir$/i }).first();
        try {
          await expect(recibir).toBeVisible({ timeout: 25000 });
        } catch (err) {
          const vacio = await page.getByText(/sin [oó]rdenes de compra/i).count();
          const fallo = await page.getByText(/no se pudieron cargar los pedidos/i).count();
          throw new Error(
            "no apareció ningún pedido por recibir en Abastecimiento.\n" +
              `   pantalla: ${fallo ? "ERROR de carga" : vacio ? "vacío («Sin órdenes de compra»)" : "ni vacío ni error"}\n` +
              `   OS: ${os}   entryId: ${entryId}\n` +
              "   respuestas de /purchase-orders que vio el navegador:\n     " +
              (respuestasPedidos.length ? respuestasPedidos.join("\n     ") : "NINGUNA (el front nunca pidió la lista)") +
              "\n   Para contrastar contra los datos:\n" +
              `     node scripts/diagnostico-abastecimiento-e2e.js ${entryId}   (desde ccc-backend/functions)`,
          );
        }
        await recibir.click();

        const modal = page.getByRole("dialog").filter({ hasText: /registrar recepci[oó]n/i }).first();
        const caja = (await modal.count()) ? modal : page;

        // Cantidad recibida: el formulario suele traerla precargada al total.
        const cantidad = caja.locator('input[inputmode="numeric"]').first();
        if (await cantidad.count()) await cantidad.fill("2");

        await caja.getByRole("button", { name: /registrar recepci[oó]n/i }).click();
        await expect(
          page.getByText(/no se pudo registrar la recepci[oó]n/i).first(),
        ).toHaveCount(0, { timeout: 20000 });

        // El modal de antd tarda en irse y su capa (.ant-modal-wrap) se queda
        // encima tragándose los clics: el boton de abajo se ve, se puede pulsar y
        // aun asi el clic no llega. Hay que esperar a que desaparezca, y de paso
        // recargar para tener la pantalla en estado limpio.
        await expect(
          page.locator(".ant-modal-wrap:visible"),
          "el modal de recepción no se cerró",
        ).toHaveCount(0, { timeout: 25000 });
        await page.goto("/abastecimiento");

        // Recibir la pieza NO basta para que el Mecanico pueda arrancar.
        // `production.service.js` bloquea el inicio si la OS tiene ordenes de
        // compra activas y `repairReadiness` sigue en "NINGUNO"; el mensaje que
        // devuelve es literalmente "marca Inicio parcial o Completo antes de
        // iniciar la reparacion". Ese interruptor es este, y es manual:
        const completo = page.getByRole("button", { name: /^completo$/i }).first();
        await expect(
          completo,
          "no encontré el validador «Reparación: Completo» en Abastecimiento",
        ).toBeVisible({ timeout: 20000 });

        // OJO: el boton se deshabilita cuando YA es el valor activo
        // (`disabled={saving || active}`), asi que "deshabilitado" aqui significa
        // "ya quedo en Completo". Solo se pulsa si sigue habilitado — y si se
        // deshabilita a MITAD del clic (la tarjeta refresca tras la recepcion
        // y puede aterrizar ya en Completo: isEnabled() y el clic son dos
        // momentos distintos), eso tambien es exito, no timeout. La unica
        // verdad es la asercion de abajo: deshabilitado = quedo en Completo.
        if (await completo.isEnabled()) {
          await completo.click({ timeout: 5000 }).catch(() => {});
        }
        await expect(
          completo,
          "la OS no quedó marcada como «Completo»: el paso 8 se va a trabar",
        ).toBeDisabled({ timeout: 20000 });

        // La otra mitad de OBS31-01: el abastecimiento SI mueve el auto.
        //
        // Pero el tablero de /registro NO es de Compras: su menu no trae
        // "Entrada de Vehículo" y el router lo rebota a /dashboard. Quien
        // vigila el avance del auto es el Asesor, asi que se cambia de sesion
        // para comprobarlo — igual que pasaria en el taller.
        await cerrarSesion(page);
        await entrarComo(page, EQUIPO.asesor);
        const trasRecibir = await tarjetaDeEntrada(page, AUTO, { tab: "aprobados" });
        await expect(
          trasRecibir,
          "tras recibir la refaccion el auto deberia estar en Refacciones; " +
            "si sigue En espera, el disparo desde abastecimiento se rompio",
        ).toContainText(/refacciones/i, { timeout: 20000 });
        await respiro(page);
      });

      // ── 8. El Mecánico repara ───────────────────────────────────────────────
      await etapa(page, "8) Mecánico: reparación con cronómetro", async () => {
        await cerrarSesion(page);
        await entrarComo(page, EQUIPO.mecanico);

        // El hook de Producción se traga los errores del API
        // (`catch { setEntries([]) }`), asi que un 500 se ve igual que "no hay
        // autos". Se escuchan las respuestas para poder distinguirlos.
        const fallosApi = [];
        const listados = [];
        page.on("response", async (res) => {
          if (!res.url().includes("/entries")) return;
          if (res.status() >= 400) {
            try {
              fallosApi.push(`${res.status()} ${res.url()}\n         ${(await res.text()).slice(0, 700)}`);
            } catch (_) {
              fallosApi.push(`${res.status()} ${res.url()} (sin cuerpo)`);
            }
            return;
          }
          // Respuesta buena: guardamos las entradas TAL COMO LE LLEGAN AL FRONT.
          // No es lo mismo que hay en Firestore: `sanitizeResponse` le quita al
          // rol los campos que no puede ver, y el filtro del front decide con lo
          // que le llegó, no con lo que existe.
          try {
            const cuerpo = await res.json();
            const lista = cuerpo?.data?.entries ?? cuerpo?.entries ?? null;
            if (Array.isArray(lista)) listados.push(lista);
          } catch (_) {
            /* no era JSON */
          }
        });

        await page.goto("/produccion");
        await expect(page.getByText(/tus autos asignados/i)).toBeVisible({ timeout: 25000 });

        // El panel con el cronometro solo existe para el auto SELECCIONADO. La
        // pantalla auto-selecciona el primero de la lista, que con un taller
        // reutilizado puede no ser el nuestro: se hace clic explicito.
        // `(?!\\d)` y NO `\\b`. El folio va pegado al siguiente texto porque
        // ProductionCenter pinta `<span>OS {sheet}</span>` seguido del modelo sin
        // separador: el textContent del boton es "OS 1Nissan Versa 2023 …". Entre
        // el "1" y la "N" NO hay frontera de palabra (ambos son \\w), asi que
        // `\\b` no casa nunca. Lo que se queria decir es "que no siga otro
        // digito", para que la OS 1 no cace con la OS 12 — y eso es `(?!\\d)`.
        const autoEnProduccion = page
          .getByRole("button")
          .filter({ hasText: new RegExp(`OS ${literal(os)}(?!\\d)`) })
          .first();

        // Si no aparece, el motivo casi siempre es a quién quedó asignada la OS.
        // Antes de fallar se leen los dos datos que lo deciden, para no tener que
        // adivinar en el log. Es diagnóstico, no parte del flujo probado.
        if (!(await autoEnProduccion.count())) {
          await page.waitForTimeout(3000);
        }
        if (!(await autoEnProduccion.count())) {
          try {
            const { db } = require("../../qaAdmin");
            const entrada = await db().collection("entries").doc(entryId).get();
            const datos = entrada.exists ? entrada.data() : null;
            const mec = await db()
              .collection("users")
              .where("email", "==", EQUIPO.mecanico.correo)
              .get();
            console.log("\n   🔍 Por qué no aparece en Producción:");
            console.log(`      assigned_mechanic = ${JSON.stringify(datos?.assigned_mechanic ?? null)}`);
            console.log(`      uid del Mecánico  = ${mec.empty ? "(no existe)" : mec.docs[0].id}`);
            console.log(`      approvalState     = ${datos?.approvalState ?? "?"}`);
            // OJO: el id oficial vive ANIDADO en `approvedSelection`, no en un
            // campo plano; `approvedQuoteId` suelto es legado y casi siempre
            // viene vacío aunque la selección oficial sí exista.
            console.log(`      approvedSelection = ${JSON.stringify(datos?.approvedSelection ?? null)}`);
            console.log(`      statusService     = ${datos?.statusService ?? "?"}`);
            console.log(`      repairReadiness   = ${datos?.repairReadiness ?? "?"}`);
            if (fallosApi.length) {
              console.log("      ⚠️  El API de /entries respondió con error:");
              for (const f of fallosApi) console.log(`         ${f}`);
              const texto = fallosApi.join(" ");
              if (/currently building/i.test(texto)) {
                console.log(
                  "         👉 El índice YA existe y se está CONSTRUYENDO. No hay nada que\n" +
                    "            arreglar: espera unos minutos (Firebase → Firestore → Índices,\n" +
                    "            hasta que pase de «Building» a «Enabled») y vuelve a correr.",
                );
              } else if (/requires an index/i.test(texto)) {
                console.log(
                  "         👉 Falta un índice compuesto. Ese enlace lo crea, pero lo correcto\n" +
                    "            es agregarlo a ccc-backend/firestore.indexes.json y desplegarlo\n" +
                    "            a refac Y a prod (ver punto 16 del BACKLOG_TECNICO).",
                );
              }
            } else {
              console.log("      (el API de /entries respondió bien: descarta el filtro del front)");
              const lista = listados[listados.length - 1] || [];
              console.log(`      el API devolvió ${lista.length} entrada(s) para este rol`);
              const mia = lista.find((e) => e?.id === entryId);
              if (!mia) {
                console.log("      ⚠️  NUESTRA OS NO VIENE en la respuesta: el backend ya la filtró.");
                console.log(`         ids devueltos: ${lista.map((e) => e?.id).join(", ") || "(ninguno)"}`);
              } else {
                // Estos cuatro son EXACTAMENTE los que mira useProductionCenter.
                console.log("      la OS sí viene; así la ve el front:");
                console.log(`         statusService     = ${mia.statusService ?? "(vacío)"}`);
                console.log(`         approvalState     = ${mia.approvalState ?? "(vacío)"}`);
                console.log(`         approvedSelection = ${JSON.stringify(mia.approvedSelection ?? null)}`);
                console.log(`         assigned_mechanic = ${JSON.stringify(mia.assigned_mechanic ?? null)}`);
                console.log("         (si alguno sale vacío aquí pero sí está en Firestore,");
                console.log("          se lo quitó sanitizeResponse por el rol del Mecánico)");
              }
            }
            console.log("");
          } catch (e) {
            console.log(`   🔍 No pude leer el diagnóstico: ${e.message}`);
          }
        }

        await expect(
          autoEnProduccion,
          `la OS ${os} no aparece en Producción: revisa que el mecánico asignado sea el correcto`,
        ).toBeVisible({ timeout: 25000 });
        await autoEnProduccion.click();

        await page.getByRole("button", { name: /^iniciar$/i }).first().click();
        await expect(page.getByText(/en reparaci[oó]n/i).first()).toBeVisible({ timeout: 20000 });
        await page.waitForTimeout(2000); // que el cronómetro registre tiempo real

        await page.getByRole("button", { name: /^terminar$/i }).first().click();
        await expect(page.getByText(/control de calidad/i).first()).toBeVisible({ timeout: 20000 });
        await respiro(page);
      });


      return { os, entryId };
    }

    /** La entrega, aparte: entre "listo" y "entregado" cabe otra prueba. */
    async function entregarAuto(AUTO, os) {

      // ── 9. El Asesor entrega ────────────────────────────────────────────────
      await etapa(page, "9) Asesor: entrega del vehículo", async () => {
        await cerrarSesion(page);
        await entrarComo(page, EQUIPO.asesor);

        // La entrega NO se hace desde la lista de entradas: se hace en Servicio,
        // cambiando "Status del vehículo" a Entregado. Sale un modal de
        // confirmacion porque la accion no se puede revertir.
        await page.goto("/servicios");
        const buscador = page.getByRole("textbox", { name: /filtrar por n[uú]mero de os o placas/i });
        if (await buscador.count()) {
          await buscador.fill(AUTO.placas);
          await page.getByRole("button", { name: /^buscar$/i }).first().click();
        }

        const tarjetaServicio = page
          .locator("div.rounded-lg:visible")
          // Mismo motivo que en Produccion: `\\b` falla si el folio queda pegado
          // al texto siguiente. Lo que importa es que no le siga otro digito.
          .filter({ hasText: new RegExp(`OS:\\s*${literal(os)}(?!\\d)`) })
          .first();
        await expect(
          tarjetaServicio,
          `la OS ${os} no aparece en Servicio: ¿quedó en Control de calidad?`,
        ).toBeVisible({ timeout: 25000 });

        await tarjetaServicio.locator(".ant-select").first().click();
        await page
          .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="Entregado"]')
          .click();

        // Modal "Confirmar entrega de vehículo". OJO: el boton dice
        // "Entregar Vehiculo", SIN acento (asi esta en ChangeStatusWarn.jsx).
        const confirmar = page.getByRole("button", { name: /entregar veh[ií]culo/i });
        await expect(confirmar, "no salió el modal de confirmación de entrega").toBeVisible({
          timeout: 20000,
        });
        await confirmar.click();

        // El backend bloquea entregar una OS sin diagnostico (409); ese seria el
        // unico motivo esperable de fallo aqui.
        await expect(
          page.getByText(/no se pudo actualizar el estatus|entrega bloqueada/i).first(),
        ).toHaveCount(0, { timeout: 20000 });
        await expect(page.getByText(/estatus actualizado/i).first()).toBeVisible({ timeout: 20000 });
        console.log(`\n   🏁 OS ${os} entregada. Recorrido completo, todo por pantalla.\n`);
      });

    }


    // ── Auto 1: el ciclo entero, hasta entregarlo ───────────────────────────
    PREFIJO_ETAPA = "Auto 1 · ";
    const auto1 = await recorridoDeUnAuto(AUTOS[0]);
    await entregarAuto(AUTOS[0], auto1.os);

    // ── Auto 2: el mismo ciclo, pero se deja SIN entregar ───────────────────
    // Sin entregar a proposito: el bloqueo de OS duplicada solo aplica a un
    // auto con entrada ACTIVA, asi que hay que intentarlo antes de la entrega.
    PREFIJO_ETAPA = "Auto 2 · ";
    const auto2 = await recorridoDeUnAuto(AUTOS[1]);

    // ── Intento de dar entrada a un auto que YA esta en el taller ───────────
    //
    // Observacion #1 del cliente: dos OS abiertas para el mismo vehiculo. El
    // guardia vive en `entries.service.js:366` (backend) y en `handleContinue`
    // de Step1Choice.jsx (front), que consulta la OS activa ANTES de navegar.
    // Lo que debe pasar: aviso con el motivo y NO avanzar al alta.
    PREFIJO_ETAPA = "";
    await etapa(page, "10) Un auto que ya esta en el taller no admite otra OS", async () => {
      // El auto 2 se deja SIN entregar, asi que su ultima etapa es la 8 y la
      // sesion que queda abierta es la del MECANICO. Y /registro no es suya: su
      // menu no trae "Entrada de Vehículo" y el router lo rebota a /servicios,
      // donde no existe el boton «Nueva entrada». Quien da de alta entradas es
      // el Asesor, asi que se entra como el.
      await cerrarSesion(page);
      await entrarComo(page, EQUIPO.asesor);

      await page.goto("/registro");
      await expect(
        page,
        "/registro rebotó: la sesión abierta no puede ver la Entrada de Vehículos",
      ).toHaveURL(/\/registro/, { timeout: 20000 });
      await page.getByRole("button", { name: /nueva entrada/i }).click();
      // «Nueva entrada» lleva a /elegir-vehiculo (Step1Choice: buscar cliente o
      // vehiculo). OJO con meter `registro` suelto en este patron: es la pagina
      // de la que VENIMOS, asi que una navegacion que no ocurre pasaria la
      // asercion sin que nadie se entere.
      await expect(
        page,
        "«Nueva entrada» no llevó al paso 1 de alta",
      ).toHaveURL(/elegir-vehiculo|registrar-entrada|paso-1|step1/, { timeout: 20000 });

      const buscador = page.getByPlaceholder(/nombre, email, tel[eé]fono o placas/i);
      await expect(buscador, "no encontre el buscador de clientes del paso 1").toBeVisible({ timeout: 20000 });
      await escribirSeguro(buscador, AUTOS[1].placas, { etiqueta: "el buscador del paso 1" });
      await page.getByRole("button", { name: /^buscar$/i }).first().click();

      // Elegir el vehiculo: se ubica su RENGLON por las placas (unicas por
      // corrida) y se marca su radio.
      //
      // Antes se hacia `locator("text=PLACAS").click()`, que pulsa la CELDA de
      // las placas. El cliente de pruebas acumula autos de corridas anteriores
      // —en la ultima corrida tenia seis—, asi que ahi hay una tabla de verdad:
      // lo que selecciona el renglon es el radio de la primera columna, y un
      // clic en otra celda puede no marcarlo. Si no marca, «Continuar» se queda
      // apagado y el fallo aparece en el paso siguiente, lejos de la causa.
      const fila = page.getByRole("row").filter({ hasText: AUTOS[1].placas }).first();
      await expect(fila, `no aparece el auto ${AUTOS[1].placas} en la busqueda`).toBeVisible({ timeout: 20000 });
      const radio = fila.getByRole("radio").first();
      if (await radio.count()) await radio.click();
      else await fila.click();

      const continuar = page.getByRole("button", { name: /^continuar$/i });
      await expect(continuar, "no se activo «Continuar» tras elegir el auto").toBeVisible({ timeout: 20000 });
      await continuar.click();

      // El aviso trae el MOTIVO y el folio de la OS viva (obs 8-jul #5).
      await expect(
        page.getByText(/este veh[ií]culo ya est[aá] en taller/i).first(),
        "no salio el aviso de OS duplicada: se puede abrir una segunda OS del mismo auto",
      ).toBeVisible({ timeout: 20000 });
      await expect(
        page.getByText(new RegExp(`OS ${auto2.os}`, "i")).first(),
        "el aviso no dice cual es la OS activa: el usuario no sabe adonde ir",
      ).toBeVisible({ timeout: 10000 });

      // Y NO debe dejar avanzar al alta del vehiculo.
      //
      // El «Cancelar» se busca DENTRO del dialogo. Hay otro «Cancelar» en la
      // pagina de abajo, y como va antes en el DOM, un `.first()` suelto se
      // queda con ese: el velo de antd (.ant-modal-wrap) se traga el clic y el
      // test agota el tiempo pulsando un boton tapado.
      const avisoDuplicada = page.getByRole("dialog").filter({ hasText: /ya est[aá] en taller/i }).first();
      await avisoDuplicada.getByRole("button", { name: /^cancelar$/i }).click();

      // El velo tarda en irse; si no se espera, lo siguiente vuelve a chocar.
      await expect(
        page.locator(".ant-modal-wrap:visible"),
        "el aviso de OS duplicada no se cerró",
      ).toHaveCount(0, { timeout: 20000 });

      // Seguimos en el paso 1, NO en el alta. Se afirma donde SI estamos: un
      // `not.toHaveURL` pasa igual desde cualquier pantalla, incluida una de
      // error, y eso no prueba nada.
      await expect(
        page,
        "tras cancelar el aviso no seguimos en el paso 1: el bloqueo dejó avanzar",
      ).toHaveURL(/elegir-vehiculo/, { timeout: 10000 });
      console.log("\n   🛑 Bloqueo de OS duplicada: correcto.\n");
    });

    // ── Ahora si, se entrega el segundo auto ────────────────────────────────
    PREFIJO_ETAPA = "Auto 2 · ";
    await entregarAuto(AUTOS[1], auto2.os);
    PREFIJO_ETAPA = "";

    console.log(
      `\n   🏁🏁 Dos autos entregados (OS ${auto1.os} y OS ${auto2.os}) ` +
        "y el duplicado bloqueado. Todo por pantalla.\n",
    );

  },
);

// ═══════════════════════════════════════════════════════════════════════════
// LIMPIEZA — solo si la corrida FALLÓ
// ═══════════════════════════════════════════════════════════════════════════
//
// Cada corrida crea un Asesor, un Mecánico y un Compras nuevos (los nombres
// llevan el sello de la corrida a propósito: el selector de mecánico es un
// CreatableSelect y con nombres repetidos elegiría al de otra corrida). Si la
// prueba pasa, ese rastro se queda — es un recorrido completo y sirve de
// evidencia. Si falla, no sirve para nada y solo ensucia el taller, así que se
// borra lo que alcanzó a crear.
//
// Lo que NUNCA se borra aquí:
//   · el Dueño y el taller,
//   · el CLIENTE (rsv.cup@gmail.com y compañía son cuentas reales de la demo,
//     y la corrida las reutiliza, no las crea).
//
// Para conservar el rastro aunque falle: E2E_SIN_LIMPIEZA=1
// Para vaciar a mano lo acumulado de corridas viejas:
//   node scripts/limpiar-taller-pruebas.js ./serviceAccountKey.json --dueno=<correo>
test.afterEach(async ({}, testInfo) => {
  const fallo = testInfo.status !== testInfo.expectedStatus;
  if (!fallo) return;
  if (process.env.E2E_SIN_LIMPIEZA === "1") {
    console.log("\n   🧹 E2E_SIN_LIMPIEZA=1 → dejo el rastro de la corrida fallida.\n");
    return;
  }
  if (!creado.usuarios.length && !creado.entryIds.length) return;

  // La limpieza NUNCA debe tapar el fallo real: si algo aquí truena, se avisa
  // y se sigue. El test ya está marcado como fallido.
  try {
    const { db, auth } = require("../../qaAdmin");

    console.log("\n   🧹 La corrida falló: borro lo que había creado…");

    for (const correo of creado.usuarios) {
      const snap = await db().collection("users").where("email", "==", correo).get();
      for (const doc of snap.docs) {
        try {
          await auth().deleteUser(doc.id);
        } catch (_) {
          /* puede no existir en Auth */
        }
        await doc.ref.delete();
      }
      try {
        const u = await auth().getUserByEmail(correo);
        await auth().deleteUser(u.uid);
      } catch (_) {
        /* ya no estaba */
      }
      console.log(`      ✗ usuario ${correo}`);
    }

    for (const entryId of creado.entryIds) {
      // Al aprobar, el backend genera solo la orden de compra y los
      // seguimientos de lo que no se llevó. Si se borra la OS y no ellos,
      // quedan huérfanos apuntando a una entrada que ya no existe.
      for (const coleccion of ["purchase_orders", "followups"]) {
        const snap = await db().collection(coleccion).where("entryId", "==", entryId).get();
        for (const doc of snap.docs) await doc.ref.delete();
        if (snap.size) console.log(`      ✗ ${snap.size} de ${coleccion}`);
      }

      const ref = db().collection("entries").doc(entryId);
      for (const sub of ["quotes", "diagnostics", "service_sheet"]) {
        const snap = await ref.collection(sub).get();
        for (const doc of snap.docs) await doc.ref.delete();
      }
      await ref.delete();
      console.log(`      ✗ OS ${entryId}`);
    }

    for (const unAuto of AUTOS) {
      const autos = await db().collection("cars").where("codeCar", "==", unAuto.placas).get();
      for (const doc of autos.docs) await doc.ref.delete();
      if (autos.size) console.log(`      ✗ auto ${unAuto.placas}`);
    }

    console.log("   🧹 Listo: el taller queda como antes de esta corrida.\n");
  } catch (e) {
    console.log(`   ⚠️  No pude limpiar (${e.message}). Hazlo con scripts/limpiar-taller-pruebas.js\n`);
  }
});
