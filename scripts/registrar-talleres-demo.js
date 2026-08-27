/**
 * Registra los 4 talleres de demo en refac (QA) por el flujo PÚBLICO real
 * (/registro-taller → Stripe Checkout en modo prueba), en vez de hacerlo a
 * mano 4 veces. Es el mismo camino que seguiría un cliente normal — no toca
 * el serviceAccountKey ni ningún atajo de admin.
 *
 * IMPORTANTE: este script lo tienes que correr TÚ (con internet real de tu
 * máquina, fuera del sandbox de Claude) — no algo que Claude ejecute por su
 * cuenta. Los datos vienen de docs/Demo/demo-refac-guion.md (Parte A);
 * cualquier cambio a esos datos, cámbialo aquí Y allá para que no se
 * desincronicen.
 *
 * USO:
 *   cd ccc-testing
 *   node scripts/registrar-talleres-demo.js
 *
 * Corre en modo visible (headed) a propósito, para que veas cada registro
 * en vivo y puedas intervenir si algo no carga como se espera.
 *
 * Si un taller YA EXISTE (correo ya registrado) pero no tiene una suscripción
 * activa —por ejemplo porque una corrida anterior se quedó a medias en
 * Stripe—, el script YA NO lo trata como error: inicia sesión con ese correo
 * y contraseña, va a /suscripcion, elige el plan/ciclo correcto y completa el
 * checkout desde ahí. Si el taller ya tenía una suscripción activa (de una
 * corrida anterior que sí terminó), lo detecta y lo marca como ✅ sin volver
 * a pasar por Stripe.
 *
 * (Nota sobre la pausa que se veía al llegar a la parte de la tarjeta: NO
 * era el caso de "ya existe" — pasaba desde la primera corrida, con
 * talleres que todavía no existían. La causa real, confirmada con una
 * captura de pantalla real del Checkout: los campos de "Número de
 * tarjeta"/"MM AA"/"Código de seguridad" NO están sueltos en la página —
 * Stripe los mete dentro de un <iframe> propio por seguridad, así que
 * `page.locator("#cardNumber")` en la página principal nunca los
 * encontraba y se quedaba esperando para siempre. Ya está arreglado:
 * `esperarFrameDeTarjeta()` busca ese iframe (por el texto real de los
 * placeholders en español) y llena los campos ahí adentro.
 *
 * Segunda pausa (misma corrida, un paso después): ya llenaba bien los datos
 * pero se atoraba SIN dar click en el botón final, porque con un plan de
 * prueba ese botón dice "Empezar prueba" y el patrón solo buscaba
 * "pagar"/"suscribirse"/"iniciar prueba". Ya lo cubre clickBotonConfirmar(),
 * que prueba varias formas en orden y como último recurso usa simplemente el
 * botón de submit del formulario (sea cual sea su texto).
 *
 * Además, cada vez que llega a checkout.stripe.com y cada vez que algo
 * truena, guarda una captura de pantalla + el HTML de la página en
 * scripts/debug/, por si algo más cambia y hay que revisarlo sin adivinar.)
 *
 * Variables opcionales:
 *   BASE_URL   → default https://ccc-frontend-qa.vercel.app (confirma
 *                que sea la URL real de tu proyecto QA antes de correr esto).
 *   SOLO_INDICE → si quieres correr un solo taller (0 a 3) en vez de los 4,
 *                ej. `SOLO_INDICE=2 node scripts/registrar-talleres-demo.js`.
 */

const { chromium } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const BASE_URL = process.env.BASE_URL || "https://ccc-frontend-qa.vercel.app";

// Carpeta donde se guardan capturas de pantalla + HTML cuando algo no sale
// como se espera (ver guardarDiagnostico más abajo). No se sube a git.
const DEBUG_DIR = path.join(__dirname, "debug");

// Por default la Parte A corre SOLA, sin pausas: si un taller falla, guarda
// el diagnóstico y sigue con el siguiente. Con PAUSA_SI_FALLA=1 se detiene en
// el Inspector de Playwright para que lo termines a mano.
const PAUSAR_SI_FALLA = process.env.PAUSA_SI_FALLA === "1";

