const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * e2e_v2 — RECORRIDO COMPLETO POR INTERFAZ, SIN ATAJOS POR API
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Todo lo que aquí ocurre pasa por la pantalla, clicando como una persona:
 * el registro del taller y su pago, el alta del equipo, la recepción del auto,
 * el diagnóstico, la cotización, el abastecimiento, la reparación y la
 * entrega. NO hay una sola llamada directa al backend — ni para sembrar, ni
 * para verificar, ni para avanzar estados.
 *
 * Es el hermano estricto de tests/demo/recorrido-multirol-qa.spec.js: aquel
 * cambia de sesión por UI pero ejecuta las acciones por API (rápido y robusto,
 * pero ciego a las pantallas). Este no: si un formulario se rompe, este truena.
 *
 * Cada etapa la hace el rol que le toca, cerrando e iniciando sesión de verdad.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *
 * 1) PRIMERA VEZ — registra un taller NUEVO y paga con la tarjeta de prueba de
 *    Stripe. Tarda, pero te imprime las credenciales del taller al final:
 *
 *      cd C:\Users\USER\Documents\TRABAJO\ccc-testing
 *      $env:BASE_URL="https://ccc-frontend-qa.vercel.app"
 *      $env:SKIP_SEED="1"
 *      npm run test:e2e2
 *
 * 2) DE AHÍ EN ADELANTE — reutiliza ese taller y se salta el registro, que es
 *    lo lento. Esta es la receta del día a día:
 *
 *      $env:E2E_TALLER_EMAIL="rsv_gpa+e2e600663@outlook.com"
 *      $env:E2E_TALLER_PASSWORD="Demo1234"
 *      npm run test:e2e2
 *
 *    Las variables se quedan puestas mientras no cierres esa terminal, así que
 *    para repetir basta `npm run test:e2e2`.
 *
 * 3) ENSAYO SIN CELULAR — llega hasta la entrega sin esperar la aprobación
 *    real (ver "LA PAUSA DEL CELULAR" más abajo):
 *
 *      $env:APROBAR_EN_WEB="1"
 *      npm run test:e2e2
 *      $env:APROBAR_EN_WEB=""      # para volver al modo con celular
 *
 * 4) PARA PRESENTARLO EN VIVO — con pausas visibles entre pasos:
 *
 *      $env:E2E_LENTO="1"
 *      npm run test:e2e2
 *
 * ── CUANDO FALLA ──────────────────────────────────────────────────────────
 *
 * Cada etapa deja captura + HTML en `scripts/debug-e2e2/`, nombrados con la
 * etapa y la hora. Ese HTML es lo más útil para saber por qué no apareció un
 * campo: se abre y se busca el selector a mano.
 *
 *      npx playwright show-report      # el reporte con video de la corrida
 *
 * ── LIMPIEZA DEL TALLER DE PRUEBAS ────────────────────────────────────────
 *
 * Cada corrida crea un Asesor, un Mecánico y un Compras NUEVOS. No es descuido:
 * el selector de mecánico es un CreatableSelect que filtra por nombre, y con
 * tres "Javier Mora" en el taller elegiría al de otra corrida — la OS quedaría
 * asignada a un mecánico que no es el que va a iniciar sesión, y el paso 4
 * reventaría con 403. Por eso los apellidos llevan el sello de la corrida.
 *
 * a) AUTOMÁTICO — si la corrida FALLA, este archivo borra al final lo que
 *    alcanzó a crear (los tres usuarios, la OS y el auto). Si PASA, no borra
 *    nada: el rastro sirve de evidencia. Nunca toca al Dueño ni al cliente
 *    (rsv.cup@gmail.com y compañía son cuentas reales de la demo; la corrida
 *    las reutiliza, no las crea). Ver el hook `test.afterEach` al final.
 *
 *      $env:E2E_SIN_LIMPIEZA="1"   # conservar el rastro aunque falle
 *
 * b) A MANO — para vaciar lo que dejaron corridas viejas. Corre en seco por
 *    defecto: te lista qué borraría y no toca nada hasta que agregues --apply.
 *    Solo funciona contra refac; se niega a correr contra producción:
 *
 *      cd C:\Users\USER\Documents\TRABAJO\ccc-backend\functions
 *      node scripts/limpiar-taller-pruebas.js ./serviceAccountKey.json \
 *           --dueno=rsv_gpa+e2e600663@outlook.com
 *      node scripts/limpiar-taller-pruebas.js ./serviceAccountKey.json \
 *           --dueno=rsv_gpa+e2e600663@outlook.com --apply
 *
 *    Conserva al Dueño y a los clientes de la lista blanca
 *    (rutituti1@hotmail.com, lusituti756@gmail.com, rsv.cup@gmail.com).
 *    Para cambiarla: --conservar=uno@x.com,otro@y.com
 *
 * ── LA PAUSA DEL CELULAR ──────────────────────────────────────────────────
 *
 * En el paso 6 el test SE DETIENE y espera a que apruebes la cotización desde
 * la app, mirando la pantalla del taller hasta que diga "Aprobada". Para
 * ensayar sin celular, `APROBAR_EN_WEB=1` la aprueba desde la propia pantalla
 * del taller (el selector de estatus en /registro) — sigue siendo por UI, no
 * es un atajo por API.
 *
 * ── VARIABLES ─────────────────────────────────────────────────────────────
 *
 *   BASE_URL              La app de QA.
 *   SKIP_SEED=1           No sembrar datos (aquí siempre, no hay emuladores).
 *   E2E_TALLER_EMAIL      Reutilizar un taller ya registrado (salta el paso 1).
 *   E2E_TALLER_PASSWORD   Su contraseña. Default: Demo1234
 *   E2E_CLIENTE_EMAIL     Correo REAL del cliente, para poder aprobar desde el
 *                         celular. Default: rsv.cup@gmail.com
 *   APROBAR_EN_WEB=1      No esperar al celular; aprobar desde la web.
 *   E2E_ESPERA_MS         Cuánto espera al celular. Default 10 min.
 *   E2E_SONDEO_MS         Cada cuánto recarga para ver si ya se aprobó. 5s.
 *   E2E_LENTO=1           Mete pausas visibles entre pasos (para presentar).
 *   E2E_SIN_LIMPIEZA=1    No borrar nada aunque la corrida falle.
 *
 * ── REPARTO DE ROLES (por si te preguntas quién hace qué) ─────────────────
 *
 *   1  Dueño     Registro del taller y pago.
 *   2  Dueño     Alta de Asesor, Mecánico y Compras.
 *   3  Asesor    Cliente, vehículo y hoja de servicio.
 *   4  Mecánico  Diagnóstico técnico con semáforo.
 *   5A Dueño     Costeo. NO lo puede hacer el Asesor: /costeo exige
 *                CAN_VIEW_COST_VS_PRICE (solo owner y admin).
 *   5B Asesor    Traducción comercial y precios de la cotización.
 *   6  Cliente   Aprobación desde el celular.  ← la pausa
 *   7  Compras   Recepción de la refacción y "Reparación: Completo".
 *   8  Mecánico  Cronómetro de producción.
 *   9  Asesor    Entrega, desde Servicio.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const CLIENTE_EMAIL = process.env.E2E_CLIENTE_EMAIL || "rsv.cup@gmail.com";
