const { test, expect } = require("@playwright/test");
const { signIn, headersFor, claimsOf } = require("../../qaAuth");

/**
 * RECORRIDO MULTI-ROL DE PUNTA A PUNTA — contra refac (QA), sin emuladores.
 *
 * Es el hermano de operacion/ciclo-completo.spec.js, pero con dos diferencias
 * que importan para la demo:
 *
 *   1) NO depende de emuladores. Se autentica contra el Firebase real de QA
 *      (ver qaAuth.js) usando los admins de los talleres que sembró
 *      scripts/registrar-talleres-demo.js.
 *   2) Recorre el ciclo COMO LO HARÍA UN TALLER DE VERDAD: cada paso lo
 *      ejecuta el rol que le toca, cerrando sesión e iniciando sesión de
 *      nuevo en la UI entre un rol y otro.
 *
 * Cómo prueba los roles (importante entender esto):
 *   - El cambio de sesión es REAL y por UI: cierra sesión desde el menú del
 *     header, confirma el modal, y vuelve a entrar por /login. Eso es lo que
 *     se ve en pantalla durante la demo.
 *   - En cada sesión verifica el MENÚ del rol (ve lo suyo, NO ve lo ajeno),
 *     que es la matriz de Q20 (ver acceso/roles-permisos.spec.js).
 *   - Las acciones van por API pero FIRMADAS CON EL TOKEN DE ESE ROL, no con
 *     el del dueño. Así el blindaje del servidor se ejerce de verdad: si un
 *     rol no tuviera la capability, la llamada respondería 403 y el test
 *     fallaría. Es más estricto que hacerlo por UI (donde el botón
 *     simplemente no aparece) y no depende de selectores frágiles.
 *
 * La PAUSA para que el cliente apruebe desde la app móvil es real: consulta
 * la API cada pocos segundos hasta detectar la aprobación (no es un
 * waitForTimeout).
 *
 * ── USO ────────────────────────────────────────────────────────────────────
 *
 *   cd ccc-testing
 *   $env:BASE_URL="https://ccc-frontend-qa.vercel.app"
 *   $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"
 *   $env:SEED_EMAIL="rsv.cup@gmail.com"
 *   $env:SEED_PASSWORD="admin123"
 *   $env:DEMO_CLIENT_EMAIL="lusituti756+cliente2@gmail.com"
 *   $env:SKIP_SEED="1"
 *   npm run test:demo:multirol
 *
 * ── VARIABLES ──────────────────────────────────────────────────────────────
 *
 *   SEED_EMAIL / SEED_PASSWORD  Admin (dueño) del taller. Es quien da de alta
 *                               al resto del equipo la primera vez.
 *   ID_WORKSHOP                 Opcional: se deduce del admin con el que
 *                               inicias sesión. Pásalo solo si quieres apuntar
 *                               a otro taller distinto al de SEED_EMAIL.
 *   EQUIPO_PASSWORD             Contraseña de los usuarios del equipo que crea
 *                               este spec. Default: Demo1234
 *   TEL_BASE                    Prefijo de 8 dígitos para los teléfonos del
 *                               equipo (el backend exige teléfono único).
 *                               Default: 55119900 → ...01, 02, 03, 04
 *   DEMO_CLIENT_EMAIL           Correo REAL tuyo (con +tag) para el cliente:
 *                               ahí llega el "Activa tu cuenta" que necesitas
 *                               abrir en el celular.
 *   SIN_PAUSA_MOVIL=1           Salta la espera del celular y aprueba por API
 *                               como asesor. Úsalo para un ensayo rápido.
 *   DEMO_APPROVE_TIMEOUT_MS     Cuánto espera al celular. Default 10 min.
 *   DEMO_POLL_MS                Cada cuánto pregunta a la API. Default 4s.
 *   DEMO_PAUSE_MS               Respiro entre secciones (ritmo). Default 1200.
 */

// ── Configuración ────────────────────────────────────────────────────────────

const API = process.env.API || "http://localhost:3001/v1";
let ID_WORKSHOP = process.env.ID_WORKSHOP || null; // se resuelve solo si no lo pasas