// Tarjeta de PRUEBA oficial de Stripe — no es una tarjeta real, no genera
// ningún cargo en modo test.
const TEST_CARD = {
  number: "4242424242424242",
  expiry: "12/34",
  cvc: "123",
  postal: "06600",
};

// Nombres exactos de cada plan tal como se muestran en /suscripcion
// (src/pages/landing/data.js → PLANS). Si cambian ahí, cámbialos aquí.
const PLAN_NAMES = {
  basico: "Básico",
  premium: "Premium",
  master: "Master",
};

// Mismos datos que la tabla de docs/Demo/demo-refac-guion.md (Parte A).
const TALLERES = [
  {
    plan: "basico",
    cycle: "0",
    workshopName: "Taller Demo Reforma",
    workshopEmail: "enriquecruzpue+reforma@gmail.com",
    workshopPhone: "5511010001",
    workshopAddress: "Av. Paseo de la Reforma 250, Cuauhtémoc, CDMX",
    name: "Ana",
    firstSurname: "Torres",
    secondSurname: "Medina",
    phone: "5511010002",
    email: "enriquecruzpue+reforma-admin@gmail.com",
    password: "Demo1234",
  },
  {
    plan: "premium",
    cycle: "0",
    workshopName: "Taller Demo Coyoacán",
    workshopEmail: "enriquecruzpue+coyoacan@gmail.com",
    workshopPhone: "5511020001",
    workshopAddress: "Av. Universidad 1200, Coyoacán, CDMX",
    name: "Luis",
    firstSurname: "Hernández",
    secondSurname: "Ruiz",
    phone: "5511020002",
    email: "enriquecruzpue+coyoacan-admin@gmail.com",
    password: "Demo1234",
  },
  {
    plan: "master",
    cycle: "0",
    workshopName: "Taller Demo Satélite",
    workshopEmail: "enriquecruzpue+satelite@gmail.com",
    workshopPhone: "5511030001",
    workshopAddress: "Circuito Centro Comercial 100, Naucalpan, Edo. Méx.",
    name: "Marina",
    firstSurname: "López",
    secondSurname: "Castillo",
    phone: "5511030002",
    email: "enriquecruzpue+satelite-admin@gmail.com",
    password: "Demo1234",
  },
  {
    plan: "premium",
    cycle: "1",
    workshopName: "Taller Demo Toluca",
    workshopEmail: "enriquecruzpue+toluca@gmail.com",
    workshopPhone: "5511040001",
    workshopAddress: "Paseo Tollocan 500, Toluca, Edo. Méx.",
    name: "Carlos",
    firstSurname: "Ramírez",
    secondSurname: "Ortega",
    phone: "5511040002",
    email: "enriquecruzpue+toluca-admin@gmail.com",
    password: "Demo1234",
  },
];

/** Llena un input por su atributo `name` (así está armado RegistroTallerPage.jsx). */
async function fillByName(page, name, value) {
  if (value === undefined || value === null || value === "") return;
  await page.locator(`input[name="${name}"]`).fill(String(value));
}

/**
 * Corre varias tareas (funciones que regresan una promesa) al mismo tiempo y
 * regresa el resultado de la PRIMERA que tenga éxito. Si TODAS truenan (por
 * timeout, normalmente), avienta un error. A diferencia de Promise.race, una
 * tarea que truena rápido no "gana" sobre otra que sigue esperando: solo
 * pierde si todas truenan.
 */
function raceOutcomes(tasks) {
  return new Promise((resolve, reject) => {
    let pendientes = tasks.length;
    let yaResolvio = false;
    for (const task of tasks) {
      Promise.resolve()
        .then(task)
        .then((valor) => {
          if (!yaResolvio) {
            yaResolvio = true;
            resolve(valor);
          }
        })
        .catch(() => {
          pendientes -= 1;
          if (pendientes === 0 && !yaResolvio) {
            reject(new Error("Ninguna de las condiciones esperadas ocurrió a tiempo."));
          }
        });
    }
  });
}

/**
 * Guarda una captura de pantalla + el HTML actual de la página (y, si se
 * pasa `logs`, los mensajes de consola/errores/requests fallidos que se
 * hayan ido acumulando) en scripts/debug/. Nunca truena el flujo principal:
 * si algo falla al guardar, solo lo avisa y sigue.
 */
