const { test, expect } = require("@playwright/test");
const { modo } = require("../../adminFlex");
const { authHeaders } = require("#apiToken");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OBS31-08 — El teléfono se guarda truncado / sucio (lado GUARDADO)  @api
 * SPEC DE REPRODUCCIÓN (nuevo): primero demuestra el bug, luego valida el fix.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lo que reportó Roberto (31-ago, obs. 9 y 10): al pegar el teléfono desde
 * Excel se pierden los 2 últimos dígitos, a veces no deja guardar, y en
 * Configuración los usuarios de los roles se ven con solo 8 dígitos.
 *
 * Hipótesis VERIFICADA leyendo el código (este spec la firma en rojo):
 *   - `createUserSchema` exige ^\d{10}$… pero su .parse() está COMENTADO en
 *     users.service.js → POST /v1/users guarda CUALQUIER teléfono.
 *   - `updateUser()` no aplica el updateUserSchema → PUT /v1/users/:id igual.
 *   - El front (UserForm) tampoco valida el teléfono antes de mandar.
 *   → Un teléfono de 8 dígitos (truncado por el pegado, ver spec de UI
 *     hermano) entra a Firestore SIN AVISO. Falla silenciosa, familia OBS-23.
 *
 * CONTRA EL CÓDIGO DE HOY se espera: caso 1 VERDE (el camino sano funciona),
 * casos 2 a 4 ROJOS = bug reproducido. Tras el fix, todo verde.
 *
 * CONTRATO DEL FIX (estándar de Enrique, 8-sep): en base SOLO dígitos, 10
 * exactos. El backend LIMPIA el formato que llegue (guiones/espacios: caso 3
 * se normaliza, no se rechaza) y RECHAZA lo que no quede en 10 (casos 2 y 4:
 * un truncado es dato perdido, no formato).
 *
 * ── CÓMO CORRERLO (PowerShell, desde ccc-testing) ─────────────────────────
 *   $env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"
 *   $env:AUTH_REAL="1"; $env:SKIP_SEED="1"
 *   $env:ID_WORKSHOP="G85FhlhedkD4L4CEDWvW"
 *   $env:SEED_EMAIL="<Dueño o Admin>"; $env:SEED_PASSWORD="..."
 *   npx playwright test --project=qa tests/qa/OBS31-08_telefono-guardado.api.spec.js
 *
 * Los usuarios que crea llevan correo obs3108.*@test.com y quedan dados de
 * baja (soft-delete) al final, pase lo que pase.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || (modo === "emulador" ? "taller-prueba" : null);
if (!ID_WORKSHOP) throw new Error('Falta ID_WORKSHOP. Ej: $env:ID_WORKSHOP="G85F..."');

const S = String(Date.now()).slice(-7);
const TEL_VALIDO = `55${S}0`;              // 10 dígitos, único por corrida
const TEL_TRUNCADO = `55${S}0`.slice(0, 8); // los mismos, truncado a 8 (como llega del pegado)
// El MISMO número válido pero con formato 3-3-4 de Excel (10 dígitos + guiones):
const TEL_CON_GUIONES = `${TEL_VALIDO.slice(0, 3)}-${TEL_VALIDO.slice(3, 6)}-${TEL_VALIDO.slice(6)}`;

const creados = []; // ids a limpiar

async function call(request, method, path, body) {
  const res = await request[method](`${API}${path}`, {
    headers: await authHeaders(),
    ...(body ? { data: body } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status(), body: json, data: json?.data ?? json };
}

const altaBase = (n) => ({
  name: "Prueba",
  firstSurname: `Obs3108${n}`,
  email: `obs3108.${n}.${S}@test.com`,
  password: "Prueba#2026x",
  rol: "RECEPCION",
  country: "México",
  idWorkshop: ID_WORKSHOP,
});

test.describe.configure({ mode: "serial" });

test.describe("OBS31-08 · la API no debe aceptar teléfonos que no sean 10 dígitos @api", () => {
  let userId;

  test("1) camino sano: alta con 10 dígitos limpios queda tal cual", async ({ request }) => {
    const r = await call(request, "post", "/users", { ...altaBase("a"), phone: TEL_VALIDO });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(201);
    userId = r.data?.uid ?? r.data?.id;
    expect(userId, "la respuesta debe traer el id del usuario").toBeTruthy();
    creados.push(userId);

    const g = await call(request, "get", `/users/${userId}`);
    expect(String(g.data?.phone)).toBe(TEL_VALIDO);
  });

  test("2) ROJO esperado hoy: la alta con 8 dígitos (pegado truncado) debe RECHAZARSE", async ({ request }) => {
    const r = await call(request, "post", "/users", { ...altaBase("b"), phone: TEL_TRUNCADO });
    // Si esto llegó a guardarse, apúntalo para limpiarlo aunque el assert truene.
    const id = r.data?.uid ?? r.data?.id;
    if (r.status === 201 && id) creados.push(id);

    expect(
      [400, 422],
      `La API aceptó un teléfono de 8 dígitos (status ${r.status}). ` +
        `Se guardó truncado y en silencio — exactamente lo que Roberto ve en Configuración. ` +
        `Respuesta: ${JSON.stringify(r.body).slice(0, 300)}`,
    ).toContain(r.status);
  });

  test("3) ROJO esperado hoy: el PUT con guiones se NORMALIZA — en la base quedan solo los 10 dígitos", async ({ request }) => {
    test.skip(!userId, "depende del usuario del caso 1");
    const r = await call(request, "put", `/users/${userId}`, { phone: TEL_CON_GUIONES });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);

    const g = await call(request, "get", `/users/${userId}`);
    const guardado = String(g.data?.phone);
    expect(
      guardado,
      `Se mandó '${TEL_CON_GUIONES}' y en la base quedó '${guardado}'. ` +
        `El estándar es SOLO dígitos: el backend debe limpiar el formato sin perder dígitos.`,
    ).toBe(TEL_VALIDO);
  });

  test("4) ROJO esperado hoy: el PUT con 8 dígitos (el camino de Configuración) debe RECHAZARSE", async ({ request }) => {
    test.skip(!userId, "depende del usuario del caso 1");
    const r = await call(request, "put", `/users/${userId}`, { phone: TEL_TRUNCADO });

    const g = await call(request, "get", `/users/${userId}`);
    const guardado = String(g.data?.phone);

    expect(
      [400, 422],
      `El PUT aceptó un teléfono de 8 dígitos (status ${r.status}); en la base quedó '${guardado}'. ` +
        `Así es como el dato truncado sobrevive y reaparece en Configuración.`,
    ).toContain(r.status);
    expect(guardado, "el teléfono almacenado no debe cambiar tras un intento inválido").toBe(TEL_VALIDO);
  });

  test.afterAll("limpieza: baja lógica de los usuarios de prueba", async ({ playwright }) => {
    // `request` es fixture de test, no vive en afterAll: se crea un contexto propio.
    const ctx = await playwright.request.newContext();
    for (const id of creados) {
      await call(ctx, "delete", `/users/${id}`).catch(() => {});
    }
    await ctx.dispose();
  });
});
