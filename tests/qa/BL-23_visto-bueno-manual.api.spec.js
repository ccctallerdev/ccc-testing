const { test, expect } = require("@playwright/test");
const { modo } = require("../../adminFlex");
const { authHeaders } = require("#apiToken");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-23 — El visto bueno MANUAL de Abastecimiento no mueve el auto
 * PRUEBAS DE API (nuevas, no recicladas)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Hermano de OBS31-01, y su otra mitad. Aquel spec prueba el camino
 * AUTOMÁTICO —recibir la pieza mueve el auto a REFACCIONES— y pasa en verde
 * sin tocar una línea de esto. El hueco está en el camino MANUAL.
 *
 * ── LA ESPECIFICACIÓN (Roberto, doc del 2-sep) ────────────────────────────
 *
 *     autorizar cotización             → EN ESPERA     (automático)
 *     abastecimiento parcial/completo  → REFACCIONES   (automático Y MANUAL)
 *
 * Nótese que la regla habla del ESTADO del abastecimiento, no de cómo se
 * llegó a él. Marcarlo a mano vale igual que recibir la pieza: para eso
 * existe el botón «Inicio parcial / Completo» en Abastecimiento.
 *
 * ── EL BUG, con precisión ─────────────────────────────────────────────────
 *
 * Abastecimiento.jsx:343 manda `putEntry(entryId, { repairReadiness: value })`.
 *
 * Eso SÍ se guarda —`schemas/entries/updateEntry.schema.js:18` acepta el campo
 * y `entries.service.js:567` hasta le sella `repairReadinessAt`—, así que la
 * pantalla se ve bien: el botón queda marcado.
 *
 * Lo que NO pasa es el avance de etapa. La línea que mueve el auto,
 *
 *     await new EntriesService().advanceStatusService(entryId, REFACCIONES);
 *
 * vive SOLO dentro de `purchaseOrders.service.js:404`
 * (`syncRepairReadinessForEntry`), que únicamente corre al RECIBIR una orden
 * de compra. `updateEntry` nunca la llama.
 *
 * Resultado: Abastecimiento da el auto por listo, el Mecánico puede trabajarlo
 * —`production.service.js:161` usa `repairReadiness` solo para advertir, no
 * para bloquear— pero el tablero lo sigue mostrando EN ESPERA y el cronómetro
 * de REFACCIONES nunca arranca. El tablero y la realidad se separan.
 *
 * ── POR QUÉ EL RECORRIDO E2E NO LO CACHÓ ──────────────────────────────────
 *
 * Porque ahí la orden SÍ se recibe, así que corre el camino automático y el
 * auto se mueve bien. El hueco está en el caso donde alguien marca «Completo»
 * sin que haya llegado nada — que es justo para lo que existe el botón manual
 * (la pieza la trajo el cliente, se surtió de otro lado, se decide arrancar
 * con lo que hay).
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *
 * ► ANTES DEL MERGE — contra el backend de la RAMA en local. QA corre el
 *   código viejo: apuntar el spec a QA no probaría el arreglo, solo
 *   confirmaría el bug.
 *
 *     # terminal 1 — parado en la rama del fix
 *     cd C:\Users\USER\Documents\TRABAJO\ccc-backend\functions
 *     npm run dev                      # escucha en localhost:3001
 *
 *     # terminal 2
 *     cd C:\Users\USER\Documents\TRABAJO\ccc-testing
 *     $env:API="http://localhost:3001/v1"
 *     $env:AUTH_REAL="1"; $env:SKIP_SEED="1"
 *     $env:ID_WORKSHOP="<taller de pruebas de refac>"
 *     $env:SEED_EMAIL="<correo del Dueño>"; $env:SEED_PASSWORD="<contraseña>"
 *     npx playwright test --project=qa tests/qa/BL-23_visto-bueno-manual.api.spec.js
 *
 * ► DESPUÉS DEL DEPLOY A QA, la misma suite sin tocar el archivo:
 *     $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"
 *
 * ── QUÉ DEBE PASAR HOY (antes del fix) ────────────────────────────────────
 *
 *   Caso 0 y 1  → VERDE  (el montaje y la línea base son correctos hoy)
 *   Caso 2      → ROJO   ← EL BUG. Guarda la bandera pero deja EN ESPERA.
 *   Caso 3      → ROJO   (misma causa, con PARCIAL)
 *   Caso 4      → VERDE  (no-regresión: NINGUNO no debe mover nada)
 *   Caso 5      → VERDE  (no-regresión: la máquina nunca retrocede)
 *
 * Si el caso 2 sale VERDE antes de tocar el backend, algo está mal en el
 * montaje —lo más probable, que la orden de compra se haya recibido sola— y
 * el spec no está probando lo que dice.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || (modo === "emulador" ? "taller-prueba" : null);
