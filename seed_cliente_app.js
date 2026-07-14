/**
 * SEED — Cliente "de web" listo para probar la VINCULACIÓN de la app (Q32):
 *   cliente global + afiliación al taller (token) + auto + OS aprobada con
 *   diagnóstico, en etapa EN REPARACION (para que el home de la app tenga
 *   algo que contar).
 *
 * Flujo de prueba en la app:
 *   1. `node seed_cliente_app.js`  (emuladores + backend corriendo)
 *   2. En la app: Registrarse con el MISMO email que imprime esta seed.
 *   3. Verificar el correo (link en la terminal de emuladores o UI :4000).
 *   4. Login → el backend liga cuenta↔cliente → "Elige tu taller" muestra
 *      el taller de prueba → home con su auto y su OS.
 *
 * Email configurable: `node seed_cliente_app.js correo@test.com`
 */

const { authHeaders } = require("./apiToken");

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";
const MECHANIC = "mecanico-prueba";

const EMAIL = process.argv[2] || "cliente.app@ccc.test";

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(await authHeaders()) }, // Q20: API blindada
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json?.data ?? json;
}
const post = (p, b) => call("POST", p, b);
const put = (p, b) => call("PUT", p, b);
const get = (p) => call("GET", p);
const idOf = (d) => d?.id ?? d?.entryId ?? d?._id ?? d;

(async () => {
  const s = String(Date.now()).slice(-6);

  // ¿Ya existe el cliente? (seed re-ejecutable)
  const found = await get(
    `/clients/lookup?email=${encodeURIComponent(EMAIL)}&idWorkshop=${ID_WORKSHOP}`,
  );
  let clientId = found?.exists ? found.clientId : null;
  let token = null;

  if (!clientId) {
    const client = await post("/clients", {
      fullName: "Clienta App Prueba",
      email: EMAIL,
      phone: `81${s}55`,
      createdBy: "seed",
    });
    clientId = idOf(client);
    console.log(`✔ Cliente creado: ${clientId}`);
  } else {
    console.log(`✔ Cliente ya existía: ${clientId}`);
  }

  if (!found?.affiliated) {
    const tok = await post("/tokens", { idClient: clientId, idWorkshop: ID_WORKSHOP });
    token = tok?.token ?? tok?.data?.token ?? null;
    console.log(`✔ Afiliado al taller (${ID_WORKSHOP}). Token: ${token}`);
  } else {
    console.log("✔ Ya estaba afiliado al taller");
  }

  // Auto + OS aprobada con diagnóstico, en reparación.
  const car = await post("/cars", {
    clientId,
    brand: "Mazda",
    model: "3",
    year: 2023,
    vin: `APPSEED${s}0000000`.slice(0, 17),
    codeCar: `AP${s.slice(-4)}`,
    color: "Azul",
    fuel: "Gasolina",
    transmition: "Automática",
    km: 18000,
  });
  const carId = idOf(car);

  const entry = await post("/entries", {
    idWorkshop: ID_WORKSHOP,
    clientId,
    carId,
    assigned_mechanic: MECHANIC,
    status: 1,
    observations: "Ruido al frenar; cliente de la app.",
    registerDate: Date.now(),
    approvalState: "EN ESPERA",
  });
  const entryId = idOf(entry);

  await post(`/entries/${entryId}/service-sheet`, {
    car_items: ["Documentos", "Llave"],
    checks: ["Servicio de Frenos"],
    isCheckAll: false,
    observations: "Recepción de la seed app.",
    km: 18000,
    fuel_tank: "3/4",
  });
  await post(`/entries/${entryId}/quotes`, {
    diagnostic: "Cambio de balatas delanteras y rectificado de discos.",
    labor: [{ description: "Mano de obra frenos", count: 1, cost: 1200, subtotal: 1200 }],
    parts: [{ description: "Balatas delanteras", count: 1, cost: 850, subtotal: 850 }],
    status: 2,
    stage: "COTIZACION",
    advance: 500,
  });
  const quotes = (await get(`/entries/${entryId}/quotes?limit=10`))?.quotes ?? [];
  const sheets = (await get(`/entries/${entryId}/service-sheet?limit=10`))?.serviceSheets ?? [];
  await put(`/entries/${entryId}/approve-selection`, {
    approvedQuoteId: idOf(quotes[0]),
    approvedServiceSheetId: idOf(sheets[0]),
  });
  await put(`/entries/${entryId}`, { approvalState: "APROBADA" });
  await post(`/entries/${entryId}/diagnostics`, {
    generalObservations: "Diagnóstico para la clienta de la app.",
    findings: [
      { system: "Frenos", component: "Balatas", finding: "Desgaste severo", severity: "ROJO", recommendation: "Cambio inmediato" },
      { system: "Suspensión", finding: "Amortiguadores al 60%", severity: "AMARILLO", recommendation: "Revisar en 60 días" },
    ],
  });
  await post(`/entries/${entryId}/production/start`); // Q5 → EN REPARACION

  console.log("");
  console.log("🌱 Seed lista. Para probar la vinculación en la app:");
  console.log(`   1. Regístrate en la app con: ${EMAIL} (contraseña tuya)`);
  console.log("   2. Verifica el correo (link en la terminal de emuladores / UI :4000)");
  console.log("   3. Login → debe aparecer tu taller y el Mazda 3 en reparación");
  console.log(`   OS: ${entry?.sheet} · Cliente: ${clientId}${token ? ` · Token: ${token}` : ""}`);
})().catch((e) => {
  console.error("Seed falló:", e.message);
  process.exit(1);
});
