const { test, expect } = require("@playwright/test");
const { db: qaDb, auth: qaAuth, modo } = require("../../adminFlex");

/**
 * ─────────────────────────────────────────────────────────────────────────
 * PRODUCCIÓN: un fallo NO se ve como "no tienes autos"  @ui
 *
 * Contraparte de UI del punto n16. Lo que se prueba aquí es justo lo que
 * hizo invisible el bug durante semanas:
 *
 *     } catch { setEntries([]); }
 *
 * Un 500 del API (o el FAILED_PRECONDITION del índice que faltaba) quedaba
 * IDÉNTICO a "no hay autos". El Mecánico veía una pantalla vacía y
 * correcta-a-la-vista, sin forma de saber que algo había reventado. Y el
 * `catch` era doblemente mudo: los helpers de `apis/` ya atrapaban el error
 * y devolvían `false`, así que el catch del hook ni siquiera corría.
 *
 * Cómo se prueba sin depender de que algo falle de verdad: se INTERCEPTA la
 * llamada a `/entries` con `page.route` y se le responde 500. Es
 * determinista y no necesita tocar Firestore ni los índices.
 *
 * Los dos casos importan, y el segundo es el que evita pasarse de frenada:
 *   1. Si la carga falla   → aviso de error, y NO el vacío de siempre.
 *   2. Si no hay autos     → el vacío de siempre, y NO el aviso de error.
 *
 * CÓMO CORRE:
 *   EMULADORES: emuladores + backend + frontend + `node seed_emulator_user.js`
 *     npx playwright test --project=qa tests/qa/produccion-mecanico-ui.qa.spec.js
 *   REFAC: $env:AUTH_REAL="1"; ID_WORKSHOP, BASE_URL del front a probar.
 * ─────────────────────────────────────────────────────────────────────────
 */

const ID_WORKSHOP = process.env.ID_WORKSHOP || (modo === "emulador" ? "taller-prueba" : null);
if (!ID_WORKSHOP) {
  throw new Error('Falta ID_WORKSHOP (taller real de refac). Ej: $env:ID_WORKSHOP="05Pf..."');
}

const S = String(Date.now()).slice(-6);
const MECANICO = { correo: `mecanico.produi.${S}@ccc.test`, password: "Prueba1234!" };
const creados = { uids: [] };

async function entrarComo(page, { correo, password }) {
  await page.goto("/login");
  await page.locator("#email").fill(correo);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /iniciar sesi[oó]n/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });
}

test.describe.configure({ mode: "serial" });

test.describe("Producción: fallo vs. vacío @ui", () => {
  test.beforeAll(async () => {
    const user = await qaAuth().createUser({ email: MECANICO.correo, password: MECANICO.password });
    await qaAuth().setCustomUserClaims(user.uid, { role: "MECANICO", idWorkshop: ID_WORKSHOP });
    creados.uids.push(user.uid);
    // La app WEB carga `userData` de `users/{uid}`: sin este documento el login
    // "funciona" y te regresa a /login sin decir nada.
    const ahora = Date.now();
    await qaDb().collection("users").doc(user.uid).set({
      uid: user.uid, name: "Mecánico", firstSurname: "Pantalla", secondSurname: "",
      email: MECANICO.correo, rol: "MECANICO", idWorkshop: ID_WORKSHOP,
      isActive: true, isDeleted: false, createdAt: ahora, updatedAt: ahora,
    }, { merge: true });
  });

  test.afterAll(async () => {
    for (const uid of creados.uids) {
      await qaDb().collection("users").doc(uid).delete().catch(() => {});
      await qaAuth().deleteUser(uid).catch(() => {});
    }
  });

  test("si el listado falla, avisa — y NO dice 'No tienes autos asignados'", async ({ page }) => {
    await entrarComo(page, MECANICO);

    // Se rompe la consulta a proposito, con el mismo cuerpo que devolvia el
    // backend cuando faltaba el indice.
    await page.route(/\/v1\/entries(\?|$)/, (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          status: 400,
          descripcion: "9 FAILED_PRECONDITION: The query requires an index.",
        }),
      }),
    );

    await page.goto("/produccion");

    await expect(
      page.getByRole("alert"),
      "punto n16: un fallo del API se veia igual que 'no hay autos'",
    ).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/no se pudieron cargar los autos de producci[oó]n/i))
      .toBeVisible({ timeout: 10000 });
    await expect(
      page.getByText(/no tienes autos asignados/i),
      "un fallo NO puede pintarse como lista vacia",
    ).toHaveCount(0);
    // Y siempre hay salida.
    await expect(page.getByRole("button", { name: /reintentar/i })).toBeVisible();
  });

  test("si de verdad no hay autos, sale el vacío de siempre y NO el aviso de error", async ({ page }) => {
    await entrarComo(page, MECANICO);
    // Sin interceptar: este mecanico es nuevo y no tiene autos asignados.
    await page.goto("/produccion");

    await expect(page.getByText(/no tienes autos asignados/i)).toBeVisible({ timeout: 20000 });
    await expect(
      page.getByRole("alert"),
      "una lista vacia NO puede pintarse como error",
    ).toHaveCount(0);
  });
});