if (!ID_WORKSHOP) {
  throw new Error('Falta ID_WORKSHOP (taller real de refac). Ej: $env:ID_WORKSHOP="05Pf..."');
}
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba";
const S = `${String(Date.now()).slice(-7)}`;
const PRECIO = 850;

/**
 * Telefono de cada cliente del spec. 10 digitos EXACTOS —estandar OBS31-08: el
 * backend limpia el formato y rechaza lo que no quede en 10— y UNICO por
 * cliente, porque el API deduplica por telefono y responde CLIENT_EXISTS.
 *
 * OJO CON EL RECORTE, que es donde ya nos mordio dos veces. El patron heredado
 * era `57${S}00`.slice(0, 10): prefijo (2) + sello (7) = 9, mas el sufijo de 2
 * = 11, y el slice se comia JUSTO el digito que distinguia un cliente de otro.
 * Los tres nacian con el mismo telefono. En OBS31-01, de donde se copio, hay un
 * solo cliente y por eso alli no se nota nunca.
 *
 * Aqui el indice va ANTES del sello y la cuenta da 10 sin recortar nada:
 *   55 (2) + indice (1) + S (7) = 10
 */
const telDe = (i) => `55${i}${S}`;

/**
 * VIN de cada auto: 17 exactos y unicos (el backend los exige asi).
 *   B23 (3) + indice (1) + S (7) + relleno (6) = 17
 */
const vinDe = (i) => `B23${i}${S}000000`;

// Candado: un dato de prueba mal armado se ve AQUI, al arrancar, y no como un
// CLIENT_EXISTS a media corrida.
const TELS = [0, 1, 2].map(telDe);
const VINS = [0, 1, 2].map(vinDe);
if (new Set(TELS).size !== TELS.length) {
  throw new Error(`Los telefonos del spec se repiten: ${TELS.join(", ")}`);
}
if (new Set(VINS).size !== VINS.length) {
  throw new Error(`Los VIN del spec se repiten: ${VINS.join(", ")}`);
}
for (const t of TELS) {
  if (!/^[0-9]{10}$/.test(t)) {
    throw new Error(`Telefono de ${t.length} digitos, deben ser 10 limpios: "${t}"`);
  }
}
for (const v of VINS) {
  if (v.length !== 17) throw new Error(`VIN de largo ${v.length}, deben ser 17: "${v}"`);
}

let entryId, quoteId, poId;

async function call(request, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: await authHeaders(),
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json, data: json?.data ?? json };
}
/**
 * Id de un documento recien creado.
 *
 * Lanza si no lo encuentra, a proposito: la version permisiva devolvia el
 * OBJETO entero cuando el POST habia fallado, y eso terminaba pegandole al API
 * con `/entries/[object Object]`. El error salia tres pasos despues y no decia
 * nada del POST que en realidad se cayo.
 */
const idOf = (d, que = "el documento") => {
  const id = d?.id ?? d?.entryId ?? d?._id;
  if (typeof id === "string" && id) return id;
  throw new Error(`no pude leer el id de ${que}; el API respondio: ${JSON.stringify(d)}`);
};

