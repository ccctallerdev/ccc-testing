const { test, expect } = require("@playwright/test");

/**
 * Humo del SITIO PÚBLICO (Fase 1 del embudo de marketing).
 *
 * Hasta ahora ningún spec tocaba las landings: los 22 existentes entran por el
 * login y viven dentro del ERP. Esto cubre lo que ve un visitante anónimo, que
 * es justo lo que reciben las campañas del 3 de agosto.
 *
 * NO requiere sesión (las rutas públicas van envueltas en RedirectIfAuthenticated,
 * así que un contexto con sesión las mandaría al dashboard: estas pruebas deben
 * correr siempre anónimas, como las deja Playwright por defecto).
 *
 * Requiere el frontend en http://localhost:3000. El bloque de "Recíbelos en tu
 * correo" además necesita el backend en :3001 con los emuladores.
 */

/** Las 7 páginas oficiales del menú, con el nombre del enlace en la navbar. */
const PAGINAS = [
  { ruta: "/",            enlace: "Centro de Comando" },
  { ruta: "/despertar",   enlace: "Despertar" },
  { ruta: "/transformar", enlace: "Transformar" },
  { ruta: "/dirigir",     enlace: "Dirigir" },
  { ruta: "/planes",      enlace: "Planes" },
  { ruta: "/academy",     enlace: "Academy" },
  { ruta: "/dudas",       enlace: "¿Aún tienes dudas?" },
];

/** Las 4 páginas que comparten la franja de beneficios, con su nombre accesible. */
const CON_FRANJA = [
  { ruta: "/despertar",   franja: "Beneficios de la etapa Despertar" },
  { ruta: "/transformar", franja: "Beneficios de la etapa Transformar" },
  { ruta: "/dirigir",     franja: "Beneficios de la etapa Dirigir" },
  { ruta: "/planes",      franja: "Lo que incluye la plataforma" },
];

/* ========================================================================== */

test.describe("Sitio público — las 7 páginas cargan", { tag: ["@ui", "@publico"] }, () => {
  for (const { ruta } of PAGINAS) {
    test(`${ruta} carga con un solo h1`, async ({ page }) => {
      await page.goto(ruta);
      await expect(page).toHaveURL(new RegExp(`${ruta === "/" ? "/$" : ruta}`));

      // Un h1 por página: es la estructura semántica que pide la guía de a11y,
      // y de paso confirma que la página renderizó y no quedó en blanco.
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    });
  }
});

