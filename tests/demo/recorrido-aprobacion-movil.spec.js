const { test, expect } = require("@playwright/test");
const { headersFor } = require("../../qaAuth");

/**
 * DEMO DAY — recorrido con PAUSA REAL para que el CLIENTE apruebe la
 * cotización desde la app móvil (no la web del taller).
 *
 * A diferencia de recorrido-cliente.spec.js (que solo navega como el
 * taller), este spec:
 *   1) Siembra por API un cliente CON CUENTA (`/clients/with-account`) — le
 *      llega correo real de activación si corres esto contra refac/prod con
 *      un correo real (ver DEMO_CLIENT_EMAIL abajo).
 *   2) Arma una OS con diagnóstico + cotización, SIN aprobar.
 *   3) Muestra en la web del taller que está "en espera".
 *   4) SE DETIENE de verdad (polling a la API, no es una espera técnica de
 *      Playwright) hasta detectar que la cotización fue aprobada — mientras
 *      tanto, el presentador cambia a su celular, abre la app, activa la
 *      cuenta del cliente (correo "Activa tu cuenta") y aprueba desde ahí.
 *   5) Al detectar la aprobación, recarga la web y confirma que ya se ve
 *      Aprobada, para cerrar el recorrido.
 *
 * Ajusta el ritmo y la pausa sin tocar este archivo:
 *
 *   DEMO_CLIENT_EMAIL="rsv.cup@gmail.com" ^
 *   DEMO_APPROVE_TIMEOUT_MS=600000 DEMO_SLOWMO=600 npm run test:demo:aprobacion
 *
 * DEMO_CLIENT_EMAIL       → correo del cliente demo. Contra refac/prod usa uno
 *                           REAL tuyo (con +tag) para poder abrir el correo de
 *                           activación en el celular. Default: rsv.cup@gmail.com
 *                           (sirve contra emuladores, donde Brevo no manda nada
 *                           de verdad y de todos modos no hay app real que probar).
 * DEMO_APPROVE_TIMEOUT_MS → cuánto espera de verdad antes de rendirse (ms).
 *                           Default 10 minutos — de sobra para cambiar de
 *                           pantalla, activar la cuenta y aprobar a mano.
 * DEMO_POLL_MS            → cada cuánto vuelve a preguntarle a la API si ya
 *                           se aprobó. Default 4s.
 * DEMO_SLOWMO / DEMO_PAUSE_MS → igual que en recorrido-cliente.spec.js.
 *
 * AUTENTICACIÓN (26-ago): ya NO depende de los emuladores. Usa `qaAuth.js`,
 * que inicia sesión contra el Firebase REAL por REST con el correo/contraseña
 * de SEED_EMAIL/SEED_PASSWORD. Si defines AUTH_EMU, habla con el emulador en
 * vez del Firebase real, así que sigue sirviendo en local sin cambiar nada.
 *
 * CONTRA REFAC (lo normal para este spec):
 *
 *   $env:BASE_URL="https://ccc-frontend-qa.vercel.app"
 *   $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"
 *   $env:SEED_EMAIL="rsv.cup@gmail.com"
 *   $env:SEED_PASSWORD="admin123"
 *   $env:DEMO_CLIENT_EMAIL="lusituti756+cliente2@gmail.com"
 *   $env:SKIP_SEED="1"
 *   npm run test:demo:aprobacion
 *
 * MECHANIC_ID es opcional: si no lo pasas, el spec busca un mecánico del
 * taller (`GET /users/get-mechanics`) y, si no hay ninguno, usa al propio
 * admin. Así funciona en un taller recién registrado.
 *
 * CONTRA EMULADORES: agrega AUTH_EMU="http://127.0.0.1:9099" y deja los
 * defaults de API/SEED_*. Ahí el correo de activación no llega de verdad
 * (Brevo no está configurado en local), así que la pausa real solo tiene
 * sentido contra refac con un correo tuyo.
 */

const API = process.env.API || "http://localhost:3001/v1";
let ID_WORKSHOP = process.env.ID_WORKSHOP || null; // se resuelve solo si no lo pasas
const MECHANIC_ID = process.env.MECHANIC_ID || null;
const EMAIL = process.env.SEED_EMAIL || "rsv.cup@gmail.com";
const PASSWORD = process.env.SEED_PASSWORD || "admin123";
const PAUSE_MS = Number(process.env.DEMO_PAUSE_MS) || 1500;

const CLIENT_EMAIL = process.env.DEMO_CLIENT_EMAIL || "lusituti756+cliente2@gmail.com";
const CLIENT_NAME = process.env.DEMO_CLIENT_NAME || "Cliente Demo Móvil";
const CLIENT_PHONE = process.env.DEMO_CLIENT_PHONE || "";