async function estadoDeLaOS(request) {
  const r = await call(request, "get", `/entries/${entryId}`);
  const e = r.data?.descripcion && typeof r.data.descripcion === "object" ? r.data.descripcion : r.data;
  return {
    statusService: e?.statusService ?? null,
    repairReadiness: e?.repairReadiness ?? null,
    repairReadinessAt: e?.repairReadinessAt ?? null,
  };
}

test.describe.configure({ mode: "serial" });

test.describe("BL-23 · el visto bueno manual de Abastecimiento mueve el auto @api", () => {
  test("0) se arma una OS aprobada con una orden de compra SIN recibir", async ({ request }) => {
    const cliente = await call(request, "post", "/clients", {
      fullName: `Cliente bl23 ${S}`,
      email: `bl23.${S}@test.com`,
      phone: telDe(0),
      idWorkshop: ID_WORKSHOP,
      createdBy: MECHANIC_ID,
    });
    const clientId = idOf(cliente.data, "el cliente");

    const auto = await call(request, "post", "/cars", {
      clientId, brand: "Nissan", model: "Versa", year: 2020,
      // 17 exactos: el backend exige VIN unico y de ese largo.
      vin: vinDe(0),
      codeCar: `B23-${S.slice(-5)}`,
      color: "Azul", fuel: "Gasolina", transmition: "Manual", km: 51000,
    });

    const os = await call(request, "post", "/entries", {
      idWorkshop: ID_WORKSHOP, clientId, carId: idOf(auto.data, "el auto"),
      assigned_mechanic: MECHANIC_ID, status: 1,
      observations: "spec BL-23 (visto bueno manual de abastecimiento)",
      registerDate: Date.now(), approvalState: "EN ESPERA",
    });
    expect(os.status, JSON.stringify(os.body)).toBeLessThan(300);
    entryId = idOf(os.data, "la OS");

    const hoja = await call(request, "post", `/entries/${entryId}/service-sheet`, {
      car_items: ["Documentos", "Llave"],
      checks: ["Servicio de Frenos"],
      isCheckAll: false,
      observations: "spec BL-23",
      km: 51000,
      fuel_tank: "1/2",
    });
    expect(hoja.status, `la hoja de servicio debe crearse: ${JSON.stringify(hoja.body)}`).toBeLessThan(300);

    const cot = await call(request, "post", `/entries/${entryId}/quotes`, {
      diagnostic: "Frenos: balatas al límite",
      labor: [{ description: "Cambio de balatas", count: 1, unitPrice: 300, cost: 300, subtotal: 300, state: true }],
      parts: [{
        description: `Balatas delanteras ${S}`,
        count: 2,
        unitPrice: PRECIO, cost: PRECIO, subtotal: 2 * PRECIO, state: true,
        costProveedor: 600, utilidad: 29.41,
        supplierId: `SUP-${S}`, supplierName: "Refaccionaria ACME",
        availability: "VERDE",
      }],
      status: 2,
      clientBringsParts: false,
      stage: "COTIZACION",
    });
    expect(cot.status, JSON.stringify(cot.body)).toBeLessThan(300);
    quoteId = idOf(cot.data);

    const ap = await call(request, "post", `/entries/${entryId}/quotes/${quoteId}/approve-concepts`, {
      approvedParts: [0],
      approvedLabor: [0],
    });
    expect(ap.status, JSON.stringify(ap.body)).toBeLessThan(300);

    // Una orden de compra ligada a la OS, que se deja SIN RECIBIR a proposito:
    // es lo que garantiza que el camino automatico no corra y que lo unico que
    // pueda mover el auto sea el visto bueno manual.
    const po = await call(request, "post", "/purchase-orders", {
      idWorkshop: ID_WORKSHOP,
      supplierId: `SUP-${S}`,
      entryId,
      notes: "spec BL-23 — no se recibe a proposito",
      items: [{ description: `Balatas delanteras ${S}`, qty: 2, unitCost: 600 }],
    });
    expect(po.status, JSON.stringify(po.body)).toBeLessThan(300);
    poId = idOf(po.data, "la orden de compra");
    expect(poId, "la orden de compra debe crearse").toBeTruthy();
  });

  test("1) línea base: aprobada y sin recibir nada → EN ESPERA, readiness NINGUNO", async ({ request }) => {
    const { statusService, repairReadiness } = await estadoDeLaOS(request);
    expect(statusService, "aprobar deja la OS EN ESPERA (OBS31-01)").toBe("EN ESPERA");
    expect(repairReadiness ?? "NINGUNO", "sin recibir nada, el abastecimiento es NINGUNO").toBe("NINGUNO");
  });

  test("2) EL BUG: marcar COMPLETO a mano guarda la bandera pero NO mueve el auto", async ({ request }) => {
    const put = await call(request, "put", `/entries/${entryId}`, { repairReadiness: "COMPLETO" });
    expect(put.status, `el PUT debe ser aceptado: ${JSON.stringify(put.body)}`).toBeLessThan(300);

    const { statusService, repairReadiness, repairReadinessAt } = await estadoDeLaOS(request);

    // Esta mitad YA funciona hoy. Se afirma para dejar claro que el problema
    // NO es que el campo se ignore —se guarda, y hasta se sella la hora—, y
    // para que un futuro arreglo no la rompa de pasada.
    expect(repairReadiness, "la bandera SÍ se guarda (esto ya funciona)").toBe("COMPLETO");
    expect(repairReadinessAt, "y se sella la hora del visto bueno").toBeTruthy();

    // Esta es la que falla hoy.
    expect(
      statusService,
      "BL-23: Abastecimiento dio el auto por listo, pero el tablero lo deja EN ESPERA. " +
        "El avance a REFACCIONES vive solo en purchaseOrders.service (camino automático) " +
        "y updateEntry nunca lo llama.",
    ).toBe("REFACCIONES");
  });

  test("3) lo mismo con PARCIAL, en una OS nueva", async ({ request }) => {
    // OS nueva: la del caso 2 ya avanzo (o deberia haberlo hecho) y la maquina
    // de estados no retrocede, asi que reusarla no probaria nada.
    const cliente = await call(request, "post", "/clients", {
      fullName: `Cliente bl23 parcial ${S}`,
      email: `bl23p.${S}@test.com`,
      phone: telDe(1),
      idWorkshop: ID_WORKSHOP,
      createdBy: MECHANIC_ID,
    });
    const clientId = idOf(cliente.data, "el cliente");
    const auto = await call(request, "post", "/cars", {
      clientId, brand: "Nissan", model: "March", year: 2019,
      vin: vinDe(1),
      codeCar: `B2P-${S.slice(-5)}`,
      color: "Rojo", fuel: "Gasolina", transmition: "Manual", km: 62000,
    });
    const os = await call(request, "post", "/entries", {
      idWorkshop: ID_WORKSHOP, clientId, carId: idOf(auto.data, "el auto"),
      assigned_mechanic: MECHANIC_ID, status: 1,
      observations: "spec BL-23 parcial",
      registerDate: Date.now(), approvalState: "EN ESPERA",
    });
    expect(cliente.status, `cliente: ${JSON.stringify(cliente.body)}`).toBeLessThan(300);
    expect(auto.status, `auto: ${JSON.stringify(auto.body)}`).toBeLessThan(300);
    expect(os.status, `OS: ${JSON.stringify(os.body)}`).toBeLessThan(300);
    const otraOS = idOf(os.data, "la OS");

    const put = await call(request, "put", `/entries/${otraOS}`, { repairReadiness: "PARCIAL" });
    expect(put.status, JSON.stringify(put.body)).toBeLessThan(300);

    const r = await call(request, "get", `/entries/${otraOS}`);
    const e = r.data?.descripcion && typeof r.data.descripcion === "object" ? r.data.descripcion : r.data;
    expect(e?.repairReadiness).toBe("PARCIAL");
    expect(
      e?.statusService,
      "BL-23: el abastecimiento PARCIAL manual también debe mover el auto (misma regla que el automático)",
    ).toBe("REFACCIONES");
  });

  test("4) NO-REGRESIÓN: marcar NINGUNO no mueve nada", async ({ request }) => {
    const cliente = await call(request, "post", "/clients", {
      fullName: `Cliente bl23 ninguno ${S}`,
      email: `bl23n.${S}@test.com`,
      phone: telDe(2),
      idWorkshop: ID_WORKSHOP,
      createdBy: MECHANIC_ID,
    });
    const clientId = idOf(cliente.data, "el cliente");
    const auto = await call(request, "post", "/cars", {
      clientId, brand: "Nissan", model: "Tsuru", year: 2015,
      vin: vinDe(2),
      codeCar: `B2N-${S.slice(-5)}`,
      color: "Blanco", fuel: "Gasolina", transmition: "Manual", km: 98000,
    });
    const os = await call(request, "post", "/entries", {
      idWorkshop: ID_WORKSHOP, clientId, carId: idOf(auto.data, "el auto"),
      assigned_mechanic: MECHANIC_ID, status: 1,
      observations: "spec BL-23 ninguno",
      registerDate: Date.now(), approvalState: "EN ESPERA",
    });
    expect(cliente.status, `cliente: ${JSON.stringify(cliente.body)}`).toBeLessThan(300);
    expect(auto.status, `auto: ${JSON.stringify(auto.body)}`).toBeLessThan(300);
    expect(os.status, `OS: ${JSON.stringify(os.body)}`).toBeLessThan(300);
    const otraOS = idOf(os.data, "la OS");

    // Se compara ANTES contra DESPUES en vez de afirmar un literal: una OS
    // recien creada NO trae `statusService` —`entries.service.js` solo pone
    // `status: 1` y `approvalState`, y la etapa la estrena la aprobacion—, asi
    // que esperar "EN ESPERA" aqui era afirmar algo que nunca fue cierto.
    // Lo que importa no es el valor, sino que NO cambie.
    const leerEtapa = async () => {
      const r = await call(request, "get", `/entries/${otraOS}`);
      const e = r.data?.descripcion && typeof r.data.descripcion === "object" ? r.data.descripcion : r.data;
      return { statusService: e?.statusService ?? null, repairReadiness: e?.repairReadiness ?? null };
    };

    const antes = await leerEtapa();

    const put = await call(request, "put", `/entries/${otraOS}`, { repairReadiness: "NINGUNO" });
    expect(put.status, JSON.stringify(put.body)).toBeLessThan(300);

    const despues = await leerEtapa();
    expect(despues.repairReadiness, "la bandera sí se guarda, aunque sea NINGUNO").toBe("NINGUNO");
    expect(
      despues.statusService,
      "NINGUNO significa «todavía no hay abastecimiento»: no puede adelantar el auto",
    ).toBe(antes.statusService);
    expect(
      despues.statusService,
      "y desde luego no puede mandarlo a REFACCIONES",
    ).not.toBe("REFACCIONES");
  });

  test("5) NO-REGRESIÓN: la máquina de estados no retrocede", async ({ request }) => {
    // Volver a NINGUNO despues de COMPLETO es una correccion del usuario sobre
    // la BANDERA, no una marcha atras del auto: `advanceStatusService` solo va
    // hacia adelante y la etapa se queda donde estaba.
    const put = await call(request, "put", `/entries/${entryId}`, { repairReadiness: "NINGUNO" });
    expect(put.status, JSON.stringify(put.body)).toBeLessThan(300);

    const { statusService } = await estadoDeLaOS(request);
    expect(
      statusService,
      "corregir la bandera no puede regresar el auto de etapa",
    ).toBe("REFACCIONES");
  });
});
