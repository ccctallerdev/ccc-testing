const { test, expect } = require("@playwright/test");
const { authHeaders } = require("../apiToken");

/**
 * Configuración persistida:
 *   - Q18: serviceFollowUpMonths vive en el MODELO OPERATIVO del taller
 *     (default 6, editable, y no pisa los demás parámetros al guardar).
 *   - #60: sessionTimeoutMinutes es preferencia POR USUARIO (se guarda en su
 *     perfil vía PUT /users/:id).
 *
 * Pruebas de API contra los emuladores.
 *
 * PRERREQUISITOS:
 *   1) Emuladores:  cd ccc-backend && npm run serve
 *   2) Backend:     cd ccc-backend && npm run backend
 *   3) Usuario:     cd ccc-testing && node seed_emulator_user.js
 */

const API = process.env.API || "http://localhost:3001/v1";
const ID_WORKSHOP = process.env.ID_WORKSHOP || "taller-prueba";

async function call(request, method, path, body) {
  // Q20: la API blindada exige el token firmado en CADA llamada.
  const res = await request[method](`${API}${path}`, { headers: await authHeaders(), ...(body ? { data: body } : {}) });
  if (!res.ok()) {
    throw new Error(`${method.toUpperCase()} ${path} → ${res.status()}: ${await res.text()}`);
  }
  const json = await res.json().catch(() => null);
  return json?.data ?? json;
}
const getJson = (r, p) => call(r, "get", p);
const put = (r, p, b) => call(r, "put", p, b);

// El modelo operativo mezcla defaults por taller: un idWorkshop desechable
// nos da un "taller limpio" sin tocar el de las demás pruebas.
const freshWorkshopId = () => `taller-config-${Date.now()}`;

test("Q18: serviceFollowUpMonths default 6 y editable en el modelo operativo", async ({
  request,
}) => {
  const idw = freshWorkshopId();

  // Default para un taller sin configuración previa.
  const before = await getJson(request, `/settings/operating-model?idWorkshop=${idw}`);
  expect(Number(before?.serviceFollowUpMonths)).toBe(6);

  // Guardar 8 meses.
  await put(request, `/settings/operating-model?idWorkshop=${idw}`, {
    serviceFollowUpMonths: 8,
  });
  const after = await getJson(request, `/settings/operating-model?idWorkshop=${idw}`);
  expect(Number(after?.serviceFollowUpMonths)).toBe(8);

  // El guardado parcial NO pisa los demás parámetros (siguen sus defaults).
  expect(Number(after?.daysAtRisk)).toBe(Number(before?.daysAtRisk));
  expect(Number(after?.osStart)).toBe(Number(before?.osStart));
});

test("Q18: el schema rechaza valores inválidos (0 meses)", async ({ request }) => {
  const idw = freshWorkshopId();
  const res = await request.put(
    `${API}/settings/operating-model?idWorkshop=${idw}`,
    { data: { serviceFollowUpMonths: 0 } },
  );
  expect(res.ok()).toBe(false); // positive() → 0 no es válido
});

test("#60: sessionTimeoutMinutes se guarda por usuario y persiste", async ({
  request,
}) => {
  // Usuario semilla del taller de prueba (Admin Prueba).
  const list = await getJson(request, `/users?idWorkshop=${ID_WORKSHOP}`);
  const admin = (list?.users ?? []).find((u) => !u.isDeleted);
  expect(admin?.id).toBeTruthy();

  // Guardar 45 minutos.
  await put(request, `/users/${admin.id}`, { sessionTimeoutMinutes: 45 });
  let user = await getJson(request, `/users/${admin.id}`);
  expect(Number(user?.sessionTimeoutMinutes)).toBe(45);

  // El guardado no rompe los demás campos del perfil.
  expect(user?.rol).toBeTruthy();
  expect(user?.idWorkshop).toBe(ID_WORKSHOP);

  // Regresar al default para no ensuciar corridas futuras.
  await put(request, `/users/${admin.id}`, { sessionTimeoutMinutes: 30 });
  user = await getJson(request, `/users/${admin.id}`);
  expect(Number(user?.sessionTimeoutMinutes)).toBe(30);
});
