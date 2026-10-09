const { test, expect } = require("@playwright/test");
const { authHeaders } = require("#apiToken");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-27 — Lo que el front necesita de /billing/status para decir POR QUÉ @api
 * (rama fix/bl27-motivo-suscripcion-front) — escrito NUEVO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   El arreglo es de front, pero se apoya en tres cosas del API que, si
 *   cambian, vuelven a mezclar los motivos:
 *     - "no tiene suscripción" es un 404, y "sin sesión" NO es un 404 (401/403);
 *     - con datos, `hasAccess` es booleano;
 *     - la suscripción administrada trae `trialType` o `stripeStatus` (de ahí
 *       sale "cobro fallido", "cancelada", "pago incompleto").
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   $env:API="http://localhost:3001/v1"; $env:AUTH_REAL="1"
 *   $env:SEED_EMAIL="rsv_gpa@outlook.com"; $env:SEED_PASSWORD="<contraseña>"
 *   npx playwright test --project=qa tests/qa/BL-27_estado-suscripcion.api.spec.js
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "";

async function llamar(request, path, conSesion = true) {
  const res = await request.get(`${API}${path}`, conSesion ? { headers: await authHeaders() } : {});
  let json = null;
  try { json = await res.json(); } catch (_) { /* vacío */ }
  return { status: res.status(), json };
}

async function taller(request) {
  if (ID_WORKSHOP) return ID_WORKSHOP;
  const yo = await llamar(request, "/users/me");
  return yo.json?.data?.idWorkshop ?? yo.json?.data?.workshop?.id ?? "";
}

test.describe.configure({ mode: "default" });

test.describe("BL-27 — contrato de /billing/status @api", () => {
  test("sin sesión responde 401/403, NO 404 (no debe parecer 'sin suscripción')", async ({ request }) => {
    const id = (await taller(request)) || "taller-cualquiera";
    const r = await llamar(request, `/billing/status/${encodeURIComponent(id)}`, false);
    expect([401, 403], `llegó ${r.status}`).toContain(r.status);
  });

  test("con sesión: 200 con hasAccess booleano y marca de administración", async ({ request }) => {
    const id = await taller(request);
    test.skip(!id, "No se pudo resolver el taller de la sesión (pasa ID_WORKSHOP).");
    const r = await llamar(request, `/billing/status/${encodeURIComponent(id)}`);
    test.skip(r.status === 404, "Este taller no tiene suscripción: el 404 es justo el caso 'sin suscripción'.");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const d = r.json?.data;
    expect(typeof d?.hasAccess).toBe("boolean");
    expect(!!(d?.trialType || d?.stripeStatus), "debe traer trialType o stripeStatus").toBe(true);
  });
});
