const { test, expect } = require("@playwright/test");
const { db: qaDb, auth: qaAuthAdmin, oobCodeFor } = require("../../qaAdmin");
const { apiKeyPublica } = require("../../qaAuth");

/**
 * ─────────────────────────────────────────────────────────────────────────
 * COPIA PARA QA — el original en tests/comercial/ NO se toca.
 *
 * Mismo test, mismas aserciones; solo cambia lo que estaba atado a los
 * emuladores:
 *   · signIn / resetPassword  → identitytoolkit REAL con la API key web
 *   · oobCode del buzón falso → generado con el Admin SDK (qaAdmin)
 *   · Firestore del emulador  → Firestore de refac con el serviceAccountKey
 *
 * ⚠️ El oobCode lo genera el test, no viene del correo de Brevo: se prueba
 * que la activación funciona, no que el enlace del correo sea el correcto.
 *
 * Requiere ID_WORKSHOP (un taller real de refac) y el serviceAccountKey en
 * ccc-backend/functions/ (o SERVICE_ACCOUNT_KEY).
 * ─────────────────────────────────────────────────────────────────────────
 */
const { authHeaders } = require("#apiToken");

/**
 * Clientes v2 — DESAFILIACIÓN (20-ago): "eliminar cliente" en el taller =
 * soft-delete del TOKEN de afiliación, NO del cliente global.
 *
 *   - Desafiliar lo saca de la lista del taller y su token deja de abrir
 *     sesión en la app (mismo 404 que un token inexistente).
 *   - El cliente global, su cuenta y sus autos se conservan.
 *   - Re-afiliarlo (with-account, idempotente) REACTIVA su token anterior:
 *     mismo clientId y MISMO código — sin preguntar ni rotar.
 *
 * PRERREQUISITOS: emuladores + backend + seed (global-setup).
 */

const API = process.env.API || "http://localhost:3001/v1";
const PROJECT_ID = process.env.EMU_PROJECT_ID || "ccc-taller-refac";
const ID_WORKSHOP = process.env.ID_WORKSHOP;
if (!ID_WORKSHOP) {
  throw new Error(
    "Falta ID_WORKSHOP: estos gemelos corren contra un taller REAL de refac.\n" +
      'Ejemplo: $env:ID_WORKSHOP="05Pf5VZ7IGCbi6JA8ObU"',
  );
}

const stamp = String(Date.now()).slice(-7);
const EMAIL = `desafiliar.${stamp}@ccc.test`;
const PASSWORD = "MiClave123!";

async function api(request, token, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json, data: json?.data ?? json };
}