const DUENO_EMAIL = process.env.SEED_EMAIL || "rsv.cup@gmail.com";
const DUENO_PASSWORD = process.env.SEED_PASSWORD || "admin123";

const EQUIPO_PASSWORD = process.env.EQUIPO_PASSWORD || "Demo1234";
const TEL_BASE = process.env.TEL_BASE || "55119900";

const CLIENTE_EMAIL = process.env.DEMO_CLIENT_EMAIL || "lusituti756+cliente2@gmail.com";
const CLIENTE_NOMBRE = process.env.DEMO_CLIENT_NAME || "Patricia Gómez Vidal";
const CLIENTE_TEL = process.env.DEMO_CLIENT_PHONE || "";

const SIN_PAUSA_MOVIL = process.env.SIN_PAUSA_MOVIL === "1";
const APPROVE_TIMEOUT_MS = Number(process.env.DEMO_APPROVE_TIMEOUT_MS) || 10 * 60_000;
const POLL_MS = Number(process.env.DEMO_POLL_MS) || 4000;
const PAUSE_MS = Number(process.env.DEMO_PAUSE_MS) || 1200;

/**
 * Correos del equipo, derivados del correo del dueño para que sean estables
 * entre corridas (así el spec es idempotente: la primera vez los crea, las
 * siguientes los reutiliza). Se usan +etiquetas, que Gmail entrega a la misma
 * bandeja, aunque estas cuentas NUNCA reciben correo (se crean con contraseña
 * directa; el correo de activación es solo para clientes).
 *   rsv.cup@gmail.com                      → rsv.cup+asesor@gmail.com
 *   enriquecruzpue+reforma-admin@gmail.com → enriquecruzpue+reforma-asesor@...
 */
function correoDeRol(correoDueno, sufijo) {
  const [local, dominio] = correoDueno.split("@");
  const [base, etiqueta] = local.split("+");
  // De la etiqueta del dueño nos quedamos con la parte del taller:
  //   "reforma-admin" → "reforma"   ·   sin etiqueta → ""
  const etiquetaTaller = (etiqueta || "").replace(/-?admin$/, "").replace(/-$/, "");
  const nueva = etiquetaTaller ? `${etiquetaTaller}-${sufijo}` : sufijo;
  return `${base}+${nueva}@${dominio}`;
}

/**
 * El equipo del taller. `rol` es el claim en español que guarda la BD; entre
 * paréntesis va el rol de negocio al que se normaliza (permissions.config.js).
 */
const EQUIPO = {
  gerente: {
    etiqueta: "Gerente",
    rol: "SUPER_ADMIN", // → admin
    nombre: "Mónica",
    apellido: "Salazar",
    email: process.env.EMAIL_GERENTE || correoDeRol(DUENO_EMAIL, "gerente"),
    phone: `${TEL_BASE}01`,
    veEnMenu: "Usuarios",
    noVeEnMenu: null, // el gerente ve prácticamente todo
  },
  asesor: {
    etiqueta: "Asesor de servicio",
    rol: "ASESOR", // → advisor
    nombre: "Daniela",
    apellido: "Ríos",
    email: process.env.EMAIL_ASESOR || correoDeRol(DUENO_EMAIL, "asesor"),
    phone: `${TEL_BASE}02`,
    veEnMenu: "Entrada de Vehículo",
    noVeEnMenu: "Abastecimiento",
  },
  compras: {
    etiqueta: "Compras",
    rol: "COMPRAS", // → purchasing
    nombre: "Ricardo",
    apellido: "Peña",
    email: process.env.EMAIL_COMPRAS || correoDeRol(DUENO_EMAIL, "compras"),
    phone: `${TEL_BASE}03`,
    veEnMenu: "Abastecimiento",
    noVeEnMenu: "Clientes",
  },
  mecanico: {
    etiqueta: "Técnico",
    rol: "MECANICO", // → mechanic
    nombre: "Javier",
    apellido: "Mora",
    email: process.env.EMAIL_MECANICO || correoDeRol(DUENO_EMAIL, "mecanico"),
    phone: `${TEL_BASE}04`,
    veEnMenu: "Producción",
    noVeEnMenu: "Clientes",
  },
};

