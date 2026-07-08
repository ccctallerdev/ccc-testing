const { test, expect } = require("@playwright/test");

/**
 * JORNADA COMPLETA POR UI — como una persona usando la app, sin semillas de
 * datos: el propio test crea al cliente, el vehículo, la entrada, la hoja,
 * el diagnóstico, el costeo y la cotización A PUNTA DE CLICS, y termina
 * aprobando la OS (Q3).
 *
 * Único prerrequisito de datos: el usuario de login y el mecánico, que el
 * global-setup siembra solo (no hay pantalla pública de registro — Q34).
 *
 * PRERREQUISITOS (corriendo): emuladores + backend + frontend.
 *
 * NOTA: la app no tiene data-testid; los selectores van por rol/label/id.
 * Si algún label cambia, este spec avisa con precisión en qué etapa.
 */

const API = process.env.API || "http://localhost:3001/v1";
const EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
const PASSWORD = process.env.SEED_PASSWORD || "prueba123";

const suffix = `${String(Date.now()).slice(-6)}`;
const CLIENTE = `Jornada UI ${suffix}`;
// Sin guión: el input de placas aplica removeSpecialChar y lo eliminaría.
const PLACAS = `JOR${suffix.slice(-4)}`;

test("jornada UI: crear cliente+vehículo+OS → hoja → diagnóstico → costeo → cotización → aprobar", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);

  // ── Login ──────────────────────────────────────────────────────────────────
  await page.goto("/login");
  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });

  // ── ETAPA 1: Nueva entrada → Cliente y vehículo nuevo ─────────────────────
  await page.goto("/registro");
  await page.getByRole("button", { name: /nueva entrada/i }).click();
  await expect(page).toHaveURL(/elegir-vehiculo/);
  await page.getByRole("button", { name: /cliente y vehículo nuevo/i }).click();
  await expect(page).toHaveURL(/crear-cliente-vehiculo/);

  // ── ETAPA 2: Paso 1 — datos del cliente ────────────────────────────────────
  await page.locator("#name").fill(CLIENTE);
  await page.locator("#phone").fill(`55${suffix}12`);
  await page.locator("#email").fill(`jornada.${suffix}@test.com`);
  await page.getByRole("button", { name: /^siguiente$/i }).click();
  // Confirmar que avanzó al paso del vehículo.
  await expect(page.locator("#codeCar")).toBeVisible({ timeout: 10000 });

  // ── ETAPA 3: Paso 2 — datos del vehículo ───────────────────────────────────
  // Marca/modelo/color son combobox: se escribe y se hace CLIC en la opción
  // de la lista (Enter no confirma si no hay opción resaltada).
  // Las opciones del dropdown son <button> (no <li>).
  const brandInput = page.getByPlaceholder(/escribe o selecciona una marca/i);
  await brandInput.fill("Nissan");
  await page.getByRole("button", { name: /^Nissan$/ }).first().click();
  const modelInput = page.getByPlaceholder(/el modelo|modelo \(libre\)|primero elige/i);
  await modelInput.fill("Sentra");
  await page.getByRole("button", { name: /^Sentra$/ }).first().click();
  await page.locator("#year").fill("2021"); // input de texto, no select
  const colorInput = page.getByPlaceholder(/escribe o selecciona un color/i);
  await colorInput.fill("Rojo");
  await page.getByRole("button", { name: /^Rojo$/ }).first().click();

  await page.locator("#codeCar").fill(PLACAS);
  await page.locator("#vin").fill(`JORNADA${suffix}00000`.slice(0, 17));
  await page.locator("#transmition").selectOption("Manual");
  await page.locator("#car-km").fill("45000");
  await page.locator("#car-fuel").selectOption("Gasolina");
  // Mecánico: react-select "creatable". El placeholder intercepta los clics,
  // así que se escribe DIRECTO en su input interno (id react-select-*-input)
  // y Enter elige la opción filtrada. (El mecánico lo siembra el global-setup.)
  const mecInput = page.locator('input[id^="react-select"][id$="-input"]').first();
  await mecInput.click({ force: true });
  await mecInput.pressSequentially("Mecánico Prueba");
  await page.keyboard.press("Enter");
  await page
    .locator("#car-issue-desc")
    .fill("Jornada E2E: ruido al frenar en frío.");
  await page.getByRole("button", { name: /^siguiente$/i }).click();

  // ── ETAPA 4: Paso 3 — hoja de servicio (aquí se persiste todo) ────────────
  // Confirmar que avanzó (si una validación del paso 2 falló, esto truena
  // aquí y el screenshot muestra el toast "Completa: …" con el campo exacto).
  await expect(page.locator("#selectAll")).toBeVisible({ timeout: 10000 });
  // Ítems del vehículo: "Marcar todos" (cubre Documentos, Llave, Birlo…).
  await page.locator("#selectAll").check();
  // Nivel de tanque.
  const tank = page.locator('[data-entry-sheet-field="fuel_tank"]');
  if (await tank.count()) {
    await tank.getByText("1/2", { exact: true }).click();
  } else {
    await page.getByRole("button", { name: "1/2" }).first().click();
  }
  // Checks (obligatorio ≥1): abrir el acordeón de fallas y marcar la primera.
  await page
    .getByRole("button", { name: /diagn[oó]stico\/fallas reportadas/i })
    .click();
  await page
    .locator("label", { has: page.locator('input[type="checkbox"]') })
    .filter({ hasText: /frenos|ruido/i })
    .first()
    .click();
  // "Estado general del vehículo" es obligatorio en la hoja.
  await page
    .getByPlaceholder(/describa los aspectos generales/i)
    .fill("Carrocería en buen estado; ligero rayón en defensa trasera.");
  await page
    .getByRole("button", { name: /registrar y continuar/i })
    .click();

  // ── ETAPA 5: Paso 4 — evidencias (opcional) → Finalizar ────────────────────
  // El registro es asíncrono: o aparece el paso 4 ("Finalizar"), o la app
  // lanza un toast de error — en ese caso lo elevamos al reporte tal cual
  // para no adivinar qué faltó.
  const finalizarBtn = page.getByRole("button", { name: /finalizar/i });
  const failToast = page
    .locator("[data-sonner-toaster]")
    .getByText(/faltan datos|no se pudo|error al/i)
    .first();
  await Promise.race([
    finalizarBtn.waitFor({ state: "visible", timeout: 30000 }),
    failToast.waitFor({ state: "visible", timeout: 30000 }).then(async () => {
      throw new Error(
        `El registro de la OS falló. Mensaje de la app: "${await failToast.textContent()}"`,
      );
    }),
  ]);
  await finalizarBtn.click();

  // De regreso en el registro: la tarjeta nueva existe. Se identifica por
  // PLACAS (el nombre del cliente se re-capitaliza al guardar: "UI" → "Ui").
  await page.goto("/registro");
  const card = page
    .locator("div.rounded-xl.border", { hasText: PLACAS })
    .first();
  await expect(card).toBeVisible({ timeout: 15000 });
  // Q26: diagnóstico pendiente = botón sin ✓
  await expect(
    card.getByRole("button", { name: /diagn[oó]stico/i }),
  ).not.toContainText("✓");

  // ── ETAPA 6: Diagnóstico (1 hallazgo ROJO) ────────────────────────────────
  await card.getByRole("button", { name: /diagn[oó]stico/i }).click();
  await expect(page).toHaveURL(/diagnostico-vista/);
  await page.getByRole("button", { name: /nuevo diagn[oó]stico/i }).click();

  await page.getByPlaceholder(/ej\. frenos/i).first().fill("Frenos");
  await page
    .getByPlaceholder(/ej\. balatas delanteras/i)
    .first()
    .fill("Balatas delanteras");
  // Severidad: radio "Rojo"
  await page.getByRole("radio", { name: /rojo/i }).first().click();
  // Hallazgo técnico (primer textarea del hallazgo)
  // Campos del hallazgo por placeholder (el orden de los textareas en el DOM
  // no es el visual: el hallazgo técnico va primero, no las observaciones).
  await page
    .getByPlaceholder(/describe lo encontrado/i)
    .fill("Balatas en metal-metal; cambio inmediato.");
  await page
    .getByPlaceholder(/acci[oó]n sugerida/i)
    .fill("Reemplazo de balatas delanteras.");
  await page.getByRole("button", { name: /guardar diagn[oó]stico/i }).click();
  // O redirige a la vista (guardado OK) o hay TOAST de error — lo elevamos.
  // OJO: scoped al contenedor de sonner; la página tiene textos de ayuda
  // permanentes ("Completa sistema…") que daban falso positivo.
  const diagFail = page
    .locator("[data-sonner-toaster]")
    .getByText(/error|no se pudo|completa|falta/i)
    .first();
  await Promise.race([
    page.waitForURL(/diagnostico-vista/, { timeout: 20000 }),
    diagFail.waitFor({ state: "visible", timeout: 20000 }).then(async () => {
      throw new Error(
        `Guardar diagnóstico falló: "${await diagFail.textContent()}"`,
      );
    }),
  ]);

  // ── ETAPA 7: Costeo (sin precios) ──────────────────────────────────────────
  // Al guardar, la app se queda en /diagnostico/:id (no regresa sola a la
  // vista): tomamos el entryId de la URL y vamos a la vista, donde está "Costeo".
  await page.waitForURL(/\/diagnostico(-vista)?\//, { timeout: 20000 });
  const entryIdFromUrl = page.url().match(/diagnostico(?:-vista)?\/([^/?]+)/)?.[1];
  expect(entryIdFromUrl, "entryId en la URL del diagnóstico").toBeTruthy();
  await page.goto(`/diagnostico-vista/${entryIdFromUrl}`);
  await expect(page).toHaveURL(/diagnostico-vista/, { timeout: 20000 });
  await page.getByRole("button", { name: /^\s*costeo\s*$/i }).first().click();
  await expect(page).toHaveURL(/\/costeo\//);
  // Una refacción en texto libre CON cantidad (el editor la exige > 0).
  // La cantidad es el input siguiente a la descripción dentro de la misma fila.
  await page.getByPlaceholder(/filtro de aceite oem/i).first().fill("Balatas delanteras");
  const partRow = page
    .locator("div.grid", { has: page.getByPlaceholder(/filtro de aceite oem/i) })
    .first();
  await partRow.locator("input").nth(1).fill("2");
  await page.getByRole("button", { name: /guardar costeo/i }).click();

  // ── ETAPA 8: Cotización — precios + anticipo (Q7) ─────────────────────────
  // Guardar costeo navega al DETALLE de la cotización (?quoteId=...):
  // tomamos el id de la URL y vamos directo al editor.
  await page.waitForURL(/cotizacion-vista.*quoteId=/, { timeout: 20000 });
  const quoteIdFromUrl = new URL(page.url()).searchParams.get("quoteId");
  expect(quoteIdFromUrl, "quoteId en la URL tras guardar costeo").toBeTruthy();
  await page.goto(
    `/cotizacion-editar/${entryIdFromUrl}?quoteId=${quoteIdFromUrl}`,
  );
  await expect(page).toHaveURL(/cotizacion-editar/, { timeout: 20000 });

  // Precio unitario de la refacción y mano de obra.
  const priceInputs = page.locator('input[inputmode="numeric"]');
  await priceInputs.first().fill("850");
  // Mano de obra: quitar "N/A" si existe y poner precio… la descripción viene
  // del costeo; solo falta el costo (segundo input numérico).
  if ((await priceInputs.count()) > 1) {
    await priceInputs.nth(1).fill("400");
  }
  // Anticipo (Q7)
  await page.getByPlaceholder("0.00").fill("300");
  await page.getByRole("button", { name: /^guardar$/i }).click();
  // Verificar que el guardado convirtió el costeo: o navega a la vista, o
  // hay toast de error (validación de cantidades/precios) — lo elevamos.
  const quoteFail = page
    .locator("[data-sonner-toaster]")
    .getByText(/incompleta|inv[aá]lidos|no se pudo|error/i)
    .first();
  await Promise.race([
    page.waitForURL(/cotizacion-vista/, { timeout: 20000 }),
    quoteFail.waitFor({ state: "visible", timeout: 20000 }).then(async () => {
      throw new Error(
        `Guardar cotización falló: "${await quoteFail.textContent()}"`,
      );
    }),
  ]);

  // ── ETAPA 9: Aprobar (Q3: 1 cotización → directa) ─────────────────────────
  await page.goto("/registro");
  const cardAgain = page
    .locator("div.rounded-xl.border", { hasText: PLACAS })
    .first();
  await expect(cardAgain).toBeVisible({ timeout: 15000 });
  await cardAgain.locator(".ant-select").first().click();
  await page
    .locator(
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="Aprobada"]',
    )
    .click();
  // Capturar el PRIMER toast que aparezca y validar su contenido: si no es
  // el de éxito, el reporte dirá textualmente qué respondió la app.
  const approveToast = page.locator("[data-sonner-toast]").first();
  await approveToast.waitFor({ state: "visible", timeout: 15000 });
  const approveMsg = (await approveToast.textContent()) ?? "";
  expect(
    approveMsg,
    `toast tras aprobar (URL: ${page.url()})`,
  ).toMatch(/estatus actualizado/i);

  // ── Verificación de fondo (una sola, por API): la OS quedó bien armada ────
  const found = await request.get(
    `${API}/entries?idWorkshop=taller-prueba&approvalState=APROBADA&limit=50&page=1`,
  );
  const body = await found.json().catch(() => null);
  const rows = body?.data?.entries ?? body?.data ?? [];
  const mine = (Array.isArray(rows) ? rows : []).find(
    (e) => String(e?.codeCar ?? "") === PLACAS,
  );
  expect(mine, "la OS creada por UI debe existir y estar APROBADA").toBeTruthy();
});