async function guardarDiagnostico(page, etiqueta, logs) {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = path.join(DEBUG_DIR, `${etiqueta}-${stamp}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => null);
    if (html) fs.writeFileSync(`${base}.html`, html);
    if (logs && logs.length) fs.writeFileSync(`${base}.log`, logs.join("\n"));
    console.log(`   🩺 Diagnóstico guardado en ${base}.png (url actual: ${page.url()})`);
  } catch (e) {
    console.error(`   (no se pudo guardar el diagnóstico: ${e.message})`);
  }
}

// Selectores de los 3 campos de tarjeta, sacados directo de una captura de
// pantalla real del Checkout en español (no adivinados): "Número de
// tarjeta", "MM / AA", "Código de seguridad". Se combinan con los
// atributos `name`/`autocomplete` que usa Stripe internamente por si el
// texto del placeholder cambia de idioma o de copy.
const SELECTOR_NUMERO_TARJETA =
  'input[placeholder="Número de tarjeta"], input[name="cardnumber"], input[name="number"], input[autocomplete="cc-number"]';
const SELECTOR_VENCIMIENTO_TARJETA =
  'input[placeholder="MM / AA"], input[name="exp-date"], input[name="expiry"], input[autocomplete="cc-exp"]';
const SELECTOR_CVC_TARJETA =
  'input[placeholder="Código de seguridad"], input[name="cvc"], input[autocomplete="cc-csc"]';
const SELECTOR_NOMBRE_TITULAR =
  'input[placeholder*="itular" i], input[name="billingName"], input[autocomplete="cc-name"]';

/**
 * Los campos de tarjeta de Stripe Checkout NO viven en la página principal:
 * Stripe los aísla dentro de un <iframe> propio (por seguridad, para que el
 * sitio que los muestra nunca "vea" el número de tarjeta). Por eso
 * `page.locator("#cardNumber")` nunca los encontraba y el script se quedaba
 * esperando para siempre (la pausa que se veía). Esta función busca, en la
 * página principal Y en cada iframe, cuál de todos tiene el campo de
 * tarjeta, y regresa ese "frame" para usarlo con `.locator(...)` igual que
 * si fuera la página.
 */
async function esperarFrameDeTarjeta(page, { timeout = 30000, intervalo = 300 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await page.locator(SELECTOR_NUMERO_TARJETA).count().catch(() => 0)) {
      return page.mainFrame();
    }
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const count = await frame.locator(SELECTOR_NUMERO_TARJETA).count().catch(() => 0);
      if (count > 0) return frame;
    }
    await page.waitForTimeout(intervalo);
  }
  return null;
}

/**
 * Llena el Checkout hospedado de Stripe (checkout.stripe.com/pay/...).
 * El correo, el nombre del titular (si no está en el iframe) y el código
 * postal viven en la página principal; el número/vencimiento/CVC de la
 * tarjeta viven dentro del iframe que encuentra `esperarFrameDeTarjeta`.
 */
async function fillStripeCheckout(page, taller, logs) {
  // Diagnóstico apenas se llega a Stripe, ANTES de intentar llenar nada —
  // así, si se queda pegado esperando el campo de tarjeta, ya queda
  // guardado cómo se veía la página justo al llegar.
  await guardarDiagnostico(page, "checkout-llego", logs);

  const frame = await esperarFrameDeTarjeta(page, { timeout: 30000 });
  if (!frame) {
    await guardarDiagnostico(page, "sin-frame-tarjeta", logs);
    throw new Error(
      "No se encontró el campo de número de tarjeta (ni en la página ni en ningún iframe) tras 30s.",
    );
  }

  const emailField = page.locator('#email, input[type="email"]').first();
  if ((await emailField.count()) && !(await emailField.inputValue().catch(() => ""))) {
    await emailField.fill(taller.email);
  }

  await frame.locator(SELECTOR_NUMERO_TARJETA).first().fill(TEST_CARD.number);
  await frame.locator(SELECTOR_VENCIMIENTO_TARJETA).first().fill(TEST_CARD.expiry);
  await frame.locator(SELECTOR_CVC_TARJETA).first().fill(TEST_CARD.cvc);

  const nombreCompleto = `${taller.name} ${taller.firstSurname}`;
  const nombreEnFrame = await frame.locator(SELECTOR_NOMBRE_TITULAR).count().catch(() => 0);
  if (nombreEnFrame) {
    await frame.locator(SELECTOR_NOMBRE_TITULAR).first().fill(nombreCompleto);
  } else {
    const nameField = page.locator(SELECTOR_NOMBRE_TITULAR).first();
    if (await nameField.count()) await nameField.fill(nombreCompleto);
  }

  const postalField = page.locator("#billingPostalCode");
  if (await postalField.count()) {
    await postalField.fill(TEST_CARD.postal);
  }

  await clickBotonConfirmar(page, logs);
}

/**
 * Da click en el boton que confirma el pago al final del Checkout.
 *
 * Ese boton NO siempre dice lo mismo: con un plan de prueba dice "Empezar
 * prueba", sin prueba diria "Suscribirse"/"Pagar", y en ingles otra cosa.
 * Por eso se intentan varias formas en orden, de la mas especifica a la mas
 * generica (el ultimo recurso es simplemente "el boton de submit del
 * formulario", que sea cual sea el texto es el correcto).
 *
 * Si ninguna funciona, guarda diagnostico Y avienta un error que incluye el
 * texto de todos los botones que si habia en la pagina, para no adivinar en
 * la siguiente vuelta.
 */
// Formas de ubicar el boton final, de la mas especifica a la mas generica.
// La ultima ("el boton de submit del formulario") funciona sea cual sea el
// texto, que cambia segun haya prueba gratis o no y segun el idioma.
const ESTRATEGIAS_BOTON_CONFIRMAR = [
  (raiz) => raiz.locator('[data-testid="hosted-payment-submit-button"]'),
  (raiz) =>
    raiz.getByRole("button", {
      name: /empezar prueba|iniciar prueba|comenzar prueba|start trial/i,
    }),
  (raiz) => raiz.getByRole("button", { name: /suscrib|subscribe|pagar|pay now/i }),
  (raiz) => raiz.locator('form button[type="submit"]').last(),
  (raiz) => raiz.locator('button[type="submit"]').last(),
];

/**
 * Busca el boton que confirma el pago. Dos cosas que costaron una vuelta:
 *
 * 1. Igual que los campos de tarjeta, ese boton puede estar DENTRO de un
 *    iframe de Stripe, no en la pagina principal. Por eso se busca en
 *    `page.frames()` completo, no solo en `page`.
 * 2. El formulario tarda en terminar de dibujarse: si se busca una sola vez
 *    con `count()` (que no espera nada) la pagina todavia puede tener solo
 *    el boton "Aplicar" del codigo de promocion. Por eso esto reintenta
 *    cada `intervalo` ms hasta `timeout`.
 */
async function buscarBotonConfirmar(page, { timeout = 30000, intervalo = 500 } = {}) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeout) {
    for (const frame of page.frames()) {
      for (const estrategia of ESTRATEGIAS_BOTON_CONFIRMAR) {
        let boton;
        try {
          const loc = estrategia(frame);
          if (!(await loc.count())) continue;
          boton = loc.first();
          if (!(await boton.isVisible())) continue;
          if (!(await boton.isEnabled())) continue;
        } catch {
          continue; // frame que se recargo/desaparecio a media busqueda
        }
        return boton;
      }
    }
    await page.waitForTimeout(intervalo);
  }
  return null;
}

/** Junta el texto de todos los botones de todos los frames, para diagnostico. */
async function textosDeBotones(page) {
  const todos = [];
  for (const frame of page.frames()) {
    const textos = await frame
      .locator("button")
      .allInnerTexts()
      .catch(() => []);
    for (const t of textos) {
      const limpio = t.replace(/\s+/g, " ").trim();
      if (limpio && !todos.includes(limpio)) todos.push(limpio);
    }
  }
  return todos;
}

async function clickBotonConfirmar(page, logs) {
  const boton = await buscarBotonConfirmar(page);

  if (!boton) {
    const textos = await textosDeBotones(page);
    await guardarDiagnostico(page, "sin-boton-confirmar", logs);
    throw new Error(
      "No se encontro el boton para confirmar el pago (se busco en la pagina y en todos " +
        "los iframes durante 30s). Botones que si habia: " +
        JSON.stringify(textos),
    );
  }

  const texto = (await boton.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  console.log(`   [pago] Confirmando con el boton: "${texto || "(sin texto)"}"`);
  await boton.click();
}

/**
 * Llena y envía el formulario público de /registro-taller. Regresa:
 *   "checkout" → Stripe Checkout se abrió normal, sigue el flujo de siempre.
 *   "exists"   → el backend contestó "ya existe una cuenta con ese correo".
 */
async function enviarRegistro(page, taller) {
  const url = `${BASE_URL}/registro-taller?plan=${taller.plan}&cycle=${taller.cycle}`;
  console.log(`   → ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });

  await fillByName(page, "workshopName", taller.workshopName);
  await fillByName(page, "workshopEmail", taller.workshopEmail);
  await fillByName(page, "workshopPhone", taller.workshopPhone);
  await fillByName(page, "workshopAddress", taller.workshopAddress);
  await fillByName(page, "name", taller.name);
  await fillByName(page, "firstSurname", taller.firstSurname);
  await fillByName(page, "secondSurname", taller.secondSurname);
  await fillByName(page, "phone", taller.phone);
  await fillByName(page, "email", taller.email);
  await fillByName(page, "password", taller.password);
  await fillByName(page, "confirmPassword", taller.password);

  await page.getByRole("button", { name: /continuar al pago seguro/i }).click();

  // Stripe Checkout hospedado abre en la MISMA pestaña (redirect, no popup).
  return raceOutcomes([
    () => page.waitForURL(/checkout\.stripe\.com/, { timeout: 20000 }).then(() => "checkout"),
    () =>
      page
        .getByText(/ya existe una cuenta/i)
        .waitFor({ timeout: 20000 })
        .then(() => "exists"),
  ]);
}

