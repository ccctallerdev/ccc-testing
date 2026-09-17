const { test, expect } = require("@playwright/test");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BL-34 — el medidor del límite de órdenes refresca al registrar una entrada @ui
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El bug (backlog punto 34): `OrdenesLimite` (banner del layout) consulta
 * /order-limits/usage solo al montarse y cuando un alta choca con el tope
 * (ORDER_LIMIT_EVENT). Un alta EXITOSA no le avisa → el X/Y queda viejo
 * hasta el F5. Puedes estar en 5/5 viendo 4/5.
 *
 * El fix tiene dos mitades y cada una tiene su prueba:
 *   · que el alta AVISE  → unit de jest en ccc-frontend
 *     (src/apis/entries.bl34.test.js): createEntry dispara "ccc:order-created"
 *     tras un alta exitosa, y NO lo dispara en el 403 del tope.
 *   · que el banner ESCUCHE → ESTE spec: se inyecta el consumo (4/5, luego
 *     5/5), se dispara el evento como lo hará createEntry, y el banner debe
 *     actualizarse SIN recargar. En rojo, nadie escucha y se queda en 4.
 *
 * Escrito EN ROJO antes del arreglo (regla del equipo).
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   ⚠️ Requiere front local Y backend local (.env.local apunta a :3001).
 *   $env:BASE_URL="http://localhost:3000"; $env:SKIP_SEED="1"
 *   $env:SEED_EMAIL="rsv_gpa@outlook.com"; $env:SEED_PASSWORD="admin123"
 *   npx playwright test --project=qa tests/qa/BL-34_contador-limite.ui.spec.js
 * ═══════════════════════════════════════════════════════════════════════════
 */

const DUENO = {
  correo: process.env.SEED_EMAIL || "rsv_gpa@outlook.com",
  password: process.env.SEED_PASSWORD || "admin123",
};

function usageBody(used) {
  const limit = 5;
  return JSON.stringify({
    status: 200,
    descripcion: "ok",
    data: {
      month: "2026-09",
      planKey: "premium",
      hasSubscription: true,
      subscriptionStatus: 2,
      enforcement: "on",
      baseCap: limit,
      override: limit,
      toleranceExtra: 0,
      debt: 0,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      percent: used / limit,
      warnAt: 0.8,
      warned: true, // sin warned el banner ni se pinta
      blocked: false,
      tolerance: { amount: 1, accepted: false, available: false },
    },
  });
}

test.describe("BL-34 — medidor del límite refresca al registrar @ui", () => {
  test("el banner pasa de 4/5 a 5/5 sin recargar cuando se crea una orden", async ({ page }) => {
    // OJO: nada de contar llamadas para decidir la respuesta — StrictMode
    // monta doble en dev y el banner consulta 2+ veces al arrancar. El mock
    // sirve un valor FIJO que el test cambia a 5 justo antes de disparar el
    // evento: solo una consulta NUEVA (la del listener del fix) puede ver el 5.
    let usadasActuales = 4;
    let consultas = 0; // instrumentación: cuántas veces preguntaron por usage
    const erroresPagina = [];
    page.on("pageerror", (e) => erroresPagina.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") erroresPagina.push(m.text());
    });
    await page.route(/\/order-limits\/usage/, (route) => {
      consultas += 1;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: usageBody(usadasActuales),
      });
    });

    await page.goto("/login");
    await page.locator("#email").fill(DUENO.correo);
    await page.locator("#password").fill(DUENO.password);
    await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });

    const banner = page.getByTestId("banner-limite-ordenes");
    await expect(banner).toContainText("Llevas 4 de 5", { timeout: 15000 });

    // A partir de aquí el backend "real" ya va en 5: solo lo verá quien
    // vuelva a preguntar.
    usadasActuales = 5;
    const consultasAntesDelEvento = consultas;

    // Lo que hará apis/entries.createEntry tras un alta exitosa (la mitad
    // "avisar" la cubre el unit de jest; aquí probamos la mitad "escuchar").
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("ccc:order-created"));
    });

    // Diagnóstico: ¿el listener siquiera volvió a preguntar?
    await page.waitForTimeout(1500);
    console.log(
      `[BL-34] consultas a usage — al montar: ${consultasAntesDelEvento}, ` +
        `tras el evento: ${consultas} (delta ${consultas - consultasAntesDelEvento})`,
    );
    if (erroresPagina.length) {
      console.log(`[BL-34] errores en la página:\n  - ${erroresPagina.join("\n  - ")}`);
    }
    expect(
      consultas,
      "el listener de ccc:order-created debe disparar una consulta NUEVA a /order-limits/usage",
    ).toBeGreaterThan(consultasAntesDelEvento);

    // Con el bug NADIE escucha ese evento: el banner se queda en 4 y esto
    // revienta. Con el fix, OrdenesLimite re-consulta y pinta 5 sin recargar.
    await expect(
      banner,
      "el medidor debe refrescarse solo al registrar una orden, sin F5",
    ).toContainText("Llevas 5 de 5");
  });
});
