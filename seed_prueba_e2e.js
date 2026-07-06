/**
 * Semilla de datos para prueba de punta a punta (CCC).
 * Crea: cliente + carro + inventario (con stock controlado) + entrada (OS) +
 * hoja de servicio + diagnóstico (3 hallazgos rojo/amarillo/verde).
 * Después TÚ pruebas en la app: Costeo → Cotización → Aprobar → Abastecimiento
 * → Recepción → mandar a Reparación (consume stock).
 *
 * CÓMO USAR:
 *   1) Ten el backend corriendo en http://localhost:3001 (API V1 abierta, sin token).
 *   2) Pon tu ID_WORKSHOP abajo (o pásalo por variable de entorno).
 *   3) node seed_prueba_e2e.js
 *
 * Requiere Node 18+ (usa fetch global). No instala nada.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURACIÓN — edita al menos ID_WORKSHOP
// ─────────────────────────────────────────────────────────────────────────────
const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba"; // mismo que seed_emulator_user.js
const CLIENT_ID = process.env.CLIENT_ID || ""; // vacío = crea un cliente nuevo
const MECHANIC_ID = process.env.MECHANIC_ID || "mecanico-prueba"; // id de usuario mecánico (opcional)
const CREATED_BY = process.env.CREATED_BY || MECHANIC_ID;
const SEED_INVENTORY = process.env.SEED_INVENTORY !== "false"; // crea inventario de prueba
// ─────────────────────────────────────────────────────────────────────────────

const suffix = String(Date.now()).slice(-5); // evita choques de VIN/placas al re-ejecutar

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* sin cuerpo */
  }
  if (!res.ok) {
    const detail = json ? JSON.stringify(json.errors ?? json.messages ?? json.descripcion ?? json) : res.statusText;
    throw new Error(`POST ${path} → ${res.status}: ${detail}`);
  }
  return json?.data ?? json;
}

const idOf = (d) => d?.id ?? d?.entryId ?? d?.serviceSheetId ?? d?.diagnosticId ?? d?._id ?? d;