const APPROVE_TIMEOUT_MS = Number(process.env.DEMO_APPROVE_TIMEOUT_MS) || 10 * 60_000;
const POLL_MS = Number(process.env.DEMO_POLL_MS) || 4000;

async function call(request, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: await headersFor(EMAIL, PASSWORD),
    ...(body ? { data: body } : {}),
  });
  if (!res.ok()) {
    throw new Error(`${method.toUpperCase()} ${path} → ${res.status()}: ${await res.text()}`);
  }
  const json = await res.json().catch(() => null);
  return json?.data ?? json;
}
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

/**
 * Id del mecánico al que se asigna la OS. Contra emuladores venía fijo de la
 * semilla; contra refac ese id no existe, así que: usa MECHANIC_ID si lo
 * pasaste, si no busca un mecánico del taller, y si el taller todavía no
 * tiene ninguno, cae al propio admin (basta para que la OS quede bien
 * formada en una demo).
 */
/**
 * idWorkshop del taller. No hace falta pasarlo: el doc del usuario con el que
 * inicias sesión ya lo trae, así que se deduce de SEED_EMAIL. Se puede forzar
 * con la variable ID_WORKSHOP si quisieras apuntar a otro taller.
 */
async function resolverWorkshop(request) {
  if (ID_WORKSHOP) return ID_WORKSHOP;
  const yo = await call(request, "get", `/users/email/${encodeURIComponent(EMAIL)}`);
  const id = yo?.idWorkshop;
  if (!id) {
    throw new Error(
      `No pude deducir el idWorkshop de ${EMAIL}. Pásalo a mano con ID_WORKSHOP.`,
    );
  }
  console.log(`   🏢 Taller: ${id}`);
  return id;
}

let mecanicoCache = null;
async function resolverMecanico(request) {
  if (MECHANIC_ID) return MECHANIC_ID;
  if (mecanicoCache) return mecanicoCache;

  try {
    const lista = await call(request, "get", "/users/get-mechanics");
    const primero = Array.isArray(lista) ? lista[0] : lista;
    if (primero && idOf(primero)) {
      mecanicoCache = idOf(primero);
      console.log(`   👷 Mecánico del taller: ${mecanicoCache}`);
      return mecanicoCache;
    }
  } catch {
    // sin mecánicos dados de alta todavía: seguimos al fallback
  }

  const yo = await call(request, "get", `/users/email/${encodeURIComponent(EMAIL)}`);
  mecanicoCache = idOf(yo);
  console.log(`   👷 El taller no tiene mecánicos; asigno la OS al admin (${mecanicoCache}).`);
  return mecanicoCache;
}

/** Pausa narrativa (no técnica) entre secciones — igual que en recorrido-cliente.spec.js. */
const beat = (page) => page.waitForTimeout(PAUSE_MS);

