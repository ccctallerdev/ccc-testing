const { test, expect } = require("@playwright/test");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-35 — POST /v1/billing/change-plan · SUBIR de plan con suscripción vigente @api
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El hueco (backlog punto 35): el flujo de contratación solo sabe crear
 * suscripciones NUEVAS — `createCheckoutSession` rechaza con
 * SUBSCRIPTION_EXISTS si el taller ya tiene una vigente, y el portal de
 * Stripe solo deja cancelar. "Subir de plan" era un callejón sin salida.
 *
 * El endpoint nuevo (primera versión: SOLO SUBIR, decidido 17-sep):
 *   POST /v1/billing/change-plan { idWorkshop, planKey }
 *   - valida el plan destino contra el catálogo (mismo regex del checkout);
 *   - exige suscripción viva EN LA PASARELA (externalSubscriptionId);
 *   - rechaza mismo plan (SAME_PLAN) y bajar (DOWNGRADE_NOT_SUPPORTED) — la
 *     escalera es max_orders (30 < 70 < 150);
 *   - hace subscriptions.update con el precio nuevo Y la metadata nueva
 *     (planKey/max_orders): CLAVE, porque syncSubscription lee metadata — un
 *     cambio por portal cambiaría el precio pero dejaría el tope viejo;
 *   - prorrateo inmediato (create_prorations) y mismo ciclo de cobro.
 *
 * Escrito EN ROJO antes del arreglo: hoy el endpoint no existe (404).
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   Backend local corriendo (npm run serve / emulador de functions → :3001).
 *   $env:SEED_EMAIL="rsv_gpa@outlook.com"; $env:SEED_PASSWORD="admin123"
 *   npx playwright test --project=qa tests/qa/BL-35_cambio-plan.api.spec.js
 *
 *   Los casos que exigen una suscripción REAL en Stripe (modo test) van
 *   detrás de $env:BL35_E2E="1" + $env:ID_WORKSHOP="<taller con sub viva>":
 *   sin eso se saltan, porque una sub creada por bypass no tiene
 *   externalSubscriptionId y daría falsos rojos.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const { authHeaders } = require("#apiToken");

const API = process.env.API || "http://localhost:3001/v1";
const E2E = process.env.BL35_E2E === "1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || null;

async function changePlan(request, body) {
  const res = await request.post(`${API}/billing/change-plan`, {
    headers: await authHeaders(),
    data: body,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), json };
}

test.describe("BL-35 — cambio de plan @api", () => {
  test("planKey inválido → 422 de validación (el endpoint EXISTE y valida)", async ({ request }) => {
    const r = await changePlan(request, { idWorkshop: "taller-cualquiera", planKey: "NO VÁLIDO!!" });
    // En rojo esto es 404 (la ruta no existe): ese es el bug.
    expect(r.status, "la ruta debe existir y validar el plan con Zod").toBe(422);
  });

  test("taller sin suscripción en la pasarela → 409 NO_SUBSCRIPTION", async ({ request }) => {
    const r = await changePlan(request, {
      idWorkshop: `taller-fantasma-bl35-${Date.now()}`,
      planKey: "premium",
    });
    expect(r.status).toBe(409);
    expect(r.json && r.json.code, "la respuesta debe traer el code de negocio crudo").toBe("NO_SUBSCRIPTION");
  });

  test("mismo plan → 409 SAME_PLAN", async ({ request }) => {
    test.skip(!E2E || !ID_WORKSHOP, "Requiere BL35_E2E=1 e ID_WORKSHOP con suscripción real en Stripe test");
    // El taller E2E está en premium: pedir premium debe rebotar sin tocar Stripe.
    const r = await changePlan(request, { idWorkshop: ID_WORKSHOP, planKey: "premium" });
    expect(r.status).toBe(409);
    expect(r.json && r.json.code).toBe("SAME_PLAN");
  });

  test("bajar de plan → 409 DOWNGRADE_NOT_SUPPORTED", async ({ request }) => {
    test.skip(!E2E || !ID_WORKSHOP, "Requiere BL35_E2E=1 e ID_WORKSHOP con suscripción real en Stripe test");
    const r = await changePlan(request, { idWorkshop: ID_WORKSHOP, planKey: "basico" });
    expect(r.status).toBe(409);
    expect(r.json && r.json.code).toBe("DOWNGRADE_NOT_SUPPORTED");
  });

  test("subir de plan (premium → master) actualiza pasarela y Firestore", async ({ request }) => {
    test.skip(!E2E || !ID_WORKSHOP, "Requiere BL35_E2E=1 e ID_WORKSHOP con suscripción real en Stripe test");
    const r = await changePlan(request, { idWorkshop: ID_WORKSHOP, planKey: "master" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const data = r.json && r.json.data;
    expect(data.planKey).toBe("master");
    expect(Number(data.max_orders)).toBe(150);

    // El status refleja el plan nuevo de inmediato (syncSubscription corrió).
    const st = await request.get(`${API}/billing/status/${ID_WORKSHOP}`, { headers: await authHeaders() });
    const stJson = await st.json();
    expect(stJson.data.plan_name).toBe("master");
    expect(Number(stJson.data.max_orders)).toBe(150);
  });
});