const DUENO = {
  etiqueta: "Dueño",
  rol: "ADMIN", // → owner
  email: DUENO_EMAIL,
  password: DUENO_PASSWORD,
  veEnMenu: "Usuarios",
  noVeEnMenu: null,
};

// ── Helpers de API (cada llamada firmada por el rol que actúa) ───────────────

/**
 * Llama a la API con el token de `persona`. Que cada rol use SU token es lo
 * que hace que esta prueba valga: si el rol no tuviera permiso, el backend
 * responde 403 y el test falla aquí mismo.
 */
async function api(request, persona, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: await headersFor(persona.email, persona.password),
    ...(body ? { data: body } : {}),
  });
  if (!res.ok()) {
    throw new Error(
      `[${persona.etiqueta}] ${method.toUpperCase()} ${path} → ${res.status()}: ${await res.text()}`,
    );
  }
  const json = await res.json().catch(() => null);
  return json?.data ?? json;
}

const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

/**
 * Índices de todas las líneas de un arreglo — es lo que espera
 * `approve-concepts`: el cliente aprueba línea por línea, así que "aprobar
 * todo" es mandar todos los índices. Si viniera vacío, asume una sola línea.
 */
const indices = (arr) => (Array.isArray(arr) && arr.length ? arr.map((_, i) => i) : [0]);

/**
 * idWorkshop del taller. No hace falta pasarlo: el doc del dueño ya lo trae,
 * así que se deduce de SEED_EMAIL. ID_WORKSHOP lo fuerza si hiciera falta.
 */
async function resolverWorkshop(request, dueno) {
  if (ID_WORKSHOP) return ID_WORKSHOP;
  const yo = await api(request, dueno, "get", `/users/email/${encodeURIComponent(dueno.email)}`);
  const id = yo?.idWorkshop;
  if (!id) {
    throw new Error(
      `No pude deducir el idWorkshop de ${dueno.email}. Pásalo a mano con ID_WORKSHOP.`,
    );
  }
  console.log(`   🏢 Taller: ${id}`);
  return id;
}

/** Respiro entre secciones, para que la demo se pueda seguir con la vista. */
const beat = (page) => page.waitForTimeout(PAUSE_MS);

// ── Alta idempotente del equipo ─────────────────────────────────────────────

/**
 * Da de alta a un integrante del equipo con su rol. Si ya existe (segunda
 * corrida), lo recupera en vez de fallar: así el spec se puede correr las
 * veces que quieras y las credenciales del equipo no cambian.
 */
async function asegurarUsuario(request, dueno, persona) {
  try {
    const creado = await api(request, dueno, "post", "/users", {
      idWorkshop: ID_WORKSHOP,
      name: persona.nombre,
      firstSurname: persona.apellido,
      email: persona.email,
      password: EQUIPO_PASSWORD,
      rol: persona.rol,
      country: "México",
      phone: persona.phone,
    });
    console.log(`   + ${persona.etiqueta} creado (${persona.email})`);
    return idOf(creado);
  } catch (err) {
    const yaExiste = /existe|already|duplicad|400|409/i.test(err.message);
    if (!yaExiste) throw err;
    const existente = await api(
      request,
      dueno,
      "get",
      `/users/email/${encodeURIComponent(persona.email)}`,
    );
    const id = idOf(existente);
    if (!id) {
      throw new Error(
        `${persona.etiqueta} (${persona.email}) ya existía pero no se pudo recuperar: ${err.message}\n` +
          "Si el choque fue por TELÉFONO y no por correo, corre con otro TEL_BASE.",
      );
    }
    console.log(`   = ${persona.etiqueta} ya existía, lo reutilizo (${persona.email})`);
    return id;
  }
}

// ── Sesión por UI (cerrar / iniciar de verdad) ───────────────────────────────

const itemMenu = (page, nombre) =>
  page.locator("aside").getByRole("button", { name: nombre, exact: true });

async function iniciarSesion(page, persona) {
  await page.goto("/login");
  await page.locator("#email").fill(persona.email);
  await beat(page);
  await page.locator("#password").fill(persona.password);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 30000 });
  await beat(page);
}

