const { test, expect } = require("@playwright/test");
const { signIn, claimsOf, forget } = require("../../qaAuth");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OBS02 (bloqueantes de la app) — PRUEBAS DE API (nuevas, no recicladas)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Valida el lado servidor de la rama fix/obs02-bloqueantes-mobile /
 * fix/obs02-bloqueantes-api:
 *
 *   OBS02-11 · el endpoint del cliente entrega `unitPrice` (y `cost` espejo)
 *              y NUNCA `costProveedor` ni `utilidad`.
 *   OBS02-09 · el API sella el claim `clientId`, la OS trae `idWorkshop`
 *              (la app arma con él la ruta de la galería), y las reglas de
 *              Storage dejan LEER al cliente SOLO su propia evidencia,
 *              sin poder escribir.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *
 *   cd C:\Users\USER\Documents\TRABAJO\ccc-testing
 *   $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"        # el v1 de refac
 *   $env:SKIP_SEED="1"
 *   $env:CLIENTE_EMAIL="<correo de una cuenta CLIENTE de refac, verificada>"
 *   $env:CLIENTE_PASSWORD="<su contraseña>"
 *   npx playwright test --project=qa tests/qa/OBS02-BLOQ_app-cliente.api.spec.js
 *
 * Opcionales:
 *   $env:ENTRY_ID="<OS concreta a revisar>"   # default: la primera del primer auto
 *   $env:STORAGE_BUCKET="ccc-taller-refac.appspot.com"
 *
 * ⚠️ SIN EMULADORES, terminal limpia (igual que FEAT-TRIAL21): corre contra
 *    refac. NO corre contra producción.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "https://v1-hirpfgw7sa-uc.a.run.app/v1";
// El bucket real de refac es .firebasestorage.app (proyecto reciente), no
// .appspot.com — con el nombre equivocado Storage responde 404, no 403.
const BUCKET = process.env.STORAGE_BUCKET || "ccc-taller-refac.firebasestorage.app";
const EMAIL = process.env.CLIENTE_EMAIL || "";
const PASSWORD = process.env.CLIENTE_PASSWORD || "";

const FALTA_CUENTA =
  !EMAIL || !PASSWORD
    ? "Define CLIENTE_EMAIL y CLIENTE_PASSWORD (cuenta CLIENTE de refac con correo verificado y al menos un auto con OS)."
    : null;

/** Campos que JAMÁS deben llegar al cliente final, en ningún nivel del JSON. */
const PROHIBIDOS = ["costProveedor", "utilidad", "unitCost", "costo_proveedor", "costoProveedor", "margin", "margen"];

