const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OBS21-10 — Contrato de /billing/status del que dependen los textos @api
 * (rama fix/obs21-10-textos-prueba-front) — escrito NUEVO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   El arreglo es solo de front: todos los textos de la prueba salen ahora de
 *   `modules/billing/domain/textosPrueba.js`, que calcula días y fechas con
 *   cinco campos de /billing/status. Si el backend deja de mandar alguno, la
 *   pantalla volvería a contar una historia inventada (p. ej. caer al "7" por
 *   default). Este spec fija ese contrato contra el backend real.
 *
 *   Campos: trialType · nextStep · cardTrialDays · trialDaysLeft · trialEndsAt
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   Backend local (ccc-backend/functions → npm run dev) o el de QA:
 *   $env:API="http://localhost:3001/v1"   (o la URL de QA)
 *   $env:SEED_EMAIL="rsv_gpa@outlook.com"; $env:SEED_PASSWORD="admin123"
 *   npx playwright test --project=qa tests/qa/OBS21-10_contrato-billing-status.api.spec.js
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "";
const DAY = 24 * 60 * 60 * 1000;

async function llamar(request, path) {
  const res = await request.get(`${API}${path}`, { headers: { ...(await authHeaders()) } });
  let json = null;
  try { json = await res.json(); } catch (_) { /* cuerpo vacío */ }
  return { status: res.status(), json };
}

/**
 * Taller de la sesión. No hay GET /users/me para la web: se saca el uid del
 * token (claim user_id) y se lee GET /users/:uid. ID_WORKSHOP sigue sirviendo
 * de atajo. (Antes se pedía /users/me y solo funcionaba con ID_WORKSHOP puesto.)
 */
async function tallerDeLaSesion(request) {
  if (process.env.ID_WORKSHOP) return process.env.ID_WORKSHOP;
  const { Authorization } = await authHeaders();
  const token = String(Authorization || "").replace(/^Bearer\s+/, "");
  let uid = "";
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    uid = payload.user_id || payload.uid || payload.sub || "";
  } catch (_) { /* token ilegible */ }
  if (!uid) return "";
  const res = await request.get(`${API}/users/${encodeURIComponent(uid)}`, { headers: { Authorization } });
  const json = await res.json().catch(() => null);
  return json?.data?.idWorkshop ?? "";
}

test.describe.configure({ mode: "default" });

test.describe("OBS21-10 — contrato de /billing/status @api", () => {
  let estado;

  test.beforeAll(async ({ request }) => {
    const taller = await tallerDeLaSesion(request);
    if (!taller) return;
    const r = await llamar(request, `/billing/status/${encodeURIComponent(taller)}`);
    estado = r;
  });

  test("responde 200 con data", async () => {
    test.skip(!estado, "No se pudo resolver el taller de la sesión (pasa ID_WORKSHOP).");
    expect(estado.status, JSON.stringify(estado.json)).toBe(200);
    expect(estado.json?.data).toBeTruthy();
  });

  test("trae los cinco campos que usan los textos, con su tipo", async () => {
    test.skip(!estado?.json?.data, "Sin datos de /billing/status");
    const d = estado.json.data;
    expect(["cardless", "card", null]).toContain(d.trialType ?? null);
    expect(["register_card", "subscribe", "none"]).toContain(d.nextStep);
    expect(typeof d.cardTrialDays, "cardTrialDays debe venir SIEMPRE (el front ya no adivina)").toBe("number");
    expect(d.cardTrialDays).toBeGreaterThanOrEqual(0);
    expect("trialDaysLeft" in d, "trialDaysLeft debe venir (número o null)").toBe(true);
    expect("trialEndsAt" in d, "trialEndsAt debe venir (ISO o null)").toBe(true);
  });

  test("en prueba, trialDaysLeft cuadra con trialEndsAt (de ahí sale la fecha del primer cargo)", async () => {
    test.skip(!estado?.json?.data, "Sin datos de /billing/status");
    const d = estado.json.data;
    test.skip(d.trialDaysLeft == null, `El taller no está en prueba (status ${d.status}); nada que cuadrar.`);
    expect(typeof d.trialDaysLeft).toBe("number");
    const fin = Date.parse(d.trialEndsAt);
    expect(Number.isFinite(fin), `trialEndsAt inválido: ${d.trialEndsAt}`).toBe(true);
    const esperado = Math.max(0, Math.ceil((fin - Date.now()) / DAY));
    expect(Math.abs(d.trialDaysLeft - esperado)).toBeLessThanOrEqual(1);
  });

  test("sin tarjeta, nextStep es register_card (lo que activa la pantalla de sumar días)", async () => {
    test.skip(!estado?.json?.data, "Sin datos de /billing/status");
    const d = estado.json.data;
    test.skip(d.trialType !== "cardless", `El taller no está en la prueba sin tarjeta (trialType ${d.trialType}).`);
    expect(d.nextStep).toBe("register_card");
  });
});