/**
 * Camino de recuperación cuando el taller ya existe: inicia sesión con el
 * admin de ese taller y, si aún no tiene suscripción activa, la completa
 * desde /suscripcion (mismo checkout de Stripe de siempre).
 *
 * Regresa { yaSuscrito: true } si al iniciar sesión la app ya te mandó a una
 * zona autenticada normal (dashboard, etc.) sin pedir suscripción — eso
 * significa que una corrida anterior sí había terminado bien, y no hay nada
 * más que hacer.
 */
async function loginYSuscribir(page, taller) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.locator("#email").fill(taller.email);
  await page.locator("#password").fill(taller.password);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();

  // Deja que Firebase autentique y la app decida a dónde mandarte (si tu
  // suscripción sigue vigente, te manda directo al dashboard; si no, a
  // /suscripcion). Si nada cambia en 15s seguimos de todos modos.
  await page
    .waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 15000 })
    .catch(() => {});

  const pathnameActual = new URL(page.url()).pathname;
  if (pathnameActual !== "/login" && pathnameActual !== "/suscripcion") {
    // La app te dejó entrar directo a una zona autenticada sin pedirte
    // suscripción: ya tenía una activa de una corrida anterior.
    return { yaSuscrito: true };
  }

  await page.goto(`${BASE_URL}/suscripcion`, { waitUntil: "domcontentloaded" });

  if (taller.cycle === "1") {
    await page.getByRole("button", { name: /anual/i }).click();
  }

  const planName = PLAN_NAMES[taller.plan];
  const heading = page.getByRole("heading", { name: planName, exact: true });
  await heading.waitFor({ timeout: 15000 });
  const card = heading.locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
  await card.getByRole("button", { name: /probar 14 días gratis/i }).click();

  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30000 });
  return { yaSuscrito: false };
}