function clavesProhibidasEn(obj, ruta = "$") {
  const halladas = [];
  const walk = (node, r) => {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${r}[${i}]`));
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (PROHIBIDOS.includes(k)) halladas.push(`${r}.${k}`);
        walk(v, `${r}.${k}`);
      }
    }
  };
  walk(obj, ruta);
  return halladas;
}

async function apiGet(pathRel, token) {
  const res = await fetch(`${API}${pathRel}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let body = null;
  try { body = await res.json(); } catch { /* respuesta no-JSON */ }
  return { status: res.status, body };
}

/** Lista un prefijo del bucket con el idToken del usuario (API REST de Storage). */
async function listarStorage(prefix, idToken) {
  const url =
    `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o` +
    `?prefix=${encodeURIComponent(prefix.replace(/\/+$/, "") + "/")}&delimiter=/`;
  const res = await fetch(url, { headers: { Authorization: `Firebase ${idToken}` } });
  let body = null;
  try { body = await res.json(); } catch { /* — */ }
  return { status: res.status, body };
}

test.describe("OBS02 · API del cliente y galería", () => {
  test.skip(() => !!FALTA_CUENTA, FALTA_CUENTA || "");

  let token = null;       // idToken YA con el claim clientId sellado
  let claims = null;
  let entry = null;       // la OS bajo prueba (objeto completo del API)

  test.beforeAll(async () => {
    // 1) Login y primera llamada a /app: sella el claim clientId en el server.
    const token0 = await signIn(EMAIL, PASSWORD);
    const primera = await apiGet("/app/cars", token0);
    expect(primera.status, "GET /app/cars con cuenta CLIENTE debe responder 200").toBe(200);

    // 2) Token FRESCO: el claim recién sellado solo viene en un idToken nuevo.
    forget(EMAIL);
    token = await signIn(EMAIL, PASSWORD);
    claims = claimsOf(token);

    // 3) Resolver la OS bajo prueba.
    const envEntry = process.env.ENTRY_ID || "";
    if (envEntry) {
      const r = await apiGet(`/app/entries/${envEntry}`, token);
      expect(r.status, `GET /app/entries/${envEntry}`).toBe(200);
      entry = r.body?.data;
    } else {
      const cars = primera.body?.data?.cars || primera.body?.data || [];
      expect(Array.isArray(cars) && cars.length > 0, "la cuenta debe tener al menos un auto").toBe(true);
      for (const car of cars) {
        const r = await apiGet(`/app/entries?carId=${encodeURIComponent(car.id)}`, token);
        const entries = r.body?.data?.entries || [];
        if (entries.length) { entry = entries[0]; break; }
      }
      expect(entry, "ningún auto de la cuenta tiene OS; siembra una o pasa ENTRY_ID").toBeTruthy();
    }
  });

  test("1) el API sella el claim clientId (lo usan las reglas de Storage)", async () => {
    expect(String(claims?.clientId || ""), "claims.clientId vacío: requireClient no selló el claim").not.toBe("");
  });

  test("2) la OS del cliente trae idWorkshop (la galería arma la ruta con él)", async () => {
    expect(String(entry?.idWorkshop || ""), "entry.idWorkshop no llegó — ¿lo censura el sanitizador?").not.toBe("");
  });

  test("3) OBS02-11 · las cotizaciones traen unitPrice y JAMÁS costo de proveedor", async () => {
    const r = await apiGet(`/app/entries/${entry.id}/quotes`, token);
    expect(r.status).toBe(200);
    const quotes = r.body?.data?.quotes || [];

    // La censura aplica SIEMPRE, haya o no cotizaciones.
    const fugas = clavesProhibidasEn(r.body);
    expect(fugas, `campos sensibles fugados al cliente: ${fugas.join(", ")}`).toEqual([]);

    // El invariante de OBS02-11: si una partida tiene IMPORTE, el cliente debe
    // poder ver su precio unitario — por `unitPrice`, por `cost` (espejo viejo,
    // a veces string) o derivable como subtotal ÷ cantidad. Una línea con
    // subtotal 0 (p. ej. un hallazgo del costeo sin precio) queda exenta:
    // mostrar $0.00 ahí es fiel al dato.
    const partidas = quotes.flatMap((q) => [...(q.parts || []), ...(q.labor || [])]);
    let conImporte = 0;
    for (const it of partidas) {
      const importe = Number(it.subtotal || 0);
      if (importe <= 0) continue;
      conImporte++;
      const unitario =
        Number(it.unitPrice || 0) || Number(it.cost || 0) ||
        (Number(it.count || 0) > 0 ? importe / Number(it.count) : 0);
      expect(unitario, `partida "${it.description || "?"}" con importe ${importe} pero sin unitario visible`).toBeGreaterThan(0);
    }
    console.log(`   partidas revisadas: ${partidas.length}, con importe: ${conImporte}`);
  });

  test("4) OBS02-09 · el cliente LEE su propia evidencia en Storage", async () => {
    const propia = `${entry.idWorkshop}/${claims.clientId}/${entry.id}/service`;
    const r = await listarStorage(propia, token);
    expect(r.status, `list de ${propia} debe permitirse (aunque venga vacío)`).toBe(200);
  });

  test("5) OBS02-09 · el cliente NO lee evidencia de otro cliente", async () => {
    const ajena = `${entry.idWorkshop}/otro-cliente-xyz/${entry.id}/service`;
    const r = await listarStorage(ajena, token);
    expect([401, 403], `list de ${ajena} debió denegarse y respondió ${r.status}`).toContain(r.status);
  });

  test("6) OBS02-09 · el cliente NO puede ESCRIBIR evidencia (solo lectura)", async () => {
    const destino = `${entry.idWorkshop}/${claims.clientId}/${entry.id}/service/intruso.txt`;
    const res = await fetch(
      `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o?name=${encodeURIComponent(destino)}`,
      {
        method: "POST",
        headers: { Authorization: `Firebase ${token}`, "Content-Type": "text/plain" },
        body: "no debería subir",
      },
    );
    expect([401, 403], `la subida debió denegarse y respondió ${res.status}`).toContain(res.status);
  });

  test("8) el costeo (borrador interno) NO se lista ni se sirve al cliente", async () => {
    // Lista: ninguna "cotización" visible puede ser stage COSTEO.
    const r = await apiGet(`/app/entries/${entry.id}/quotes`, token);
    expect(r.status).toBe(200);
    const etapas = (r.body?.data?.quotes || []).map((q) => q.stage);
    expect(etapas.filter((e) => e === "COSTEO"), `stages visibles: ${etapas.join(", ") || "(vacío)"}`).toEqual([]);

    // Detalle: un costeo por id responde 404, como si no existiera. El id se
    // puede pasar por env; por omisión usa el costeo del taller demo de refac.
    const costeoEntry = process.env.COSTEO_ENTRY_ID || "eqQZlOzXYGpBz1T22azt";
    const costeoQuote = process.env.COSTEO_QUOTE_ID || "9pg5XmtxzuKHPgqJ6gKb";
    const rd = await apiGet(`/app/entries/${costeoEntry}/quotes/${costeoQuote}`, token);
    expect([403, 404], `el costeo respondió ${rd.status} — debió ser invisible`).toContain(rd.status);
  });

  test("7) ownership · una OS ajena responde 403/404, no datos", async () => {
    const r = await apiGet(`/app/entries/OS-inexistente-de-otro`, token);
    expect([403, 404, 400], `respondió ${r.status}`).toContain(r.status);
    expect(clavesProhibidasEn(r.body)).toEqual([]);
  });
});