async function main() {
  if (!ID_WORKSHOP) {
    console.error("❌ Falta ID_WORKSHOP.");
    process.exit(1);
  }
  console.log(`🌱 Sembrando en ${API} · taller ${ID_WORKSHOP}\n`);

  // 1) Cliente (o usar existente)
  let clientId = CLIENT_ID;
  if (!clientId) {
    const client = await post("/clients", {
      fullName: `Cliente Prueba E2E ${suffix}`,
      email: `prueba.e2e.${suffix}@test.com`,
      phone: `55${suffix}0000`, // único por corrida (evita choque por duplicado)
      idWorkshop: ID_WORKSHOP,
      createdBy: CREATED_BY,
    });
    clientId = idOf(client);
    console.log(`✅ Cliente creado: ${clientId}`);
  } else {
    console.log(`↪️  Usando cliente existente: ${clientId}`);
  }

  // 1b) Vínculo cliente↔taller en la colección `tokens`. IMPORTANTE: la lista de
  //     Clientes se arma por `tokens` (idWorkshop → idClient), NO por
  //     clients.idWorkshop. Sin este token, el cliente NO aparece en Clientes.
  await post("/tokens", { idWorkshop: ID_WORKSHOP, idClient: clientId });
  console.log("✅ Vínculo cliente↔taller (tokens) creado → ya aparece en Clientes");

  // 2) Carro (Nissan Versa de prueba)
  const car = await post("/cars", {
    clientId,
    brand: "Nissan",
    model: "Versa",
    year: 2018,
    vin: `TESTVIN${suffix}0000000`.slice(0, 17),
    codeCar: `PRB-${suffix}`,
    color: "Gris",
    fuel: "Gasolina",
    transmition: "Automática",
    km: 98500,
  });
  const carId = idOf(car);
  console.log(`✅ Carro creado: ${carId} (placas PRB-${suffix})`);

  // 3) Inventario con stock controlado (para probar comprometido/disponible/faltante)
  if (SEED_INVENTORY) {
    const items = [
      { name: "Balatas delanteras", sku: `BAL-${suffix}`, category: "Frenos", brand: "OEM", unit: "juego", cost: 500, price: 850, stock: 1, minStock: 1 },
      { name: "Aceite ATF", sku: `ATF-${suffix}`, category: "Transmisión", brand: "OEM", unit: "litro", cost: 120, price: 180, stock: 10, minStock: 2 },
      { name: "Filtro de aire", sku: `FIL-${suffix}`, category: "Motor", brand: "OEM", unit: "pieza", cost: 150, price: 220, stock: 0, minStock: 1 },
    ];
    for (const it of items) {
      const inv = await post("/inventory", { idWorkshop: ID_WORKSHOP, ...it });
      console.log(`   📦 Inventario: ${it.name} (stock ${it.stock}) → ${idOf(inv)}`);
    }
    console.log("   ↳ Sugerencia de prueba: en Costeo pide 2 Balatas (stock 1 → falta 1), 4 ATF (stock 10 → alcanza), 1 Filtro (stock 0 → falta 1).");
  }

  // 4) Entrada (OS)
  const entry = await post("/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId,
    carId,
    assigned_mechanic: MECHANIC_ID,
    status: 1,
    observations: "Rechina al frenar y patina al acelerar; motor ahogado.",
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  });
  const entryId = idOf(entry);
  const os = entry?.sheet ?? "(desconocido)";
  console.log(`✅ Entrada creada: OS ${os} · entryId ${entryId}`);

  // 5) Hoja de servicio
  await post(`/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos", "Llave", "Tapetes", "Cinturones", "Vestiduras", "Pedales", "Gato", "Llave de ruedas", "Llanta refaccion", "Tapas ruedas", "Triangulos"],
    checks: ["Servicio de Frenos", "Transmisión", "Ruido al Frenar", "Jalonea/Falla", "Pierde Potencia", "Check Engine"],
    isCheckAll: false,
    observations: "Carrocería con ligeros golpes en defensa trasera. Interior en buen estado.",
    km: 98500,
    fuel_tank: "1/2",
  });
  console.log("✅ Hoja de servicio creada");

  // 6) Diagnóstico con 3 hallazgos (semáforo)
  const diag = await post(`/entries/${entryId}/diagnostics`, {
    idMechanic: MECHANIC_ID,
    generalObservations: "Revisión de frenos y transmisión por ruido y patinaje.",
    findings: [
      { id: "f-rojo", system: "Frenos", component: "Balatas delanteras", finding: "Balatas al límite, contacto metal-metal.", severity: "ROJO", recommendation: "Reemplazo inmediato + revisar discos.", commercialDescription: "Sus frenos están al límite, es riesgoso frenar.", consequence: "Riesgo de no frenar a tiempo." },
      { id: "f-amarillo", system: "Transmisión", component: "Aceite ATF", finding: "Aceite quemado, patinaje en cambios.", severity: "AMARILLO", recommendation: "Servicio de transmisión (cambio de ATF).", commercialDescription: "La transmisión patina; conviene servicio pronto.", consequence: "Daño mayor a la transmisión." },
      { id: "f-verde", system: "Motor", component: "Filtro de aire", finding: "Filtro con polvo ligero.", severity: "VERDE", recommendation: "Cambiar en el próximo servicio.", commercialDescription: "Filtro de aire con desgaste leve.", consequence: "Menor eficiencia si no se atiende." },
    ],
  });
  const diagnosticId = idOf(diag);
  console.log(`✅ Diagnóstico creado: ${diagnosticId}\n`);

  console.log("🎉 LISTO. Ahora prueba en la app:");
  console.log(`   • OS ${os} — vehículo Nissan Versa (placas PRB-${suffix})`);
  console.log(`   • Ve a la entrada → Diagnóstico → botón "Costeo".`);
  console.log(`   • Enlace directo al Costeo: /costeo/${entryId}?diagnosticId=${diagnosticId}`);
  console.log("   • Flujo: Costeo (refacciones) → Cotización (precios) → Selección Oficial + Aprobar");
  console.log("     → botón Abastecimiento (aparece si hay faltante) → Recibir → mandar a Reparación (baja stock).");
}

main().catch((e) => {
  console.error("\n❌ Error:", e.message);
  process.exit(1);
});
