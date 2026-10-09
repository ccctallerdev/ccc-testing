const { test, expect, request: pwRequest } = require("@playwright/test");
const { auth: qaAuth } = require("../../adminFlex");
const { headersFor } = require("../../qaAuth");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-31 — El backend valida la `key` de un plan al crearlo @api
 * (rama fix/bl31-validar-key-plan-api) — escrito NUEVO, en ROJO antes del fix
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   Hueco: POST /v1/plans aceptaba CUALQUIER texto como `key`; el patrón
 *   ^[a-z0-9-]{2,40}$ vivía solo en el editor del front (PlanEditorCard.jsx).
 *   Un curl de TECH_SUPPORT podía acuñar "Plan_Flotillas" y el catálogo nunca
 *   lo encontraba (familia BL-26).
 *
 *   Los POST de prueba NO mandan precios: así el router no toca Stripe (solo
 *   sincroniza cuando vienen monthly/annual/trialDays…) y no deja nada en la
 *   pasarela. Lo que se llegue a crear se borra en afterAll.
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   Back LOCAL con la rama (ccc-backend/functions → npm run dev):
 *   $env:API="http://localhost:3001/v1"
 *   npx playwright test --project=qa tests/qa/BL-31_key-plan.api.spec.js
 *   Requiere serviceAccountKey de refac (adminFlex) para crear el TECH_SUPPORT efímero.
 *
 * ── ROJO ESPERADO sin el fix ──────────────────────────────────────────────
 *   Caso 2: las claves torcidas responden 201 y el plan queda creado.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const S = String(Date.now()).slice(-6);
const TECH_EMAIL = `tech.bl31.${S}@ccc.test`;
const TECH_PASSWORD = "Prueba1234!";

const TORCIDAS = [`Plan_BL31_${S}`, `plan bl31 ${S}`, `PLAN-BL31-${S}`, "x"];
const VALIDA = `bl31-prueba-${S}`;

let techHeaders = null;
let uidTech = null;
const creadas = new Set();

const api = async (ctx, method, path, opts = {}) => {
  const res = await ctx[method](`${API}${path}`, opts);
  return { status: res.status(), body: await res.json().catch(() => null) };
};

test.describe.configure({ mode: "serial" });

test.describe("BL-31 — la key del plan se valida en el API @api", () => {
  test.beforeAll(async () => {
    const user = await qaAuth().createUser({ email: TECH_EMAIL, password: TECH_PASSWORD });
    await qaAuth().setCustomUserClaims(user.uid, { role: "TECH_SUPPORT" });
    uidTech = user.uid;
    techHeaders = await headersFor(TECH_EMAIL, TECH_PASSWORD);
  });

  test.afterAll(async () => {
    const ctx = await pwRequest.newContext();
    for (const key of creadas) {
      await api(ctx, "delete", `/plans/${encodeURIComponent(key)}`, { headers: techHeaders }).catch(() => {});
    }
    await ctx.dispose();
    if (uidTech) await qaAuth().deleteUser(uidTech).catch(() => {});
  });

  test("1 · POST /plans sin sesión → 401/403 (no cambia)", async ({ request }) => {
    const r = await api(request, "post", "/plans", { data: { key: VALIDA, name: "BL-31" } });
    expect([401, 403]).toContain(r.status);
  });

  test("2 · claves torcidas → 422 y el plan NO queda creado", async ({ request }) => {
    for (const key of TORCIDAS) {
      const r = await api(request, "post", "/plans", {
        headers: techHeaders,
        data: { key, name: "BL-31 torcida", isActive: false },
      });
      if (r.status === 201) creadas.add(key); // ROJO: limpiar lo que se coló
      expect(r.status, `${JSON.stringify(key)} → ${JSON.stringify(r.body)}`).toBe(422);
      expect(JSON.stringify(r.body), "el error debe explicar el formato").toMatch(/min[uú]sculas/i);

      const g = await api(request, "get", `/plans/${encodeURIComponent(key)}`);
      expect(g.status, `${JSON.stringify(key)} no debe existir`).toBe(404);
    }
  });

  test("3 · clave válida → 201 como siempre (y se borra al final)", async ({ request }) => {
    const r = await api(request, "post", "/plans", {
      headers: techHeaders,
      data: { key: VALIDA, name: "BL-31 válida", isActive: false },
    });
    if (r.status === 201) creadas.add(VALIDA);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const g = await api(request, "get", `/plans/${VALIDA}`);
    expect(g.status).toBe(200);
    expect(g.body?.data?.key).toBe(VALIDA);
  });

  test("4 · PUT a un plan existente sigue funcionando (el patrón solo se exige al crear)", async ({ request }) => {
    test.skip(!creadas.has(VALIDA), "El caso 3 no creó el plan");
    const r = await api(request, "put", `/plans/${VALIDA}`, {
      headers: techHeaders,
      data: { name: "BL-31 editada" },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body?.data?.name).toBe("BL-31 editada");
  });
});