async function registrarTaller(browser, taller) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
  });
  // Playwright deja `navigator.webdriver = true` por default, y eso lo
  // puede usar cualquier detector de bots (incluido el de pagos de Stripe)
  // para bloquear o no terminar de cargar el formulario. Lo escondemos.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();
  const result = { taller: taller.workshopName, ok: false, error: null, finalUrl: null, via: null };

  // Junta mensajes de consola / errores de página / requests fallidos — se
  // guardan junto con el diagnóstico si algo truena, para no tener que
  // adivinar qué pasó.
  const logs = [];
  page.on("console", (msg) => logs.push(`[console:${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) => {
    const falla = req.failure();
    logs.push(`[requestfailed] ${req.url()} — ${falla ? falla.errorText : "?"}`);
  });

  try {
    const outcome = await enviarRegistro(page, taller);

    if (outcome === "exists") {
      console.log(
        `   ℹ️  ${taller.workshopName}: ya existía la cuenta — entrando por /login → /suscripcion...`,
      );
      const { yaSuscrito } = await loginYSuscribir(page, taller);

      if (yaSuscrito) {
        result.ok = true;
        result.via = "ya tenía suscripción activa (no se tocó Stripe)";
        result.finalUrl = page.url();
        return result;
      }
      result.via = "recuperado: ya existía, se completó la suscripción";
    } else {
      result.via = "registro nuevo";
    }

    await fillStripeCheckout(page, taller, logs);

    // Tras pagar, Stripe regresa a /suscripcion/exito (auto-login a /dashboard)
    // o, viniendo del camino de recuperación, directo a /dashboard.
    await page.waitForURL((u) => /suscripcion\/exito|dashboard/.test(u.pathname), {
      timeout: 45000,
    });
    await page.waitForTimeout(2000); // deja que el auto-login termine

    result.ok = true;
    result.finalUrl = page.url();
  } catch (err) {
    result.error = err.message;
    console.error(`   ⚠️  ${taller.workshopName}: ${err.message}`);
    await guardarDiagnostico(page, `error-${taller.plan}`, logs);

    if (PAUSAR_SI_FALLA) {
      console.error(
        "   ⏸  Se abrió el Inspector de Playwright — completa el paso a mano " +
          "en la ventana del navegador y dale 'Resume' ahí para seguir.",
      );
      await page.pause().catch(() => {});
      // Si tras el pause() ya quedó bien, lo confirmamos una vez más:
      result.ok = /suscripcion\/exito|dashboard/.test(page.url());
      if (result.ok) result.error = null;
    } else {
      console.error(
        "   ↪  Sigo con el siguiente taller. Revisa la captura de arriba; si " +
          "quieres que se detenga para terminarlo a mano, corre con PAUSA_SI_FALLA=1.",
      );
    }
    result.finalUrl = await Promise.resolve(page.url()).catch(() => null);
  } finally {
    await context.close().catch(() => {});
  }

  return result;
}

(async () => {
  const soloIndice = process.env.SOLO_INDICE !== undefined ? Number(process.env.SOLO_INDICE) : null;
  const lista = soloIndice === null ? TALLERES : [TALLERES[soloIndice]];

  console.log(`\n🚀 Registrando ${lista.length} taller(es) contra ${BASE_URL}\n`);

  // "--disable-blink-features=AutomationControlled" + quitar navigator.webdriver
  // es para que Stripe (que hace detección de bots en su formulario de pago)
  // no trate este navegador automatizado distinto a uno normal.
  const browser = await chromium.launch({
    channel: "msedge",
    headless: false,
    slowMo: 150,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const results = [];

  for (const taller of lista) {
    console.log(`➡️  ${taller.workshopName} (plan ${taller.plan}, ciclo ${taller.cycle})`);

    let r;
    try {
      r = await registrarTaller(browser, taller);
    } catch (err) {
      // Si cerraste la ventana del navegador a mano, ya no tiene caso seguir:
      // se corta limpio con el resumen de lo que sí alcanzó a hacer, en vez de
      // tronar con un stack trace de Playwright por cada taller restante.
      r = { taller: taller.workshopName, ok: false, error: err.message, finalUrl: null, via: null };
      results.push(r);
      console.log(`❌ ${taller.workshopName} FALLÓ\n`);
      if (/has been closed|Target page, context or browser/i.test(err.message)) {
        console.error("⛔ El navegador se cerró — corto aquí y te dejo el resumen de lo que llevo.\n");
        break;
      }
      continue;
    }

    results.push(r);
    console.log(
      r.ok ? `✅ ${taller.workshopName} OK — ${r.via}\n` : `❌ ${taller.workshopName} FALLÓ\n`,
    );
  }

  await browser.close().catch(() => {});

  console.log("=== Resumen ===");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.taller}${r.error ? ` — ${r.error}` : ` — ${r.via}`}`);
  }

  const outPath = path.join(__dirname, "registro-talleres-resultado.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nDetalle guardado en ${outPath}`);
})();