test.describe("Redirecciones de las rutas retiradas", { tag: ["@ui", "@publico"] }, () => {
  // D10: "Sobre Nosotros" salió del sitio, pero la ruta no se borró para no
  // romper enlaces ya publicados ni lo que tenga indexado el buscador.
  test("/nosotros redirige a la home", async ({ page }) => {
    await page.goto("/nosotros");
    await expect(page).toHaveURL(/localhost:3000\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  // D11: la sección pasó a llamarse Academy.
  test("/manuales redirige a /academy", async ({ page }) => {
    await page.goto("/manuales");
    await expect(page).toHaveURL(/\/academy$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});

test.describe("Navegación del menú público", { tag: ["@ui", "@publico"] }, () => {
  test("cada enlace del menú lleva a su página", async ({ page }) => {
    await page.goto("/");
    for (const { ruta, enlace } of PAGINAS) {
      // El menú de escritorio son <Link> (a diferencia del SideBar del ERP,
      // que usa botones): se buscan por rol link.
      await page.getByRole("link", { name: enlace, exact: true }).first().click();
      await expect(page).toHaveURL(ruta === "/" ? /localhost:3000\/$/ : new RegExp(`${ruta}$`));
    }
  });

  // D1: nombre único "Reto de 14 días" en todo el sitio (antes convivía con
  // "Probar 14 días" / "Prueba gratis").
  test("el CTA de la navbar dice Reto 14 días", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /Reto 14 días/i }).first()).toBeVisible();
  });
});

test.describe("Franja de beneficios compartida", { tag: ["@ui", "@publico"] }, () => {
  test("existe en las 4 páginas y todas miden lo mismo", async ({ page }) => {
    const alturas = [];

    for (const { ruta, franja } of CON_FRANJA) {
      await page.goto(ruta);
      const lista = page.getByRole("list", { name: franja });
      // Vive al fondo del hero: hay que traerla a viewport para que Reveal
      // dispare su animación de entrada antes de medir.
      await lista.scrollIntoViewIfNeeded();
      await expect(lista).toBeVisible();
      await expect(lista.getByRole("listitem").first()).toBeVisible();

      const caja = await lista.boundingBox();
      expect(caja, `sin caja para la franja de ${ruta}`).not.toBeNull();
      alturas.push({ ruta, alto: caja.height });
    }

    // El punto de extraer FranjaBeneficios a un componente compartido: antes
    // cada página la escribía a mano, con distinto número de columnas y sin
    // altura mínima, y unas se veían aplastadas contra otras. Si alguien
    // vuelve a tocar una sola página, esta aserción lo caza.
    const valores = alturas.map((a) => a.alto);
    const diferencia = Math.max(...valores) - Math.min(...valores);
    expect(diferencia, `alturas dispares: ${JSON.stringify(alturas)}`).toBeLessThanOrEqual(4);
  });
});

test.describe("Planes", { tag: ["@ui", "@publico"] }, () => {
  test("muestra los 3 planes y el interruptor cambia el precio", async ({ page }) => {
    await page.goto("/planes");

    // OJO: los nombres de plan se repiten abajo, en Club Elite. Todo se acota a
    // la sección de tarifas (#Planes) para no chocar con el modo estricto.
    const tarifas = page.locator("#Planes");

    for (const nombre of ["PLAN BÁSICO", "PLAN PREMIUM", "PLAN MASTER"]) {
      await expect(tarifas.getByRole("heading", { name: nombre })).toBeVisible();
    }

    // El precio sale del CMS (colección `plans`) con fallback estático, así que
    // NO se afirma una cifra concreta: se afirma que el interruptor la cambia.
    const tarjeta = tarifas.getByRole("heading", { name: "PLAN BÁSICO" }).locator("xpath=../..");
    const precioMensual = await tarjeta.getByText(/^\$[\d,]+$/).first().innerText();

    const interruptor = tarifas.getByRole("switch", { name: /mensuales y anuales/i });
    await expect(interruptor).toHaveAttribute("aria-checked", "false");
    await interruptor.click();
    await expect(interruptor).toHaveAttribute("aria-checked", "true");

    await expect
      .poll(async () => tarjeta.getByText(/^\$[\d,]+$/).first().innerText())
      .not.toBe(precioMensual);
  });
});

test.describe("Despertar — descargas y captura de correo", { tag: ["@ui", "@publico"] }, () => {
  // D2: la descarga de los Vols 0-2 es LIBRE (sin registro). Si algún día
  // alguien mete una barrera antes del PDF, esto falla.
  test("los 3 volúmenes gratuitos ofrecen PDF y audio", async ({ page }) => {
    await page.goto("/despertar");
    await expect(page.getByRole("link", { name: /Descargar/i })).toHaveCount(3);
    await expect(page.getByRole("link", { name: /Audio/i })).toHaveCount(3);
  });

  // Este sí sale a internet (Firebase Storage). Si la suite corre sin red,
  // sáltalo con:  npx playwright test --grep-invert @red
  test("los archivos de los volúmenes existen @red", async ({ page, request }) => {
    await page.goto("/despertar");
    // `evaluateAll` NO reintenta: corre una sola vez y contra el DOM tal como
    // esté. Hay que esperar con una aserción que sí reintente antes de leer.
    const enlaces = page.getByRole("link", { name: /Descargar|Audio/i });
    await expect(enlaces).toHaveCount(6);

    const urls = await enlaces.evaluateAll((as) => as.map((a) => a.href));
    for (const url of urls) {
      const resp = await request.head(url);
      expect(resp.status(), `no responde: ${url}`).toBe(200);
    }
  });

  test("el formulario de correo valida y registra al prospecto", async ({ page }) => {
    await page.goto("/despertar");

    await page.getByRole("button", { name: /Recíbelos en tu correo/i }).click();
    const campo = page.getByLabel(/Tu correo electrónico/i);
    await expect(campo).toBeVisible();

    // Correo inválido: el error se comunica con TEXTO, no solo con el borde rojo.
    await campo.fill("noesuncorreo");
    await page.getByRole("button", { name: /Enviármelos/i }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(campo).toHaveAttribute("aria-invalid", "true");

    // Correo válido y ÚNICO por corrida: la prueba crea su propio dato y el
    // endpoint es idempotente por correo, así que no ensucia corridas previas.
    const unico = `qa-vols-${Date.now()}@ccc.test`;
    await campo.fill(unico);
    await page.getByRole("button", { name: /Enviármelos/i }).click();

    // El mensaje de éxito NO promete entrega inmediata: el envío real llega con
    // el motor de goteo (Fase 3/Brevo). Hoy solo se registra el prospecto.
    await expect(page.getByRole("status")).toContainText(/quedó registrado/i);
  });
});
