const { test, expect } = require("@playwright/test");
const { MECHANIC_ID, post, getJson, makeEntry, login } = require("./_helpers");

/**
 * Bloque 2 (25-ago) — Obs. 16-ago #4 "guardo el diagnóstico y no aparece":
 * el listado de entries/{id}/diagnostics ya NO depende de un índice compuesto
 * de Firestore (filtra por isDeleted y ordena en memoria). Se verifica que:
 *   - lo guardado se lista (más reciente primero) y pagina por cursor;
 *   - la entrada recibe el resumen denormalizado (diagnosticSummary,
 *     lastDiagnosticAt) que pinta "Diagnóstico ✓" en la tarjeta;
 *   - la vista /diagnostico-vista/:id muestra el diagnóstico (no "Sin
 *     diagnósticos registrados").
 */

const finding = (tag, severity = "ROJO") => ({
  id: `${tag}-${severity}`,
  system: "Frenos",
  component: `Balatas ${tag}`,
  finding: "Desgaste.",
  severity,
  recommendation: "Reemplazo.",
  commercialDescription: "Balatas gastadas.",
  consequence: "Frenado deficiente.",
});

test.describe.serial("Bloque 2 — diagnósticos se listan y se reflejan en la OS", () => {
  let entryId;
  let os;
  let firstId;
  let secondId;

  test("1) API: crear → listar (orden y cursor) → resumen en la entrada", { tag: ["@api"] }, async ({ request }) => {
    const e = await makeEntry(request, { tag: "DGX" });
    entryId = e.entryId;
    os = e.os;

    firstId = await post(request, `/entries/${entryId}/diagnostics`, {
      idMechanic: MECHANIC_ID,
      generalObservations: "Primer diagnóstico",
      findings: [finding("DGX1", "AMARILLO")],
    });
    // Un segundo diagnóstico, más reciente, con hallazgo rojo.
    await new Promise((r) => setTimeout(r, 30));
    secondId = await post(request, `/entries/${entryId}/diagnostics`, {
      idMechanic: MECHANIC_ID,
      generalObservations: "Segundo diagnóstico",
      findings: [finding("DGX2", "ROJO"), finding("DGX2b", "VERDE")],
    });
    const id1 = firstId?.id ?? firstId;
    const id2 = secondId?.id ?? secondId;
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();

    // Listado completo: los dos, el más reciente primero.
    const all = await getJson(request, `/entries/${entryId}/diagnostics?limit=10`);
    const list = all?.diagnostics ?? [];
    expect(list.map((d) => d.id), "ambos diagnósticos listados, reciente primero").toEqual([id2, id1]);

    // Paginación por cursor sobre la lista ordenada en memoria.
    const p1 = await getJson(request, `/entries/${entryId}/diagnostics?limit=1`);
    expect((p1?.diagnostics ?? []).map((d) => d.id)).toEqual([id2]);
    expect(p1?.lastDocId).toBe(id2);
    const p2 = await getJson(request, `/entries/${entryId}/diagnostics?limit=1&startAfter=${id2}`);
    expect((p2?.diagnostics ?? []).map((d) => d.id)).toEqual([id1]);
    const p3 = await getJson(request, `/entries/${entryId}/diagnostics?limit=1&startAfter=${id1}`);
    expect(p3?.diagnostics ?? []).toEqual([]);
    expect(p3?.lastDocId ?? null).toBeNull();

    // La entrada quedó con el resumen del MÁS RECIENTE (1 rojo, 1 verde).
    const entry = await getJson(request, `/entries/${entryId}`);
    expect(entry?.lastDiagnosticAt, "lastDiagnosticAt sellado").toBeTruthy();
    expect(Number(entry?.diagnosticSummary?.total), "total del último diagnóstico").toBe(2);
    expect(Number(entry?.diagnosticSummary?.red)).toBe(1);
  });

  test("2) UI: la vista de diagnósticos de la OS muestra lo guardado", { tag: ["@ui"] }, async ({ page }) => {
    await login(page);
    await page.goto(`/diagnostico-vista/${entryId}`);
    await expect(page.getByText(/sin diagnósticos registrados/i)).toHaveCount(0, { timeout: 20000 });
    await expect(page.getByText(/Segundo diagnóstico/).first()).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/Primer diagnóstico/).first()).toBeVisible();
  });

  test("3) UI: la tarjeta de Entrada marca el diagnóstico como hecho", { tag: ["@ui"] }, async ({ page }) => {
    await login(page);
    await page.goto("/registro");
    const search = page.getByRole("textbox", { name: /buscar por no\. de os/i });
    await search.fill(os);
    await page.getByRole("button", { name: /^buscar$/i }).click();
    const card = page.locator(".rounded-xl", { hasText: `OS: ${os}` }).first();
    await expect(card).toBeVisible({ timeout: 20000 });
    // Q26: etapa hecha = píldora azul. "Diagnóstico" con clase de hecho.
    const diag = card.getByRole("button", { name: /^diagnóstico ✓$/i });
    await expect(diag).toBeVisible();
    await expect(diag).toHaveClass(/text-blue-800/);
  });
});