async function signIn(request, email, password) {
  const res = await request.post(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKeyPublica()}`,
    { data: { email, password, returnSecureToken: true } },
  );
  if (!res.ok()) throw new Error(`signIn ${email} → ${res.status()}: ${await res.text()}`);
  return await res.json();
}

/** oobCode de PASSWORD_RESET — generado con el Admin SDK (no hay buzón falso). */
async function lastResetCode(request, email) {
  return oobCodeFor(email);
}

async function listaDelTaller(request, adminToken) {
  const res = await api(request, adminToken, "get", `/clients?idWorkshop=${ID_WORKSHOP}&limit=100`);
  return (res.data?.clients ?? []).filter((c) => c.email === EMAIL);
}

test.describe.serial("QA · Clientes v2 — desafiliar y re-afiliar (token soft-delete + reactivación)", () => {
  let adminToken;
  let alta; // { client, token, tokenId, ... } del primer with-account
  let clientIdToken; // idToken de la cuenta del cliente (activada)

  test.beforeAll(async ({ request }) => {
    adminToken = (await authHeaders()).Authorization.replace("Bearer ", "");

    const res = await api(request, adminToken, "post", "/clients/with-account", {
      fullName: "Cliente Desafiliable",
      email: EMAIL,
      phone: `55${stamp}9`.slice(0, 10),
      createdBy: "spec",
      idWorkshop: ID_WORKSHOP,
    });
    expect(res.status, `alta: ${JSON.stringify(res.body)}`).toBe(201);
    alta = res.data;

    // Activar la cuenta (oobCode del emulador) para poder abrir sesión de app.
    let code = await lastResetCode(request, EMAIL);
    if (!code) {
      await request.post(`${API}/public/resend-activation`, {
        data: { email: EMAIL },
        headers: { "x-forwarded-for": `10.7.${stamp.slice(0, 2)}.1` },
      });
      code = await lastResetCode(request, EMAIL);
    }
    expect(code, "oobCode de activación").toBeTruthy();
    const reset = await request.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=${apiKeyPublica()}`,
      { data: { oobCode: code, newPassword: PASSWORD } },
    );
    expect(reset.ok()).toBe(true);
    clientIdToken = (await signIn(request, EMAIL, PASSWORD)).idToken;
  });

  test("1) la lista del taller trae al cliente CON su tokenId", { tag: ["@api"] }, async ({ request }) => {
    const mios = await listaDelTaller(request, adminToken);
    expect(mios.length).toBe(1);
    expect(mios[0].token).toBe(alta.token);
    expect(mios[0].tokenId, "getAllClients debe exponer tokenId para desafiliar").toBe(alta.tokenId);
  });

  test("2) desafiliar = DELETE /tokens/:id — sale de la lista, el cliente global sobrevive", { tag: ["@api"] }, async ({ request }) => {
    const del = await api(request, adminToken, "delete", `/tokens/${alta.tokenId}`);
    expect(del.status, `desafiliar: ${JSON.stringify(del.body)}`).toBeLessThan(300);

    const mios = await listaDelTaller(request, adminToken);
    expect(mios.length, "desafiliado no aparece en la lista del taller").toBe(0);

    // El cliente global NO se tocó (expediente intacto).
    const cli = await api(request, adminToken, "get", `/clients/${alta.client.id}`);
    expect(cli.status).toBe(200);
    expect(cli.data.isDeleted).toBe(false);
  });

  test("3) el token desafiliado NO abre sesión en la app (mismo 404 que inexistente)", { tag: ["@api"] }, async ({ request }) => {
    const ses = await api(request, clientIdToken, "get", `/app/session/${alta.token}`);
    expect(ses.status).toBe(404);
    // Y tampoco aparece en su selector de talleres.
    const toks = await api(request, clientIdToken, "get", "/app/tokens");
    expect(toks.status).toBe(200);
    expect((Array.isArray(toks.data) ? toks.data : []).map((t) => t.token)).not.toContain(alta.token);
  });

  test("4) re-afiliar REACTIVA: mismo clientId y MISMO token, sin duplicados", { tag: ["@api"] }, async ({ request }) => {
    const res = await api(request, adminToken, "post", "/clients/with-account", {
      fullName: "Cliente Desafiliable",
      email: EMAIL,
      phone: `55${stamp}9`.slice(0, 10),
      createdBy: "spec",
      idWorkshop: ID_WORKSHOP,
    });
    expect(res.status, `re-alta: ${JSON.stringify(res.body)}`).toBe(201);
    expect(res.data.client.id, "mismo cliente (sin doc duplicado)").toBe(alta.client.id);
    expect(res.data.token, "mismo código de token (reactivado)").toBe(alta.token);
    expect(res.data.tokenId, "mismo doc de token (no se creó otro)").toBe(alta.tokenId);
    expect(res.data.clientCreated).toBe(false);
    expect(res.data.accountCreated).toBe(false);

    const mios = await listaDelTaller(request, adminToken);
    expect(mios.length, "vuelve a la lista, una sola vez").toBe(1);
  });

  test("5) tras reactivar, el token vuelve a abrir sesión en la app", { tag: ["@api"] }, async ({ request }) => {
    const ses = await api(request, clientIdToken, "get", `/app/session/${alta.token}`);
    expect(ses.status, `session: ${JSON.stringify(ses.body)}`).toBe(200);
    expect(ses.data.client.id).toBe(alta.client.id);
  });

  test("6) el ciclo es REPETIBLE: segunda desafiliación y re-afiliación directa por POST /tokens", { tag: ["@api"] }, async ({ request }) => {
    // Segunda vuelta: desafiliar otra vez…
    const del = await api(request, adminToken, "delete", `/tokens/${alta.tokenId}`);
    expect(del.status).toBeLessThan(300);
    expect((await listaDelTaller(request, adminToken)).length).toBe(0);

    // …y re-afiliar por el camino directo del wizard (assignToken), no por
    // with-account: también debe REACTIVAR el mismo doc con el mismo código.
    const rea = await api(request, adminToken, "post", "/tokens", {
      idClient: alta.client.id,
      idWorkshop: ID_WORKSHOP,
    });
    expect(rea.status, `re-afiliar por /tokens: ${JSON.stringify(rea.body)}`).toBeLessThan(300);
    expect(rea.data.token).toBe(alta.token);
    expect(rea.data.id).toBe(alta.tokenId);
    expect(rea.data.reactivated).toBe(true);
    expect((await listaDelTaller(request, adminToken)).length).toBe(1);
  });

  test("7) UI: el asesor lo quita del taller y lo re-afilia desde el alta — mismo token", { tag: ["@ui"] }, async ({ page, request }) => {
    test.setTimeout(180_000);
    const ADMIN_EMAIL = process.env.SEED_EMAIL || "prueba@ccc.test";
    const ADMIN_PASSWORD = process.env.SEED_PASSWORD || "prueba123";

    await page.goto("/login");
    await page.locator("#email").fill(ADMIN_EMAIL);
    await page.locator("#password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /iniciar sesión/i }).click();
    await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });

    // ── Quitar del taller desde la lista de Clientes ──
    await page.goto("/clientes");
    const search = page.getByPlaceholder(/nombre, email, teléfono/i);
    await search.fill(EMAIL);
    await page.getByRole("button", { name: /buscar/i }).click();
    await expect(page.getByText("Cliente Desafiliable").first()).toBeVisible({ timeout: 15000 });

    await page.getByRole("button", { name: /quitar de mi taller/i }).first().click();
    // Modal de confirmación (el botón de confirmar lleva aria-label="Confirmar").
    await expect(page.getByText(/quitar cliente del taller/i)).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: /^confirmar$/i }).click();
    await expect(page.getByText(/desafiliado de tu taller/i)).toBeVisible({ timeout: 10000 });

    // Ya no aparece en la lista del taller.
    await search.fill(EMAIL);
    await page.getByRole("button", { name: /buscar/i }).click();
    await expect(page.getByText("Cliente Desafiliable")).toHaveCount(0, { timeout: 15000 });

    // ── Re-afiliar desde "Nuevo Cliente" (lookup enmascarado + confirm) ──
    await page.getByRole("button", { name: /nuevo cliente/i }).click();
    await page.locator("#name").fill("Cliente Desafiliable");
    await page.locator("#phone").fill(`55${stamp}9`.slice(0, 10));
    await page.locator("#email").fill(EMAIL);
    await page.getByRole("button", { name: /^guardar$/i }).click();

    const confirmModal = page.locator(".ant-modal-confirm");
    await expect(confirmModal.getByText(/ya está registrado/i)).toBeVisible({ timeout: 15000 });
    await confirmModal.getByRole("button", { name: /afiliar a mi taller/i }).click();

    // Pantalla de éxito del alta (token + aviso por WhatsApp).
    await expect(page.getByRole("link", { name: /whatsapp/i })).toBeVisible({ timeout: 15000 });

    // El backend REACTIVÓ la misma afiliación: mismo doc, mismo código, vigente.
    const mios = await listaDelTaller(request, adminToken);
    expect(mios.length).toBe(1);
    expect(mios[0].token).toBe(alta.token);
    expect(mios[0].tokenId).toBe(alta.tokenId);
  });
});
