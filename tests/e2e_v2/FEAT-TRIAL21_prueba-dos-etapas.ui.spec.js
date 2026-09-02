const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { db } = require("../../qaAdmin");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FEAT-TRIAL21 — Prueba de dos etapas · PRUEBAS DE UI (nuevas, no recicladas)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Recorre por pantalla lo que el cliente va a vivir:
 *   1. Registro del taller SIN que le pidan tarjeta (14 días).
 *   2. Trabajar normal y ver su plan con su tope de órdenes.
 *   3. Vencer la prueba → el muro: cualquier ruta rebota a /suscripcion.
 *   4. Registrar tarjeta → 7 días más → el banner cambia y los datos siguen.
 *   5. Los 6 roles se topan con el mismo muro (es del taller, no del rol).
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *
 *   cd C:\Users\USER\Documents\TRABAJO\ccc-testing
 *   $env:BASE_URL="https://ccc-frontend-qa.vercel.app"
 *   $env:TRIAL_CORREO_BASE="rsv_gpa@outlook.com"      # TU buzón real
 *   $env:SKIP_SEED="1"                                # obligatorio: no hay emuladores
 *   npx playwright test --project=e2e_v2 tests/e2e_v2/FEAT-TRIAL21_prueba-dos-etapas.ui.spec.js
 *
 * Opcionales:
 *   $env:TRIAL_PLAN="basico"          # basico | premium | master
 *   $env:TRIAL_PASSWORD="Demo1234!"
 *   $env:TRIAL_SIN_STRIPE="1"         # se salta el pago (etapas 1-3 nada más)
 *   $env:TRIAL_ROLES_JSON='[{"rol":"Asesor","correo":"...","password":"..."}]'
 *
 * REQUISITOS
 *   - `ccc-backend/functions/serviceAccountKey.json` de refac (para mover
 *     `trial_end` y simular el día 15 sin esperar dos semanas).
 *   - Stripe de refac en modo **Test**: el spec aborta si la sesión de checkout
 *     no es `cs_test_` (candado contra pagar de verdad).
 *
 * Deja capturas y HTML de cada etapa en `scripts/debug-trial21/`.
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

const PLAN = process.env.TRIAL_PLAN || "basico";
const PASSWORD = process.env.TRIAL_PASSWORD || "Demo1234!";
const SIN_STRIPE = process.env.TRIAL_SIN_STRIPE === "1";
const DIA_MS = 24 * 60 * 60 * 1000;
const TARJETA = { numero: "4242424242424242", vence: "12/34", cvc: "123" };
const TOPE_POR_PLAN = { basico: 30, premium: 70, master: 150 };
/**
 * Rutas reales del ERP (verificadas contra `src` en qa-front el 2-sep). OJO:
 * el listado de órdenes es "/registro", NO "/entradas" — una ruta que no
 * existe se va a la raíz y el fallo parece del muro cuando es del nombre.
 */
const RUTAS_PROTEGIDAS = ["/clientes", "/registro", "/agenda", "/configuracion", "/dashboard"];

function correoDeCorrida(etiqueta) {
  const base = process.env.TRIAL_CORREO_BASE;
  if (!base || !base.includes("@")) {
    throw new Error(
      "Falta TRIAL_CORREO_BASE con un correo tuyo real (p.ej. rsv_gpa@outlook.com).\n" +
        "El spec le agrega +<etiqueta><sello> para que cada corrida use una cuenta nueva.",
    );
  }
  const [usuario, dominio] = base.split("@");
  return `${usuario}+${etiqueta}${Date.now().toString().slice(-6)}@${dominio}`;
}

const SELLO = Date.now().toString().slice(-6);

/**
 * Teléfono único por corrida: desde el fix del 27-ago el teléfono es ÚNICO
 * sobre users+clients, así que un número fijo rebota en la segunda corrida con
 * "Ese número de teléfono ya está registrado con otro correo".
 */
const telefono = (prefijo) => `${prefijo}${SELLO}${Math.floor(Math.random() * 10)}`;

const ADMIN = {
  nombre: "Trial",
  apellidoP: "Veintiuno",
  apellidoM: SELLO,
  correo: correoDeCorrida("trialui"),
  telefono: telefono("222"),
  password: PASSWORD,
};
const TALLER = {
  nombre: `Taller Trial21 UI ${SELLO}`,
  correo: ADMIN.correo,
  telefono: telefono("221"),
  direccion: "Av. de Pruebas 123, Puebla",
};

const CARPETA_DEBUG = path.join(__dirname, "..", "..", "scripts", "debug-trial21");