/**
 * Cierra sesión por la UI: botón del header (aria-label "Cerrar sesión") →
 * modal de confirmación → botón "Cerrar sesión" del modal.
 * Si la UI cambia, cae a un cierre por almacenamiento para no tumbar la
 * corrida (pero lo avisa, porque significa que el selector quedó viejo).
 */
async function cerrarSesion(page) {
  try {
    await page.locator('button[aria-label="Cerrar sesión"]').first().click({ timeout: 8000 });
    await expect(page.getByText(/cerrar sesion|cerrar sesión/i).first()).toBeVisible({
      timeout: 8000,
    });
    await page
      .getByRole("button", { name: /^cerrar sesión$/i })
      .last()
      .click();
    await page.waitForURL(/\/login/, { timeout: 20000 });
  } catch (err) {
    console.warn(
      `   ⚠️  No pude cerrar sesión por la UI (${err.message.split("\n")[0]}). ` +
        "Limpio el almacenamiento y sigo — revisa si cambiaron los selectores del header.",
    );
    await page.context().clearCookies();
    await page.evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {}
    });
    await page.goto("/login");
  }
  await beat(page);
}

/**
 * Entra como `persona`, comprueba que su menú es el que le toca y deja la
 * sesión lista para que haga lo suyo. Devuelve nada: las acciones van por API.
 */
async function entrarComo(page, persona) {
  await iniciarSesion(page, persona);

  if (persona.veEnMenu) {
    await expect(
      itemMenu(page, persona.veEnMenu),
      `${persona.etiqueta} DEBE ver "${persona.veEnMenu}" en el menú`,
    ).toBeVisible({ timeout: 20000 });
  }
  if (persona.noVeEnMenu) {
    await expect(
      itemMenu(page, persona.noVeEnMenu),
      `${persona.etiqueta} NO debe ver "${persona.noVeEnMenu}" en el menú`,
    ).toHaveCount(0);
  }
}

// ── La pausa real del celular ────────────────────────────────────────────────

/**
 * Se queda esperando de verdad —consultando la API— hasta que la entrada
 * quede APROBADA. Mientras tanto, el presentador aprueba desde el celular.
 */
