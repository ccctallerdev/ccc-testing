const { test, expect } = require("@playwright/test");

/**
 * PÚBLICO — Olvidé mi contraseña vía correo propio (Brevo).
 *
 * Endpoint PÚBLICO POR DISEÑO: POST /v1/public/forgot-password. No requiere
 * sesión. El backend genera el enlace con el Admin SDK, REESCRIBE el oobCode
 * hacia /acciones-cuenta y manda el correo con Brevo. Aquí se prueba el
 * CONTRATO y la SEGURIDAD del endpoint, sin depender de que el correo llegue:
 *   - validación de esquema (422),
 *   - respuesta genérica exista o no la cuenta (no-oráculo),
 *   - rate limit por IP (429).
 *
 * El envío real (Brevo) y la pantalla /acciones-cuenta se cubren aparte:
 *   - lógica pura de reescritura del enlace + HTML → test unitario del backend
 *     (ccc-backend/functions/tests/forgot-password.unit.test.js).
 *
 * PRERREQUISITOS: backend en :3001 apuntando a los emuladores (como el resto de
 * @api). NO necesita BREVO_API_KEY: sin ella el envío falla adentro, se atrapa
 * y la respuesta genérica sale igual — justo lo que estas pruebas verifican.
 */

const API = process.env.API || "http://localhost:3001/v1";
const PATH = "/public/forgot-password";

// Un correo que SÍ existe en el Auth emulado (lo siembra global-setup).
const SEED_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";

/**
 * POST al endpoint con una IP simulada (x-forwarded-for) para aislar el rate
 * limit entre casos: el limitador cuenta por IP, así que cada test usa la suya.
 */
async function forgot(request, email, ip) {
  const res = await request.post(`${API}${PATH}`, {
    headers: ip ? { "x-forwarded-for": ip } : {},
    data: { email },
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), descripcion: json?.descripcion, json };
}

test.describe.serial("Público — forgot-password (Brevo)", () => {
  test("correo inválido → 422", { tag: ["@api", "@publico"] }, async ({ request }) => {
    const r = await forgot(request, "no-es-correo", "10.20.0.1");
    expect(r.status, "un correo mal formado no debe pasar la validación").toBe(422);
  });

  test("sin email → 422", { tag: ["@api", "@publico"] }, async ({ request }) => {
    const res = await request.post(`${API}${PATH}`, {
      headers: { "x-forwarded-for": "10.20.0.2" },
      data: {},
    });
    expect(res.status()).toBe(422);
  });

  test("correo inexistente → 200 y NO revela que no existe (no-oráculo)", { tag: ["@api", "@publico"] }, async ({ request }) => {
    const r = await forgot(request, `noexiste_${Date.now()}@ccc.test`, "10.20.0.3");
    expect(r.status, "un correo inexistente debe responder 200 genérico").toBe(200);
    expect(
      r.descripcion || "",
      "la respuesta NO debe delatar si la cuenta existe",
    ).not.toMatch(/no existe|not found|inexistente/i);
  });

  test("correo existente → 200 con la MISMA respuesta que el inexistente (no-oráculo)", { tag: ["@api", "@publico"] }, async ({ request }) => {
    // Mismo texto exista o no la cuenta: el endpoint no es un oráculo para
    // averiguar qué correos están registrados.
    const existe = await forgot(request, SEED_EMAIL, "10.20.0.4");
    const noExiste = await forgot(request, `noexiste_${Date.now()}@ccc.test`, "10.20.0.5");
    expect(existe.status, "la cuenta sembrada debe responder 200").toBe(200);
    expect(
      existe.descripcion,
      "existente e inexistente deben devolver EXACTAMENTE la misma descripción",
    ).toBe(noExiste.descripcion);
  });

  test("rate limit por IP → 429 tras varios intentos rápidos", { tag: ["@api", "@publico"] }, async ({ request }) => {
    // El límite es 5 por IP cada 15 min → el 6.º desde la misma IP debe cortar.
    const ip = "203.0.113.55";
    let ultimo = 0;
    let corto = false;
    for (let i = 1; i <= 7; i++) {
      const r = await forgot(request, `flood${i}@ccc.test`, ip);
      ultimo = r.status;
      if (r.status === 429) { corto = true; break; }
    }
    expect(corto, `se esperaba un 429 por rate limit (último status=${ultimo})`).toBe(true);
  });
});