async function evidencia(page, nombre) {
  try {
    fs.mkdirSync(CARPETA_DEBUG, { recursive: true });
    const sello = new Date().toISOString().replace(/[:.]/g, "-");
    await page.screenshot({ path: path.join(CARPETA_DEBUG, `${nombre}-${sello}.png`), fullPage: true });
    fs.writeFileSync(path.join(CARPETA_DEBUG, `${nombre}-${sello}.html`), await page.content());
  } catch {
    /* la evidencia nunca debe tumbar la prueba */
  }
}

// ── Stripe: los campos de tarjeta viven en iframes (PCI) ─────────────────────
const SEL_NUM = 'input[placeholder="Número de tarjeta"], input[name="cardnumber"], input[name="number"], input[autocomplete="cc-number"]';
const SEL_VENCE = 'input[placeholder="MM / AA"], input[name="exp-date"], input[name="expiry"], input[autocomplete="cc-exp"]';
const SEL_CVC = 'input[placeholder="Código de seguridad"], input[name="cvc"], input[autocomplete="cc-csc"]';
const SEL_TITULAR = 'input[placeholder*="itular" i], input[name="billingName"], input[autocomplete="cc-name"]';

async function frameDeTarjeta(page, timeout = 30000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeout) {
    for (const frame of page.frames()) {
      if (await frame.locator(SEL_NUM).count().catch(() => 0)) return frame;
    }
    await page.waitForTimeout(400);
  }
  return null;
}

async function botonConfirmarPago(page, timeout = 30000) {
  const estrategias = [
    (r) => r.locator('[data-testid="hosted-payment-submit-button"]'),
    (r) => r.getByRole("button", { name: /comenzar prueba|empezar prueba|iniciar prueba|start trial/i }),
    (r) => r.getByRole("button", { name: /suscrib|subscribe|pagar|pay now/i }),
    (r) => r.locator('form button[type="submit"]').last(),
  ];
  const inicio = Date.now();
  while (Date.now() - inicio < timeout) {
    for (const frame of page.frames()) {
      for (const armar of estrategias) {
        try {
          const loc = armar(frame);
          if (!(await loc.count())) continue;
          const b = loc.first();
          if ((await b.isVisible()) && (await b.isEnabled())) return b;
        } catch { continue; }
      }
    }
    await page.waitForTimeout(400);
  }
  return null;
}

async function pagarEnStripe(page) {
  expect(
    page.url().includes("cs_test_"),
    `⛔ Stripe NO está en modo prueba (${page.url().slice(0, 80)}...). Revisa STRIPE_SECRET_KEY en refac ANTES de seguir.`,
  ).toBe(true);

  const frame = await frameDeTarjeta(page);
  if (!frame) { await evidencia(page, "stripe-sin-campos"); throw new Error("No apareció el campo de tarjeta."); }

  await frame.locator(SEL_NUM).first().fill(TARJETA.numero);
  await frame.locator(SEL_VENCE).first().fill(TARJETA.vence);
  await frame.locator(SEL_CVC).first().fill(TARJETA.cvc);

  const titular = `${ADMIN.nombre} ${ADMIN.apellidoP}`;
  if (await frame.locator(SEL_TITULAR).count().catch(() => 0)) {
    await frame.locator(SEL_TITULAR).first().fill(titular);
  } else if (await page.locator(SEL_TITULAR).count()) {
    await page.locator(SEL_TITULAR).first().fill(titular);
  }

  const boton = await botonConfirmarPago(page);
  if (!boton) { await evidencia(page, "stripe-sin-boton"); throw new Error("No encontré el botón de confirmar."); }
  await boton.click();
}

// ── Firestore: mover el reloj de la prueba ───────────────────────────────────
async function subscriptionDe(idWorkshop) {
  const snap = await db()
    .collection("subscriptions")
    .where("idReference", "==", idWorkshop)
    .where("isDeleted", "==", false)
    .limit(1)
    .get();
  return snap.empty ? null : { id: snap.docs[0].id, data: snap.docs[0].data() };
}

/** El taller recién creado, buscado por el correo del admin. */
async function idWorkshopDe(correo) {
  const snap = await db().collection("users").where("email", "==", correo).limit(1).get();
  if (!snap.empty && snap.docs[0].data().idWorkshop) return snap.docs[0].data().idWorkshop;
  const w = await db().collection("workshops").where("email", "==", correo).limit(1).get();
  return w.empty ? null : w.docs[0].id;
}

function aMs(v) {
  if (!v) return null;
  if (typeof v === "number") return v;
  if (v.toMillis) return v.toMillis();
  if (v.toDate) return v.toDate().getTime();
  return new Date(v).getTime();
}

async function entrarComo(page, correo, password) {
  await page.goto("/login");
  await page.locator("#email").fill(correo);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
}

const ctx = { idWorkshop: null, subId: null, trialEndMs: null };


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