test(
  "Demo Day: pausa real para que el cliente apruebe la cotización desde la app móvil",
  { tag: ["@ui", "@lento"] },
  async ({ page, request }) => {
    test.setTimeout(APPROVE_TIMEOUT_MS + 5 * 60_000);

    const { entryId, plates, quoteId } = await test.step(
      "Preparar en silencio (por API): cliente CON CUENTA + vehículo + diagnóstico + cotización SIN aprobar",
      async () => {
        const s = String(Date.now()).slice(-6);
        ID_WORKSHOP = await resolverWorkshop(request);
        const mechanicId = await resolverMecanico(request);

        // Con cuenta: manda correo real de activación si CLIENT_EMAIL es real
        // y esto corre contra refac/prod (Brevo configurado ahí).
        const clientAlta = await call(request, "post", "/clients/with-account", {
          fullName: CLIENT_NAME,
          email: CLIENT_EMAIL,
          ...(CLIENT_PHONE ? { phone: CLIENT_PHONE } : {}),
          idWorkshop: ID_WORKSHOP,
          createdBy: mechanicId,
        });
        const clientId = clientAlta?.client?.id ?? idOf(clientAlta);

        // El backend solo manda el correo de activación si la cuenta todavía
        // no está verificada. Lo decimos en voz alta para que no te quedes
        // esperando un correo que nunca iba a llegar (porque ya la activaste).
        if (clientAlta?.hasVerifiedAccount) {
          console.log(
            `\n   📧 ${CLIENT_EMAIL} ya está activada: NO se manda correo. ` +
              "Entra directo en la app con la contraseña que creaste.\n",
          );
        } else if (clientAlta?.activationSent) {
          console.log(
            `\n   📧 Correo de activación enviado a ${CLIENT_EMAIL} ` +
              '(busca "Activa tu cuenta"; revisa Spam/Promociones).\n',
          );
        } else {
          console.log(
            `\n   ⚠️  La cuenta de ${CLIENT_EMAIL} no está verificada y el correo ` +
              "NO se pudo enviar (¿Brevo?). Se puede reenviar desde la app.\n",
          );
        }


        const car = await call(request, "post", "/cars", {
          clientId,
          brand: "Nissan",
          model: "Versa Demo Móvil",
          year: 2023,
          vin: `DEMOAPP${s}00000000`.slice(0, 17),
          codeCar: `DEMOM${s}`,
          color: "Blanco",
          fuel: "Gasolina",
          transmition: "Automática",
          km: 15000,
        });

        const entry = await call(request, "post", "/entries", {
          idWorkshop: ID_WORKSHOP,
          clientId,
          carId: idOf(car),
          assigned_mechanic: mechanicId,
          status: 1,
          observations: "Demo Day: pausa de aprobación desde el móvil",
          registerDate: Date.now(),
          approvalState: "EN ESPERA",
        });
        const entryId = idOf(entry);

        await call(request, "post", `/entries/${entryId}/service-sheet`, {
          car_items: ["Documentos"],
          checks: ["Frenos"],
          isCheckAll: false,
          observations: "Demo",
          km: 15000,
          fuel_tank: "1/2",
        });

        await call(request, "post", `/entries/${entryId}/diagnostics`, {
          idMechanic: mechanicId,
          generalObservations: "Revisión general para la demo de aprobación móvil.",
          findings: [
            {
              id: "demo-rojo",
              system: "Frenos",
              component: "Balatas delanteras",
              finding: "Desgaste al límite.",
              severity: "ROJO",
              recommendation: "Reemplazo inmediato.",
              commercialDescription: "Cambio de balatas delanteras.",
              consequence: "Riesgo de frenado deficiente.",
            },
          ],
        });

        const quote = await call(request, "post", `/entries/${entryId}/quotes`, {
          diagnostic: "Cambio de balatas delanteras",
          labor: [{ description: "Mano de obra — balatas", count: 1, cost: 350, subtotal: 350 }],
          parts: [{ description: "Balatas delanteras", count: 1, cost: 650, subtotal: 650 }],
          status: 2,
          stage: "COTIZACION",
        });

        return { entryId, plates: `DEMOM${s}`, quoteId: idOf(quote) };
      },
    );

    await test.step("Iniciar sesión como el taller", async () => {
      await page.goto("/login");
      await page.locator("#email").fill(EMAIL);
      await beat(page);
      await page.locator("#password").fill(PASSWORD);
      await page.getByRole("button", { name: /iniciar sesión/i }).click();
      await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });
      await beat(page);
    });

    await test.step("Mostrar la cotización esperando aprobación del cliente", async () => {
      await page.goto("/registro");
      const card = page.locator("div.rounded-xl.border", { hasText: plates }).first();
      await expect(card).toBeVisible({ timeout: 15000 });
      await beat(page);
    });

    await test.step("⏸ PAUSA REAL — aprobar desde la app móvil", async () => {
      console.log(
        "\n" +
          "═══════════════════════════════════════════════════════\n" +
          "⏸  PAUSA — aprueba la cotización desde el celular para continuar\n" +
          "─────────────────────────────────────────────────────────\n" +
          `   1) Abre el correo de ${CLIENT_EMAIL} → "Activa tu cuenta"\n` +
          "      y crea una contraseña.\n" +
          "   2) Abre la app CCC-Taller en el celular, inicia sesión con\n" +
          `      ${CLIENT_EMAIL} y esa contraseña.\n` +
          "   3) Verás la cotización pendiente en la pantalla principal —\n" +
          "      ábrela y toca Aprobar.\n" +
          `   Este script va a seguir revisando cada ${Math.round(POLL_MS / 1000)}s durante hasta ` +
          `${Math.round(APPROVE_TIMEOUT_MS / 60000)} minutos y va a continuar solo en cuanto detecte la aprobación.\n` +
          "════════════════════════════════════════════════════════════════\n",
      );

      const start = Date.now();
      let approved = false;
      while (Date.now() - start < APPROVE_TIMEOUT_MS) {
        const current = await call(request, "get", `/entries/${entryId}`);
        if (current?.approvalState === "APROBADA") {
          approved = true;
          break;
        }
        await page.waitForTimeout(POLL_MS);
      }

      expect(
        approved,
        `No se detectó la aprobación en ${Math.round(APPROVE_TIMEOUT_MS / 60000)} minutos. ` +
          "Revisa que la hayas aprobado desde el celular, o sube DEMO_APPROVE_TIMEOUT_MS.",
      ).toBe(true);

      console.log("✅ ¡Aprobación detectada! Continuando el recorrido...\n");
    });

    await test.step("Confirmar en la web que la cotización ya quedó aprobada", async () => {
      await page.reload();
      await expect(page.getByText(/aprobada/i).first()).toBeVisible({ timeout: 20000 });
      await beat(page);
    });
  },
);