async function esperarAprobacionDelCliente(request, persona, entryId) {
  const limite = Date.now() + APPROVE_TIMEOUT_MS;
  let vueltas = 0;

  while (Date.now() < limite) {
    const entry = await api(request, persona, "get", `/entries/${entryId}`);
    if (entry?.approvalState === "APROBADA") {
      console.log("\n   ✅ ¡Aprobada desde el celular! Sigo con el recorrido.\n");
      return true;
    }
    if (vueltas % 5 === 0) {
      const restan = Math.round((limite - Date.now()) / 1000);
      console.log(
        `   ⏳ Esperando la aprobación del cliente en la app... (${restan}s antes de rendirme)`,
      );
    }
    vueltas += 1;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return false;
}

// ── El recorrido ─────────────────────────────────────────────────────────────

test(
  "Punta a punta por roles en QA: dueño arma el equipo → asesor recibe → técnico diagnostica → cliente aprueba en su celular → compras abastece → técnico repara → asesor entrega → dueño ve las finanzas",
  { tag: ["@ui", "@lento", "@qa"] },
  async ({ page, request }) => {
    test.setTimeout(APPROVE_TIMEOUT_MS + 15 * 60_000);

    const s = String(Date.now()).slice(-6);
    const dueno = { ...DUENO, password: DUENO_PASSWORD };
    const equipo = {};
    let entryId, quoteId, carId, inventoryId, os, conceptos;

    ID_WORKSHOP = await resolverWorkshop(request, dueno);

    // ── 1. El DUEÑO arma su equipo ──────────────────────────────────────────
    await test.step("1) Dueño: entra, y da de alta al equipo con sus roles", async () => {
      await entrarComo(page, dueno);

      // El claim del dueño debe ser ADMIN (→ owner). Si esto falla, el resto
      // del recorrido no tendría sentido.
      const claims = claimsOf(await signIn(dueno.email, dueno.password));
      expect(claims.role, "el admin del taller debe tener claim ADMIN").toBe("ADMIN");

      for (const [clave, persona] of Object.entries(EQUIPO)) {
        const id = await asegurarUsuario(request, dueno, persona);
        equipo[clave] = { ...persona, id, password: EQUIPO_PASSWORD };

        // El backend debió firmar el claim del rol asignado.
        const claimRol = claimsOf(await signIn(persona.email, EQUIPO_PASSWORD)).role;
        expect(claimRol, `claim de ${persona.etiqueta}`).toBe(persona.rol);
      }

      // Catálogo: la refacción ya existe en el almacén con 1 pieza, para que
      // más adelante falte 1 y Compras tenga algo real que resolver.
      const inv = await api(request, dueno, "post", "/inventory", {
        idWorkshop: ID_WORKSHOP,
        name: `Balatas delanteras ${s}`,
        sku: `BAL-${s}`,
        category: "Frenos",
        brand: "OEM",
        unit: "juego",
        cost: 500,
        price: 850,
        stock: 1,
        minStock: 0,
      });
      inventoryId = idOf(inv);
    });

    // ── 2. El ASESOR recibe el auto ─────────────────────────────────────────
    await test.step("2) Asesor: cierra el dueño, entra él, y recibe cliente + vehículo + hoja de servicio", async () => {
      await cerrarSesion(page);
      await entrarComo(page, equipo.asesor);

      // Alta CON CUENTA: al cliente le llega el correo "Activa tu cuenta",
      // que es lo que va a usar en el celular para aprobar.
      const alta = await api(request, equipo.asesor, "post", "/clients/with-account", {
        fullName: CLIENTE_NOMBRE,
        email: CLIENTE_EMAIL,
        ...(CLIENTE_TEL ? { phone: CLIENTE_TEL } : {}),
        idWorkshop: ID_WORKSHOP,
        createdBy: equipo.asesor.id,
      });
      const clientId = alta?.client?.id ?? idOf(alta);
      expect(clientId, "el alta del cliente debe devolver un id").toBeTruthy();

      // El backend solo manda el correo de activación si la cuenta todavía no
      // está verificada; lo decimos en voz alta para no esperar de más.
      if (alta?.hasVerifiedAccount) {
        console.log(
          `\n   📧 ${CLIENTE_EMAIL} ya está activada: NO se manda correo. ` +
            "Entra directo en la app con su contraseña.\n",
        );
      } else if (alta?.activationSent) {
        console.log(
          `\n   📧 Correo de activación enviado a ${CLIENTE_EMAIL} ` +
            '(busca "Activa tu cuenta"; revisa Spam/Promociones).\n',
        );
      } else {
        console.log(
          `\n   ⚠️  ${CLIENTE_EMAIL} sin verificar y el correo NO se pudo enviar ` +
            "(¿Brevo?). Se puede reenviar desde la app.\n",
        );
      }


      const car = await api(request, equipo.asesor, "post", "/cars", {
        clientId,
        brand: "Nissan",
        model: "Versa Demo",
        year: 2023,
        vin: `DEMOMR${s}00000000`.slice(0, 17),
        codeCar: `DEMO${s}`,
        color: "Blanco",
        fuel: "Gasolina",
        transmition: "Automática",
        km: 15000,
      });
      carId = idOf(car);

      const entry = await api(request, equipo.asesor, "post", "/entries", {
        idWorkshop: ID_WORKSHOP,
        clientId,
        carId,
        assigned_mechanic: equipo.mecanico.id,
        status: 1,
        observations: "Recorrido multi-rol de demo",
        registerDate: Date.now(),
        approvalState: "EN ESPERA",
        createdBy: equipo.asesor.id,
        createdByName: `${equipo.asesor.nombre} ${equipo.asesor.apellido}`,
      });
      entryId = idOf(entry);
      os = entry?.sheet;
      expect(os, "la entrada debe traer número de OS").toBeTruthy();

      await api(request, equipo.asesor, "post", `/entries/${entryId}/service-sheet`, {
        car_items: ["Documentos", "Llave", "Birlo de seguridad"],
        checks: ["Servicio de Frenos"],
        isCheckAll: false,
        observations: "Cliente reporta ruido al frenar.",
        km: 15000,
        fuel_tank: "1/2",
      });

      console.log(`\n   📋 OS ${os} abierta por ${equipo.asesor.etiqueta}\n`);
    });

    // ── 3. El TÉCNICO diagnostica ───────────────────────────────────────────
    await test.step("3) Técnico: cierra el asesor, entra él, y captura el diagnóstico", async () => {
      await cerrarSesion(page);
      await entrarComo(page, equipo.mecanico);

      await api(request, equipo.mecanico, "post", `/entries/${entryId}/diagnostics`, {
        idMechanic: equipo.mecanico.id,
        generalObservations: "Balatas delanteras al límite; el resto sin observaciones.",
        findings: [
          {
            id: "hallazgo-rojo",
            system: "Frenos",
            component: "Balatas delanteras",
            finding: "Desgaste al límite, contacto metal-metal.",
            severity: "ROJO",
            recommendation: "Reemplazo inmediato.",
            commercialDescription: "Cambio de balatas delanteras.",
            consequence: "Riesgo de frenado deficiente.",
          },
        ],
      });
    });

    // ── 4. El ASESOR cotiza y manda la cotización ───────────────────────────
    await test.step("4) Asesor: vuelve a entrar, cotiza y manda la cotización al cliente", async () => {
      await cerrarSesion(page);
      await entrarComo(page, equipo.asesor);

      // Costeo (borrador, sin folio) → cotización con precios (folio 01).
      const costeo = await api(request, equipo.asesor, "post", `/entries/${entryId}/quotes`, {
        diagnostic: "Costeo interno",
        labor: [{ description: "Cambio de balatas delanteras", count: 1, cost: "", subtotal: 0 }],
        parts: [{ description: "Balatas delanteras", count: 2, cost: "", subtotal: 0, inventoryId }],
        status: 2,
        stage: "COSTEO",
      });
      quoteId = idOf(costeo);

      const quote = await api(
        request,
        equipo.asesor,
        "put",
        `/entries/${entryId}/quotes/${quoteId}`,
        {
          labor: [{ description: "Cambio de balatas delanteras", count: 2, cost: 400, subtotal: 800 }],
          parts: [{ description: "Balatas delanteras", count: 2, cost: 850, subtotal: 1700, inventoryId }],
          status: 2,
          stage: "COTIZACION",
          advance: 500,
        },
      );
      expect(quote?.quoteNumber, "la cotización debe llevar folio").toBeTruthy();

      // Lo que el cliente verá para aprobar en su celular, línea por línea.
      conceptos = {
        approvedParts: indices(quote?.parts),
        approvedLabor: indices(quote?.labor),
      };

      const antes = await api(request, equipo.asesor, "get", `/entries/${entryId}`);
      expect(antes?.approvalState, "aún no debe estar aprobada").not.toBe("APROBADA");
    });

    // ── 5. LA PAUSA: el cliente aprueba desde su celular ────────────────────
    await test.step("5) ⏸ PAUSA — el cliente aprueba la cotización desde la app móvil", async () => {
      if (SIN_PAUSA_MOVIL) {
        // OJO: se llama al MISMO endpoint que usa la app del cliente
        // (`approve-concepts`), no a un `PUT approvalState`. Ahí vive
        // `applyApprovedSelection`, que es quien genera la cotización oficial,
        // reserva el inventario y calcula los faltantes. Un PUT crudo del
        // estado marca la OS como aprobada pero NO dispara nada de eso, y el
        // resto del recorrido (Compras) se queda sin trabajo que hacer.
        console.log(
          "\n   ⏭  SIN_PAUSA_MOVIL=1 → apruebo por API con el mismo endpoint que la app.\n",
        );
        await api(
          request,
          equipo.asesor,
          "post",
          `/entries/${entryId}/quotes/${quoteId}/approve-concepts`,
          conceptos,
        );
      } else {
        console.log(
          "\n" +
            "   ┌──────────────────────────────────────────────────────────────┐\n" +
            "   │  AHORA EN EL CELULAR:                                        │\n" +
            `   │  1. Abre el correo de ${CLIENTE_EMAIL}\n` +
            "   │     → 'Activa tu cuenta' → crea la contraseña.               │\n" +
            "   │  2. Entra a la app CCC-Taller con ese correo.                │\n" +
            `   │  3. Abre la cotización de la OS ${os} y toca APROBAR.\n` +
            "   └──────────────────────────────────────────────────────────────┘\n",
        );

        const aprobo = await esperarAprobacionDelCliente(request, equipo.asesor, entryId);
        expect(
          aprobo,
          `El cliente no aprobó en ${Math.round(APPROVE_TIMEOUT_MS / 60000)} min. ` +
            "Sube DEMO_APPROVE_TIMEOUT_MS, o corre con SIN_PAUSA_MOVIL=1 si solo querías ensayar.",
        ).toBe(true);
      }

      // Se confirma en la web del taller, que es donde el asesor lo vería.
      await page.reload();
      await beat(page);
      const aprobada = await api(request, equipo.asesor, "get", `/entries/${entryId}`);
      expect(aprobada?.approvalState).toBe("APROBADA");
      expect(aprobada?.needsProcurement, "debe quedar faltante para Compras").toBe(true);
    });

    // ── 6. COMPRAS resuelve el faltante ─────────────────────────────────────
    await test.step("6) Compras: cierra el asesor, entra él, pide el faltante y lo recibe", async () => {
      await cerrarSesion(page);
      await entrarComo(page, equipo.compras);

      // La OS pidió 2 piezas y en almacén había 1 → falta 1.
      const po = await api(request, equipo.compras, "post", "/purchase-orders", {
        idWorkshop: ID_WORKSHOP,
        entryId,
        items: [{ description: "Balatas delanteras (faltante)", qty: 1, unitCost: 500, inventoryId }],
      });
      await api(request, equipo.compras, "post", `/purchase-orders/${idOf(po)}/receive`, {
        items: [{ index: 0, received: 1 }],
      });

      const tras = await api(request, equipo.compras, "get", `/entries/${entryId}`);
      expect(
        Number(tras?.directReceived?.[inventoryId]),
        "la pieza recibida debe quedar asignada directo al auto",
      ).toBe(1);
    });

    // ── 7. El TÉCNICO repara ────────────────────────────────────────────────
    await test.step("7) Técnico: entra de nuevo y pone la OS en reparación", async () => {
      await cerrarSesion(page);
      await entrarComo(page, equipo.mecanico);

      await api(request, equipo.mecanico, "put", `/entries/${entryId}`, {
        statusService: "EN REPARACION",
      });
      const enReparacion = await api(request, equipo.mecanico, "get", `/entries/${entryId}`);
      expect(enReparacion?.statusService).toBe("EN REPARACION");
    });

    // ── 8. El ASESOR entrega ────────────────────────────────────────────────
    await test.step("8) Asesor: entra por última vez y entrega el vehículo", async () => {
      await cerrarSesion(page);
      await entrarComo(page, equipo.asesor);

      await api(request, equipo.asesor, "put", `/entries/${entryId}`, {
        statusService: "ENTREGADO",
      });
      const entregado = await api(request, equipo.asesor, "get", `/entries/${entryId}`);
      expect(entregado?.statusService).toBe("ENTREGADO");

      const auto = await api(request, equipo.asesor, "get", `/cars/${carId}`);
      expect(Number(auto?.lastServiceAt), "el auto debe registrar su último servicio").toBeGreaterThan(0);
    });

    // ── 9. El DUEÑO cierra el círculo con las finanzas ──────────────────────
    await test.step("9) Dueño: entra al final y ve el Centro de control (lo que solo él ve)", async () => {
      await cerrarSesion(page);
      await entrarComo(page, dueno);

      const dash = await api(request, dueno, "get", `/dashboard?idWorkshop=${ID_WORKSHOP}`);
      expect(dash?.finance, "el dueño debe ver las finanzas del taller").toBeTruthy();

      console.log(
        `\n   🏁 Recorrido completo. OS ${os} entregada, con el equipo entrando ` +
          "y saliendo en cada etapa.\n",
      );
    });
  },
);