test.describe.configure({ mode: "serial" });

test.describe("FEAT-TRIAL21 · prueba de dos etapas por pantalla", () => {
  test.beforeAll(abortarSiEmuladores);

  test(
    "el taller se registra sin tarjeta, se topa con el muro al día 15 y lo abre con la tarjeta",
    { tag: ["@ui", "@lento", "@red"] },
    async ({ page }) => {
      test.setTimeout(12 * 60_000);

      // ── 1. Registro SIN tarjeta ───────────────────────────────────────────
      await test.step("1) registro: 14 días gratis y ni un campo de tarjeta", async () => {
        await page.goto(`/registro-taller?plan=${PLAN}&cycle=0`);

        await expect(
          page.getByText(/sin tarjeta|14 d[ií]as gratis/i).first(),
          "la pantalla de registro debe prometer 14 días sin tarjeta",
        ).toBeVisible({ timeout: 15000 });

        await expect(
          page.locator(SEL_NUM),
          "no debe haber ningún campo de tarjeta en el registro",
        ).toHaveCount(0);

        await page.locator('input[name="workshopName"]').fill(TALLER.nombre);
        await page.locator('input[name="workshopEmail"]').fill(TALLER.correo);
        await page.locator('input[name="workshopPhone"]').fill(TALLER.telefono);
        await page.locator('input[name="workshopAddress"]').fill(TALLER.direccion);
        await page.locator('input[name="name"]').fill(ADMIN.nombre);
        await page.locator('input[name="firstSurname"]').fill(ADMIN.apellidoP);
        await page.locator('input[name="secondSurname"]').fill(ADMIN.apellidoM);
        await page.locator('input[name="email"]').fill(ADMIN.correo);
        await page.locator('input[name="phone"]').fill(ADMIN.telefono);
        await page.locator('input[name="password"]').fill(ADMIN.password);
        await page.locator('input[name="confirmPassword"]').fill(ADMIN.password);

        await page
          .getByRole("button", { name: /comenzar|empezar|continuar|registrar|crear cuenta/i })
          .first()
          .click();

        // Lo que NO debe pasar: irse a Stripe. Damos margen y verificamos.
        await page.waitForTimeout(6000);
        expect(
          page.url(),
          "el alta gratis NO debe abrir el checkout de Stripe",
        ).not.toContain("checkout.stripe.com");

        await page.waitForURL((u) => !/registro-taller/.test(u.pathname), { timeout: 45000 }).catch(() => {});
        await evidencia(page, "1-tras-registro");

        expect(
          page.url(),
          "tras registrarse debe entrar a la app, no quedarse en el login",
        ).not.toMatch(/\/login/);
      });

      // ── 2. Banner y plan correcto ─────────────────────────────────────────
      await test.step("2) banner de 14 días y el plan con SU tope de órdenes", async () => {
        await expect(
          page.getByText(/prueba gratis|14 d[ií]as|sin tarjeta/i).first(),
          "debe verse el banner de la prueba sin tarjeta",
        ).toBeVisible({ timeout: 20000 });

        ctx.idWorkshop = await idWorkshopDe(ADMIN.correo);
        expect(ctx.idWorkshop, "no encontré el taller recién creado en Firestore").toBeTruthy();

        const sub = await subscriptionDe(ctx.idWorkshop);
        expect(sub, "el taller debe tener su documento de suscripción").not.toBeNull();
        ctx.subId = sub.id;
        ctx.trialEndMs = aMs(sub.data.trial_end);

        expect(sub.data.trialType, "etapa 1 = sin tarjeta").toBe("cardless");
        expect(sub.data.externalSubscriptionId, "en Stripe no debe existir nada todavía").toBeFalsy();
        expect(sub.data.max_orders, `el tope del plan ${PLAN} aplica durante la prueba`).toBe(TOPE_POR_PLAN[PLAN]);

        await page.goto("/configuracion");
        await expect(
          page.getByText(new RegExp(String(TOPE_POR_PLAN[PLAN]), "i")).first(),
          "Configuración debe mostrar el tope del plan elegido, no uno ilimitado",
        ).toBeVisible({ timeout: 20000 });
      });

      // ── 3. El muro del día 15 ─────────────────────────────────────────────
      await test.step("3) con la prueba vencida, todo rebota a /suscripcion", async () => {
        await db().collection("subscriptions").doc(ctx.subId).update({
          trial_end: new Date(Date.now() - DIA_MS),
        });

        for (const ruta of RUTAS_PROTEGIDAS) {
          await page.goto(ruta);
          await page.waitForTimeout(2500);
          expect(
            page.url(),
            `con la prueba vencida, ${ruta} debe rebotar a /suscripcion (y NO al login)`,
          ).toContain("/suscripcion");
          expect(page.url(), `${ruta} no debe expulsar al login`).not.toMatch(/\/login/);
        }

        await evidencia(page, "3-muro");
        await expect(
          page.getByText(/contin[uú]a 7 d[ií]as m[aá]s|7 d[ií]as m[aá]s, gratis/i).first(),
          "el muro debe ofrecer los 7 días, no hablar de un cobro",
        ).toBeVisible({ timeout: 15000 });
        await expect(
          page.getByText(/primer cargo el d[ií]a 15/i),
          "ya no debe hablar del cobro el día 15",
        ).toHaveCount(0);
      });

      // ── 4. Registrar tarjeta ──────────────────────────────────────────────
      test.skip(SIN_STRIPE, "TRIAL_SIN_STRIPE=1: se omite el pago");

      await test.step("4) al registrar la tarjeta arrancan 7 días y no se pierde nada", async () => {
        await page.getByRole("button", { name: /continuar 7 d[ií]as gratis/i }).first().click();
        await page.waitForURL(/checkout\.stripe\.com/, { timeout: 45000 });

        await expect(
          page.getByText(/7 d[ií]as/i).first(),
          "Stripe debe mostrar los 7 días de la segunda etapa",
        ).toBeVisible({ timeout: 20000 });

        await pagarEnStripe(page);

        await page.waitForURL((u) => !/checkout\.stripe\.com/.test(u.href), { timeout: 90000 });
        await evidencia(page, "4-tras-pago");
        expect(page.url(), "Stripe debe regresar al front de QA").toContain(
          new URL(process.env.BASE_URL || "http://localhost:3000").host,
        );

        await expect(
          page.getByText(/prueba con tarjeta/i).first(),
          "el banner debe cambiar a la etapa con tarjeta",
        ).toBeVisible({ timeout: 60000 });

        // El webhook es asíncrono: le damos margen antes de mirar Firestore.
        let sub = null;
        for (let i = 0; i < 12; i++) {
          sub = await subscriptionDe(ctx.idWorkshop);
          if (sub && sub.data.trialType === "card") break;
          await page.waitForTimeout(5000);
        }
        expect(
          sub && sub.data.trialType,
          "si esto sigue en 'cardless', el webhook de Stripe NO está llegando al backend",
        ).toBe("card");
        expect(sub.data.externalSubscriptionId, "ya debe existir la suscripción en Stripe").toBeTruthy();

        const dias = Math.round((aMs(sub.data.trial_end) - Date.now()) / DIA_MS);
        expect(dias, `la etapa con tarjeta debe durar ~7 días (calculé ${dias})`).toBeGreaterThanOrEqual(6);
        expect(dias).toBeLessThanOrEqual(8);
      });
    },
  );

  test(
    "el muro es del taller, no del rol: los 6 roles rebotan igual",
    { tag: ["@ui", "@red"] },
    async ({ browser }) => {
      const roles = process.env.TRIAL_ROLES_JSON ? JSON.parse(process.env.TRIAL_ROLES_JSON) : [];
      test.skip(
        roles.length === 0,
        "Falta TRIAL_ROLES_JSON con las 6 cuentas de un taller con la prueba VENCIDA. " +
          'Ejemplo: [{"rol":"Asesor","correo":"a@x.com","password":"Demo1234!"}]',
      );
      test.setTimeout(roles.length * 90_000);

      for (const { rol, correo, password } of roles) {
        await test.step(`${rol} — con la prueba vencida no entra a ninguna ruta`, async () => {
          const contexto = await browser.newContext();
          const page = await contexto.newPage();
          try {
            await entrarComo(page, correo, password);
            await page.waitForTimeout(4000);

            for (const ruta of RUTAS_PROTEGIDAS) {
              await page.goto(ruta);
              await page.waitForTimeout(2500);
              expect(page.url(), `${rol}: ${ruta} debe rebotar a /suscripcion`).toContain("/suscripcion");
            }
            await expect(
              page.getByRole("button", { name: /continuar 7 d[ií]as gratis/i }).first(),
              `${rol}: todos deben poder pedir los 7 días — el bloqueo es de la cuenta, no del rol`,
            ).toBeVisible({ timeout: 15000 });
          } finally {
            await evidencia(page, `roles-${rol.toLowerCase()}`);
            await contexto.close();
          }
        });
      }
    },
  );

  test.afterAll(async () => {
    console.log(
      `\n   ℹ️  Taller de esta corrida: ${ADMIN.correo} · id ${ctx.idWorkshop}\n` +
        `      Para borrarlo:  cd ../ccc-backend/functions\n` +
        `      node scripts/limpiar-taller-pruebas.js ./serviceAccountKey.json --dueno=${ADMIN.correo} --apply\n`,
    );
  });
});