const APROBAR_EN_WEB = process.env.APROBAR_EN_WEB === "1";
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
    correo: process.env.E2E_TALLER_EMAIL || `rsv_gpa+e2e${S}@outlook.com`,
    telefono: `55${S}02`.slice(0, 10),
    password: process.env.E2E_TALLER_PASSWORD || "Demo1234",
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
const creado = { usuarios: [], entryId: null };

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

const AUTO = {
  marca: "Nissan",
  modelo: "Versa",
  anio: "2023",
  color: "Blanco",
  placas: `E2E${S}`.slice(0, 8),
  vin: `3N1CN7AD5PL${S}0`.slice(0, 17),
  transmision: "Automática",
  km: "15000",
  combustible: "Gasolina",
  falla: "El cliente reporta ruido metálico al frenar y el pedal se siente bajo.",
};

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
async function etapa(page, nombre, fn) {
  return test.step(nombre, async () => {
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

// ── Stripe (el checkout hospedado vive dentro de iframes) ────────────────────

const SEL_NUM = 'input[placeholder="Número de tarjeta"], input[name="cardnumber"], input[name="number"], input[autocomplete="cc-number"]';
const SEL_VENCE = 'input[placeholder="MM / AA"], input[name="exp-date"], input[name="expiry"], input[autocomplete="cc-exp"]';
const SEL_CVC = 'input[placeholder="Código de seguridad"], input[name="cvc"], input[autocomplete="cc-csc"]';
const SEL_TITULAR = 'input[placeholder*="itular" i], input[name="billingName"], input[autocomplete="cc-name"]';

/** Stripe aísla los campos de tarjeta en un iframe propio (PCI): hay que buscarlo. */
async function frameDeTarjeta(page, timeout = 30000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeout) {
    for (const frame of page.frames()) {
      const n = await frame.locator(SEL_NUM).count().catch(() => 0);
      if (n > 0) return frame;
    }
    await page.waitForTimeout(400);
  }
  return null;
}

/** El botón final también puede estar en un iframe y tarda en dibujarse. */
async function botonConfirmarPago(page, timeout = 30000) {
  const estrategias = [
    (r) => r.locator('[data-testid="hosted-payment-submit-button"]'),
    (r) => r.getByRole("button", { name: /comenzar prueba|empezar prueba|iniciar prueba|start trial/i }),
    (r) => r.getByRole("button", { name: /suscrib|subscribe|pagar|pay now/i }),
    (r) => r.locator('form button[type="submit"]').last(),
    (r) => r.locator('button[type="submit"]').last(),
  ];
  const inicio = Date.now();
  while (Date.now() - inicio < timeout) {
    for (const frame of page.frames()) {
      for (const armar of estrategias) {
        try {
          const loc = armar(frame);
          if (!(await loc.count())) continue;
          const b = loc.first();
          if (!(await b.isVisible()) || !(await b.isEnabled())) continue;
          return b;
        } catch {
          continue;
        }
      }
    }
    await page.waitForTimeout(400);
  }
  return null;
}

async function pagarEnStripe(page) {
  const url = page.url();
  expect(
    url.includes("cs_test_"),
    `⛔ Stripe está en modo PRODUCCIÓN (${url.slice(0, 80)}...). ` +
      "Revisa STRIPE_SECRET_KEY en refac antes de seguir.",
  ).toBe(true);

  const frame = await frameDeTarjeta(page);
  if (!frame) {
    await evidencia(page, "stripe-sin-campos");
    throw new Error("No apareció el campo de número de tarjeta (ni en la página ni en los iframes).");
  }

  await frame.locator(SEL_NUM).first().fill(TARJETA.numero);
  await frame.locator(SEL_VENCE).first().fill(TARJETA.vence);
  await frame.locator(SEL_CVC).first().fill(TARJETA.cvc);

  const titular = `${TALLER.admin.nombre} ${TALLER.admin.apellidoP}`;
  const enFrame = await frame.locator(SEL_TITULAR).count().catch(() => 0);
  if (enFrame) await frame.locator(SEL_TITULAR).first().fill(titular);
  else {
    const enPagina = page.locator(SEL_TITULAR).first();
    if (await enPagina.count()) await enPagina.fill(titular);
  }

  const boton = await botonConfirmarPago(page);
  if (!boton) {
    await evidencia(page, "stripe-sin-boton");
    throw new Error("No se encontró el botón para confirmar el pago en Stripe.");
  }
  console.log(`   💳 Confirmando: "${(await boton.innerText().catch(() => "")).trim()}"`);
  await boton.click();
}

/**
 * Aterrizaje después de pagar. `/suscripcion/exito` puede terminar de TRES
 * formas distintas (ver SuscripcionExito.jsx), y hay que contemplarlas todas:
 *
 *   1. Canjea el session_id, inicia sesión sola y hace
 *      window.location.assign("/dashboard").
 *   2. Ya había sesión → muestra el enlace "Ir a mi taller" (hay que clicarlo).
 *   3. El canje falla → muestra "Iniciar sesión" y toca entrar a mano.
 *
 * Esperar un rato fijo y asumir que estamos dentro (lo que hacía antes) falla
 * en los casos 2 y 3, y el error aparece más tarde y en otro lado: "no
 * encuentro el menú Usuarios", que despista.
 */
async function entrarTrasElPago(page, admin) {
  const margen = Number(process.env.E2E_AUTOLOGIN_MS) || 30_000;
  const limite = Date.now() + margen;

  while (Date.now() < limite) {
    if (/dashboard/.test(new URL(page.url()).pathname)) {
      console.log("   🔓 Auto-login: entró solo al dashboard.");
      return "auto";
    }

    const irAlTaller = page.getByRole("link", { name: /ir a mi taller/i }).first();
    if (await irAlTaller.isVisible().catch(() => false)) {
      console.log('   🔓 La pantalla ofreció "Ir a mi taller": lo abro.');
      await irAlTaller.click();
      await page.waitForURL(/dashboard/, { timeout: 30000 });
      return "enlace";
    }

    const iniciar = page.getByRole("link", { name: /iniciar sesión/i }).first();
    if (await iniciar.isVisible().catch(() => false)) {
      console.log(
        "\n   ⚠️  El auto-login tras el pago NO funcionó: la pantalla cayó en su\n" +
          "      modo de respaldo (\"Inicia sesión con el correo y la contraseña que\n" +
          "      registraste\"). El taller SÍ quedó creado y pagado. Entro a mano y sigo.\n",
      );
      await iniciarSesion(page, admin);
      return "respaldo";
    }

    await page.waitForTimeout(1000);
  }

  // Ni entró solo ni ofreció un enlace en el margen dado. No es motivo para
  // tumbar el recorrido: el taller ya está creado y tenemos sus credenciales,
  // así que se entra por la puerta de siempre. El auto-login es una comodidad
  // del producto, no algo de lo que esta prueba deba depender.
  await evidencia(page, "autologin-sin-resolver");
  console.log(
    `\n   ⚠️  El auto-login no resolvió en ${Math.round(margen / 1000)}s. ` +
      "Entro con las credenciales del dueño y continúo.\n",
  );
  await iniciarSesion(page, admin);
  return "manual";
}

// ── Buscar la OS en /registro (se usa en varias etapas) ─────────────────────

/** Deja /registro filtrado por esa OS y devuelve su tarjeta. */
/**
 * Localiza la tarjeta de NUESTRA entrada en /registro.
 *
 * Busca por PLACAS, no por folio de OS: las placas las decide el test (son
 * unicas por corrida) y existen desde antes de registrar, mientras que el folio
 * lo asigna el backend y no se conoce hasta despues. El buscador de esa
 * pantalla acepta ambos ("No. OS, placas, cliente o telefono") y del lado del
 * backend `getEntries` filtra por `codeCar`.
 */
async function tarjetaDeEntrada(page) {
  await page.goto("/registro");

  const buscador = page.getByRole("textbox", { name: /buscar por no\. de os/i });
  if (await buscador.count()) {
    await buscador.fill(AUTO.placas);
    await page.getByRole("button", { name: /^buscar$/i }).click();
  }

  // `:visible` importa: la lista se pinta DOS veces (CardsSmall y CardsLarge,
  // esta ultima oculta con `hidden` para pantallas grandes). Sin el filtro se
  // puede enganchar la copia invisible y `toBeVisible` falla para siempre.
  const tarjeta = page.locator("div.rounded-xl:visible", { hasText: AUTO.placas }).first();
  await expect(
    tarjeta,
    `no encuentro la entrada de las placas ${AUTO.placas} en /registro`,
  ).toBeVisible({ timeout: 20000 });
  return tarjeta;
}

/** El folio de OS, leido de la tarjeta ("OS: 41"). */
async function folioDeLaTarjeta(tarjeta) {
  const texto = await tarjeta.innerText();
  return (texto.match(/OS:\s*(\d+)/i) || [])[1] || null;
}

// ═══════════════════════════════════════════════════════════════════════════

test.describe.configure({ mode: "serial" });

test(
  "e2e_v2 · todo por UI: registro del taller → equipo → recepción → diagnóstico → cotización → aprobación del cliente → abastecimiento → reparación → entrega",
  { tag: ["@ui", "@lento", "@e2e2"] },
  async ({ page }) => {
    test.setTimeout(ESPERA_MS + 20 * 60_000);

    const reutiliza = Boolean(process.env.E2E_TALLER_EMAIL);
    let os = null;      // folio visible ("OS: 2")
    let entryId = null; // id del documento, para las pantallas sin menu

    // ── 1. Registrar el taller y pagar ──────────────────────────────────────
    await etapa(page, "1) Registro del taller y pago con tarjeta de prueba", async () => {
      if (reutiliza) {
        console.log(`\n   ♻️  Reutilizando el taller de ${TALLER.admin.correo} (salto el registro).`);
        return;
      }

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

      await page.getByRole("button", { name: /continuar al pago seguro/i }).click();
      await page.waitForURL(/checkout\.stripe\.com/, { timeout: 45000 });

      await pagarEnStripe(page);

      // Stripe regresa a /suscripcion/exito; de ahí puede entrar solo, pedir un
      // clic, o mandarnos a iniciar sesión. `entrarTrasElPago` cubre las tres.
      await page.waitForURL((u) => /suscripcion\/exito|dashboard/.test(u.pathname), { timeout: 60000 });
      await entrarTrasElPago(page, TALLER.admin);

      console.log(
        `\n   ✅ Taller registrado. Para reusarlo en la próxima corrida:\n` +
          `      $env:E2E_TALLER_EMAIL="${TALLER.admin.correo}"\n` +
          `      $env:E2E_TALLER_PASSWORD="${TALLER.admin.password}"\n`,
      );
    });

    // ── 2. El Dueño da de alta al equipo ────────────────────────────────────
    await etapa(page, "2) El Dueño crea las cuentas del equipo", async () => {
      if (reutiliza) {
        await entrarComo(page, TALLER.admin);
      } else {
        // Venimos del paso 1 ya dentro. Si por lo que sea la sesión no quedó
        // (redirección a /login), se entra con las credenciales del dueño.
        if (/\/login/.test(new URL(page.url()).pathname)) {
          await iniciarSesion(page, TALLER.admin);
        }
        await expect(
          itemMenu(page, "Usuarios"),
          "el Dueño debe ver «Usuarios» en el menú",
        ).toBeVisible({ timeout: 30000 });
      }

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
        await page.getByPlaceholder(/10 dígitos/i).fill(persona.telefono);
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

      // Si el cliente ya existía de una corrida anterior, la app ofrece afiliarlo.
      const confirmar = page.getByRole("button", { name: /afiliar|s[ií], continuar|confirmar/i }).first();
      if (await confirmar.isVisible({ timeout: 4000 }).catch(() => false)) {
        console.log("   ℹ️  El cliente ya existía: lo afilio a este taller.");
        await confirmar.click();
      }

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
      await page
        .getByPlaceholder(/describa los aspectos generales/i)
        .fill("Ingresa por ruido en frenos. Cliente autoriza revisión.");

      await page.getByRole("button", { name: /registrar y continuar/i }).click();

      // Paso 4 del asistente: "Subir evidencias" (opcional para la demo).
      // OJO: el resumen de este paso muestra «OS:» VACIO. No es un error de la
      // app: el folio lo asigna el backend al registrar y el asistente no lo
      // vuelve a leer. Por eso el folio se lee despues, ya en la lista.
      const finalizar = page.getByRole("button", { name: /^finalizar$/i });
      await expect(finalizar).toBeVisible({ timeout: 45000 });
      await finalizar.click();
      await expect(page).toHaveURL(/\/registro/, { timeout: 20000 });

      const tarjetaNueva = await tarjetaDeEntrada(page);
      os = await folioDeLaTarjeta(tarjetaNueva);
      expect(os, "no pude leer el folio de OS en la tarjeta de la entrada").toBeTruthy();

      // El id del documento se toma de la URL al abrir el diagnostico desde la
      // tarjeta. Lo necesita el Mecanico en el paso 4, porque su rol no puede
      // entrar a /registro (ver el punto 12 del BACKLOG_TECNICO).
      await tarjetaNueva.getByRole("button", { name: /diagn[oó]stico/i }).first().click();
      await expect(page).toHaveURL(/\/diagnostico-vista\/[^/]+/, { timeout: 20000 });
      entryId = (page.url().match(/\/diagnostico-vista\/([^/?#]+)/) || [])[1];
      expect(entryId, "no pude leer el id de la entrada desde la URL").toBeTruthy();
      creado.entryId = entryId;
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

      const filaManoObra = page
        .locator("div.grid")
        .filter({ has: page.getByPlaceholder(/Ej\. Cambio de aceite/i) })
        .last();
      const camposManoObra = filaManoObra.locator("input");
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
      if (APROBAR_EN_WEB) {
        // Sigue siendo por UI: es el selector de estatus de la propia pantalla
        // del taller, no una llamada al backend.
        console.log("\n   ⏭  APROBAR_EN_WEB=1 → apruebo desde la pantalla del taller.\n");
        const tarjeta = await tarjetaDeEntrada(page);
        await tarjeta.locator(".ant-select").first().click();
        await page
          .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="Aprobada"]')
          .click();
        await expect(page.getByText(/estatus actualizado/i)).toBeVisible({ timeout: 20000 });
        return;
      }

      console.log(
        "\n" +
          "   ┌───────────────────────────────────────────────────────────┐\n" +
          "   │  AHORA EN EL CELULAR:                                     │\n" +
          `   │  1. Correo de ${CLIENTE.correo}\n` +
          "   │     → 'Activa tu cuenta' (si es la primera vez)            │\n" +
          "   │  2. Abre la app CCC-Taller e inicia sesión                 │\n" +
          `   │  3. Abre la cotización de la OS ${os} y toca APROBAR\n` +
          "   └───────────────────────────────────────────────────────────┘\n",
      );

      // Se vigila la PANTALLA del taller, no la API: recarga y busca "Aprobada".
      const limite = Date.now() + ESPERA_MS;
      let vueltas = 0;
      let aprobada = false;

      while (Date.now() < limite) {
        const tarjeta = await tarjetaDeEntrada(page);
        // OJO: coincidencia EXACTA. El selector tiene tres opciones —"En
        // espera", "Aprobada" y "No aprobada"— y un /aprobada/i suelto tambien
        // casa con "No aprobada": el test daria por aprobada una OS que el
        // cliente acaba de RECHAZAR.
        if (await tarjeta.getByText(/^aprobada$/i).first().isVisible().catch(() => false)) {
          aprobada = true;
          break;
        }
        if (vueltas % 4 === 0) {
          const restan = Math.round((limite - Date.now()) / 1000);
          console.log(`   ⏳ Esperando la aprobación en la app... (${restan}s)`);
        }
        vueltas += 1;
        await page.waitForTimeout(SONDEO_MS);
      }

      expect(
        aprobada,
        `El cliente no aprobó en ${Math.round(ESPERA_MS / 60000)} min. ` +
          "Sube E2E_ESPERA_MS, o usa APROBAR_EN_WEB=1 si solo querías ensayar.",
      ).toBe(true);
      console.log("\n   ✅ ¡Aprobada desde el celular!\n");
    });

    // ── 7. Compras recibe la refacción ──────────────────────────────────────
    await etapa(page, "7) Compras: recepción de la refacción faltante", async () => {
      await cerrarSesion(page);
      await entrarComo(page, EQUIPO.compras);

      await page.goto("/abastecimiento");
      // Al aprobar, el sistema generó el pedido solo: aquí solo se recibe.
      const recibir = page.getByRole("button", { name: /^recibir$/i }).first();
      await expect(recibir, "no apareció ningún pedido por recibir").toBeVisible({ timeout: 25000 });
      await recibir.click();

      const modal = page.getByRole("dialog").filter({ hasText: /registrar recepci[oó]n/i }).first();
      const caja = (await modal.count()) ? modal : page;

      // Cantidad recibida: el formulario suele traerla precargada al total.
      const cantidad = caja.locator('input[type="number"]').first();
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
      // "ya quedo en Completo". Solo se pulsa si sigue habilitado.
      if (await completo.isEnabled()) await completo.click();
      await expect(
        completo,
        "la OS no quedó marcada como «Completo»: el paso 8 se va a trabar",
      ).toBeDisabled({ timeout: 20000 });
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
      const autoEnProduccion = page
        .getByRole("button")
        .filter({ hasText: new RegExp(`OS ${literal(os)}\\b`) })
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
        .filter({ hasText: new RegExp(`OS:\\s*${literal(os)}\\b`) })
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
  if (!creado.usuarios.length && !creado.entryId) return;

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

    if (creado.entryId) {
      // Al aprobar, el backend genera solo la orden de compra y los
      // seguimientos de lo que no se llevó. Si se borra la OS y no ellos,
      // quedan huérfanos apuntando a una entrada que ya no existe.
      for (const coleccion of ["purchase_orders", "followups"]) {
        const snap = await db().collection(coleccion).where("entryId", "==", creado.entryId).get();
        for (const doc of snap.docs) await doc.ref.delete();
        if (snap.size) console.log(`      ✗ ${snap.size} de ${coleccion}`);
      }

      const ref = db().collection("entries").doc(creado.entryId);
      for (const sub of ["quotes", "diagnostics", "service_sheet"]) {
        const snap = await ref.collection(sub).get();
        for (const doc of snap.docs) await doc.ref.delete();
      }
      await ref.delete();
      console.log(`      ✗ OS ${creado.entryId}`);
    }

    const autos = await db().collection("cars").where("codeCar", "==", AUTO.placas).get();
    for (const doc of autos.docs) await doc.ref.delete();
    if (autos.size) console.log(`      ✗ auto ${AUTO.placas}`);

    console.log("   🧹 Listo: el taller queda como antes de esta corrida.\n");
  } catch (e) {
    console.log(`   ⚠️  No pude limpiar (${e.message}). Hazlo con scripts/limpiar-taller-pruebas.js\n`);
  }
});
