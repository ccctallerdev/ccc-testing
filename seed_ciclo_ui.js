/**
 * Semilla de RECORRIDO UI — crea SIETE OS, cada una congelada en una etapa
 * distinta del ciclo de vida, para revisar pantalla por pantalla si a la UI
 * le falta algo en cada estado:
 *
 *   OS A  Solo entrada + hoja            → botones Q26 grises, sin diagnóstico
 *   OS B  Con diagnóstico                → botón Diagnóstico ✓, sin costeo
 *   OS C  Con costeo (borrador)          → lista muestra "Costeo · sin precios" sin folio
 *   OS D  Con cotización (folio+anticipo)→ folio OS-01, total en grande, desglose anticipo
 *   OS E  Aprobada con faltante          → botón Abastecimiento ámbar, comprometido en inventario
 *   OS F  En REPARACIÓN                  → stock consumido, timer de producción
 *   OS G  ENTREGADA                      → en Vehículos Entregados, lastServiceAt en el auto
 *
 * USO:  1) emuladores + backend corriendo · 2) node seed_ciclo_ui.js
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECANICO = "mecanico-prueba";
const suffix = String(Date.now()).slice(-5);

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok) {
    const d = json ? JSON.stringify(json.errors ?? json.descripcion ?? json) : res.statusText;
    throw new Error(`${method} ${path} → ${res.status}: ${d}`);
  }
  return json?.data ?? json;
}
const post = (p, b) => call("POST", p, b);
const put = (p, b) => call("PUT", p, b);
const get = (p) => call("GET", p);
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

const ASESORES = [
  { id: "asesor-ana", name: "Ana Torres" },
  { id: "asesor-beto", name: "Beto Ramírez" },
];

// Teléfonos únicos por corrida: contador secuencial (el random colisionaba
// ~20% de las veces con 7 clientes).
let phoneSeq = 10;

/** Entrada base: cliente + auto + entrada + hoja (con llave/birlo) + diagnóstico opcional. */
async function baseOs(tag, { withDiagnostic = true, asesor = ASESORES[0] } = {}) {
  const client = await post("/clients", {
    fullName: `Ciclo ${tag} ${suffix}`,
    email: `ciclo.${tag.toLowerCase()}.${suffix}@test.com`,
    phone: `51${suffix}${phoneSeq++}`,
    idWorkshop: ID_WORKSHOP,
    createdBy: asesor.id,
  });
  const clientId = idOf(client);
  await post("/tokens", { idWorkshop: ID_WORKSHOP, idClient: clientId });

  const car = await post("/cars", {
    clientId,
    brand: "Nissan",
    model: `Etapa ${tag}`,
    year: 2020,
    vin: `CU${tag}${suffix}000000000`.slice(0, 17),
    codeCar: `${tag}${suffix}`.slice(0, 8),
    color: "Gris",
    fuel: "Gasolina",
    transmition: "Manual",
    km: 60000,
  });
  const carId = idOf(car);

  const entry = await post("/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId,
    carId,
    assigned_mechanic: MECANICO,
    status: 1,
    observations: `Etapa ${tag} del recorrido UI`,
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
    createdBy: asesor.id,
    createdByName: asesor.name,
  });
  const entryId = idOf(entry);

  await post(`/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos", "Llave", "Birlo de seguridad", "Gato"],
    checks: ["Servicio de Frenos"],
    isCheckAll: false,
    observations: `Hoja de la etapa ${tag}.`,
    km: 60000,
    fuel_tank: "1/2",
  });

  if (withDiagnostic) {
    await post(`/entries/${entryId}/diagnostics`, {
      idMechanic: MECANICO,
      generalObservations: `Diagnóstico de la etapa ${tag}.`,
      findings: [
        { id: `${tag}-r`, system: "Frenos", component: "Balatas", finding: "Al límite.", severity: "ROJO", recommendation: "Cambio inmediato.", commercialDescription: "Frenos al límite.", consequence: "Riesgo al frenar." },
      ],
    });
  }
  return { entryId, carId, os: entry?.sheet };
}

/** Costeo (borrador) en una OS. */
const addCosteo = (entryId, inventoryId) =>
  post(`/entries/${entryId}/quotes`, {
    diagnostic: "Costeo del recorrido (sin precios)",
    labor: [{ description: "Cambio de balatas", count: 1, cost: "", subtotal: 0 }],
    parts: [{ description: "Balatas", count: 2, cost: "", subtotal: 0, ...(inventoryId ? { inventoryId } : {}) }],
    status: 2,
    stage: "COSTEO",
  });

/** Cotización con precios + anticipo. */
const addQuote = (entryId, inventoryId) =>
  post(`/entries/${entryId}/quotes`, {
    diagnostic: "Cotización del recorrido",
    labor: [{ description: "Cambio de balatas", count: 2, cost: 400, subtotal: 800 }],
    parts: [{ description: "Balatas", count: 2, cost: 850, subtotal: 1700, ...(inventoryId ? { inventoryId } : {}) }],
    status: 2,
    stage: "COTIZACION",
    advance: 500,
  });

/** Selección oficial + aprobar (dispara reserva y faltante). */
async function approve(entryId) {
  const quotes = (await get(`/entries/${entryId}/quotes?limit=10`))?.quotes ?? [];
  const sheets = (await get(`/entries/${entryId}/service-sheet?limit=10`))?.serviceSheets ?? [];
  const priced = quotes.find((q) => q.stage === "COTIZACION") ?? quotes[0];
  await put(`/entries/${entryId}/approve-selection`, {
    approvedQuoteId: idOf(priced),
    approvedServiceSheetId: idOf(sheets[0]),
  });
  await put(`/entries/${entryId}`, { approvalState: "APROBADA" });
}

async function main() {
  console.log(`🌱 Recorrido UI en ${API} · taller ${ID_WORKSHOP}\n`);

  // Inventario compartido: 1 pieza (las OS que piden 2 generan faltante).
  const inv = await post("/inventory", {
    idWorkshop: ID_WORKSHOP,
    name: `Balatas Recorrido ${suffix}`,
    sku: `REC-${suffix}`,
    category: "Frenos",
    brand: "OEM",
    unit: "juego",
    cost: 500,
    price: 850,
    stock: 1,
    minStock: 0,
  });
  const inventoryId = idOf(inv);

  // A — solo entrada + hoja (sin diagnóstico)
  const A = await baseOs("A", { withDiagnostic: false });
  console.log(`✅ OS ${A.os} [A] entrada+hoja — revisa: botones Q26 grises`);

  // B — con diagnóstico
  const B = await baseOs("B");
  console.log(`✅ OS ${B.os} [B] diagnóstico — revisa: botón Diagnóstico ✓ azul`);

  // C — con costeo
  const C = await baseOs("C");
  await addCosteo(C.entryId, inventoryId);
  console.log(`✅ OS ${C.os} [C] costeo — revisa: "Costeo · sin precios" SIN folio`);

  // D — con cotización (folio + anticipo)
  const D = await baseOs("D", { asesor: ASESORES[1] });
  await addCosteo(D.entryId, inventoryId);
  await addQuote(D.entryId, inventoryId);
  console.log(`✅ OS ${D.os} [D] cotización — revisa: folio OS${D.os}-01, total $2,500 en grande, anticipo $500/restante $2,000`);

  // E — aprobada con faltante (pedido pendiente de crear/recibir)
  const E = await baseOs("E", { asesor: ASESORES[1] });
  await addQuote(E.entryId, inventoryId);
  await approve(E.entryId);
  console.log(`✅ OS ${E.os} [E] aprobada — revisa: botón Abastecimiento ámbar, inventario comprometido`);

  // F — en REPARACIÓN (con pedido recibido directo al auto)
  const F = await baseOs("F");
  await addQuote(F.entryId, inventoryId);
  await approve(F.entryId);
  const po = await post("/purchase-orders", {
    idWorkshop: ID_WORKSHOP,
    entryId: F.entryId,
    items: [{ description: "Balatas (faltante)", qty: 2, unitCost: 500, inventoryId }],
  });
  await post(`/purchase-orders/${idOf(po)}/receive`, { items: [{ index: 0, received: 2 }] });
  await put(`/entries/${F.entryId}`, { statusService: "EN REPARACION" });
  console.log(`✅ OS ${F.os} [F] en reparación — revisa: Servicios/Producción, stock consumido`);

  // G — ENTREGADA
  const G = await baseOs("G");
  await addQuote(G.entryId, inventoryId);
  await approve(G.entryId);
  await put(`/entries/${G.entryId}`, { statusService: "EN REPARACION" });
  await put(`/entries/${G.entryId}`, { statusService: "ENTREGADO" });
  console.log(`✅ OS ${G.os} [G] entregada — revisa: Vehículos Entregados, botón Servicio azul del cliente (Q18), expediente accesible (Q11: hoy se pierde — CORE pendiente)`);

  console.log(`
🎉 RECORRIDO LISTO. Ruta sugerida de revisión:
   1. /registro (Activos): A y B — semáforo de botones Q26.
   2. /registro (Aprobados): E — botón Abastecimiento.
   3. Cotizaciones de D: folio, total, anticipo (#30/Q4/Q7).
   4. /abastecimiento: pedido de F recibido; crea uno con 2h para ver alertas (#49).
   5. /servicios: F con filtro por OS (#33).
   6. /servicios-entregados: G — ¿qué le falta a la UI ahí? (tu CORE propuesto c/d)
   7. /clientes: cliente de G con botón Servicio azul (Q18).
   8. Dashboard: anticipos de D/E/F en "Ingreso parcial" (Q7).
`);
}

main().catch((e) => {
  console.error("\n❌ Error:", e.message);
  process.exit(1);
});
