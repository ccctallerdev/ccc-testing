# Cómo están organizadas las pruebas

> ## ⚠️ Reorganización del 26-ago-2026 — léelo antes de confiar en un ✅
>
> La suite anterior se movió a **`tests/_legacy/`**. No está rota, pero
> **prueba el backend, no el producto**: siembra y avanza el flujo por API y
> solo mira la pantalla al final, así que pasa en verde aunque el formulario
> esté roto. El detalle y los casos concretos, en `tests/_legacy/README.md`.
>
> Los comandos (`npm run test:comercial`, etc.) siguen funcionando igual.
>
> **La suite viva hoy:**
>
> | Carpeta | Comando | Qué cubre |
> |---|---|---|
> | `e2e_v2/` | `npm run test:e2e2` | El ciclo completo **por interfaz**, sin atajos por API. La que sí detecta una regresión del front. |
> | `qa/` | `npm run test:qa` | Gemelos para refac de specs que en `_legacy` están atados a emuladores. |
> | `demo/` | `npm run test:demo` | Recorridos para presentar en vivo, con pausa real de aprobación móvil. |
>
> **Para funcionalidades nuevas: pruebas HÍBRIDAS.** Una de API para las
> reglas y los casos borde, y una de UI para el camino feliz de cada pantalla
> que toque. Ninguna de las dos sola basta — la de API no ve la pantalla, y la
> de UI es demasiado lenta y frágil para cubrir todos los casos. La regla y el
> porqué están en `BACKLOG_TECNICO.md`.


Dos ejes, para poder correr justo lo que necesitas:

- **Carpetas = áreas del producto.** Cada una es un `project` de Playwright.
- **Etiquetas = tipo de prueba.** Cruzan todas las áreas.

## Áreas

| Carpeta | Qué cubre | Specs |
|---|---|---|
| `publico` | Sitio público del embudo. NO requiere sesión ni semillas: basta el frontend en :3000 (y el backend para el formulario de correo). | 1 |
| `acceso` | Entrada al sistema: que la app cargue, la matriz de roles y permisos, y la configuración persistida. | 3 |
| `operacion` | El ciclo del taller de punta a punta: recepción → hoja → diagnóstico → costeo → producción → entrega. Aquí viven las pruebas largas. | 8 |
| `comercial` | Todo lo que mira al cliente: alta y afiliación, folios, aprobación de cotizaciones y los documentos que se imprimen. | 5 |
| `abastecimiento` | Compras, órdenes al proveedor, recepción de refacciones e inventario. | 2 |
| `direccion` | Lo que ve quien dirige: Centro de Control, contadores por fase y garantías. | 3 |
| `marketing` | El CMS del sitio público (Fase 2): API de contenido por página, blindaje TECH_SUPPORT, media y volúmenes. Necesita emuladores + API en :3001. | 1 |
| `regresiones` | Fixes puntuales que no pertenecen a un área concreta. Si esta carpeta crece mucho, es señal de que hace falta un área nueva. | 1 |
| `demo` | Recorridos para Demo Day: mismos flujos que ya cubre la suite, pero pensados para que un humano los vea correr (headed, `slowMo`, video siempre). **No es regresión** — no lo corras dentro de `npm test`, solo con `npm run test:demo` (o `npm run test:demo:aprobacion` para el recorrido con pausa de aprobación móvil, o `npm run test:demo:multirol` para el punta a punta por roles contra QA). | 3 |

```powershell
npm run test                 # todo (23 specs)
npm run test:operacion       # solo una carpeta
npx playwright test --project=abastecimiento
```

## Etiquetas

| Etiqueta | Significa |
|---|---|
| `@api` | Pega a la API con `request`, sin abrir navegador. Rápidas. |
| `@ui` | Abre el navegador. Más lentas y más frágiles a cambios de diseño. |
| `@lento` | Ciclos completos de punta a punta: minutos, no segundos. |
| `@humo` | Arranque mínimo: ¿la app siquiera levanta? |
| `@publico` | Sitio anónimo: no necesita sesión ni semillas. |
| `@red` | Sale a internet (Firebase Storage). Falla sin conexión. |

```powershell
npm run test:api             # solo API, sin navegador
npm run test:rapido          # todo menos @lento y @red
npm run test:sin-red         # todo menos lo que sale a internet
npx playwright test --project=comercial --grep @api   # se combinan
```

## Reglas de la casa

1. **Todo spec vive en una carpeta de área.** Un `.spec.js` suelto en `tests/` no
   pertenece a ningún `project` y NO se ejecuta nunca. `global-setup` avisa si
   encuentra alguno, pero no lo mueve por ti.
2. **Cada test lleva `@api` o `@ui`**, y `@lento` si tarda minutos.
3. **Las pruebas crean sus propios datos.** Nada de depender de lo que dejó otra.
4. **Para llamar a la API usa `require("#apiToken")`**, no rutas relativas. Es un
   alias nativo de Node (campo `imports` de `package.json`) que resuelve desde
   cualquier profundidad de carpeta, así reorganizar `tests/` no vuelve a romper
   los imports. (`@` no sirve para esto: en Node ese prefijo es de npm.)

## Prerrequisitos

Salvo `publico`, todo necesita:

```powershell
cd ccc-backend ; npm run serve      # emuladores
cd ccc-backend ; npm run backend    # API en :3001
cd ccc-frontend ; npm start         # front en :3000
```

`global-setup` corre las semillas solo; si pides únicamente `--project=publico`,
las salta porque el sitio anónimo no toca la base.

### Correr `demo` contra producción en vez de emuladores

Los specs de `demo` usan las mismas variables de entorno que ya usa el resto
de la suite (no hace falta tocar código), apuntándolas a prod:

```powershell
$env:BASE_URL="https://controlcentralcar.com"
$env:API="https://v1-XXXXXX-uc.a.run.app/v1"   # la URL real de la función v1 en prod
$env:SEED_EMAIL="la-cuenta-de-prueba@..."
$env:SEED_PASSWORD="..."
$env:ID_WORKSHOP="idWorkshop-de-esa-cuenta"
$env:SKIP_SEED="1"   # sin esto, global-setup intenta sembrar en emuladores locales y truena si no están arriba
npm run test:demo
```

Las semillas (`seed_emulator_user.js` / `seed_prueba_e2e.js`) apuntan siempre
a `127.0.0.1` por código, así que NUNCA tocarían producción aunque
`SKIP_SEED` no estuviera — pero sin emuladores locales corriendo, fallan con
`ECONNREFUSED` antes de que el test arranque. `SKIP_SEED=1` evita eso.

### `recorrido-aprobacion-movil.spec.js` — pausa real para aprobar desde el celular

Variante de `demo` que además siembra un cliente CON CUENTA (`/clients/with-account`)
y se DETIENE de verdad (polling a la API, no `page.waitForTimeout`) hasta detectar
que la cotización fue aprobada desde la app móvil — tiempo de sobra para que el
presentador cambie de pantalla, active la cuenta del correo de activación y apruebe
a mano. Exporta además `DEMO_CLIENT_EMAIL` (usa uno real tuyo contra refac/prod
para poder abrir el correo de activación) y opcionalmente `DEMO_APPROVE_TIMEOUT_MS`
/ `DEMO_POLL_MS`. Detalle completo en los comentarios del spec.

Desde el 26-ago **ya no depende de emuladores**: se autentica con `qaAuth.js`
contra el Firebase real usando `SEED_EMAIL`/`SEED_PASSWORD` (define `AUTH_EMU`
si quieres que hable con el emulador). `MECHANIC_ID` pasó a ser opcional: si no
lo pasas, busca un mecánico del taller y, si no hay, asigna la OS al admin.

```powershell
npm run test:demo:aprobacion
```

### `recorrido-multirol-qa.spec.js` — punta a punta por roles, contra QA

El ciclo completo (recepción → diagnóstico → cotización → aprobación del
cliente → abastecimiento → reparación → entrega) pero **ejecutado por los 5
roles**, cerrando e iniciando sesión de verdad entre etapa y etapa.

Dos diferencias con `operacion/ciclo-completo.spec.js`:

- **No usa emuladores.** Se autentica contra el Firebase real de refac con
  `qaAuth.js` (raíz del repo), que inicia sesión por REST contra
  `identitytoolkit` y cachea un token POR USUARIO. La API key se toma de
  `FIREBASE_API_KEY` o, si no está, se lee sola de `ccc-frontend/.env`.
- **Cada acción va firmada por el rol que le toca**, no por el dueño. Si un
  rol no tuviera la capability, la API responde 403 y el test falla ahí: es
  un chequeo más fuerte que mirar si el botón aparece en pantalla. El cambio
  de sesión y la verificación de menús sí son por UI.

La primera corrida da de alta al equipo (gerente, asesor, compras, técnico)
desde la cuenta del dueño, con correos derivados del suyo
(`...-admin@` → `...-asesor@`) y contraseña `EQUIPO_PASSWORD` (default
`Demo1234`); las siguientes los reutiliza, así que es idempotente y las
credenciales sirven también para entrar a mano.

```powershell
$env:BASE_URL="https://ccc-frontend-qa.vercel.app"
$env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"
$env:ID_WORKSHOP="<idWorkshop del taller>"
$env:SEED_EMAIL="...-admin@gmail.com"; $env:SEED_PASSWORD="Demo1234"
$env:DEMO_CLIENT_EMAIL="rsv.cup@gmail.com"
$env:SKIP_SEED="1"
npm run test:demo:multirol
```

Para ensayarlo sin esperar el celular: `$env:SIN_PAUSA_MOVIL="1"`.
Si un teléfono choca con un usuario que ya existe, cambia `TEL_BASE`.

## Correr los specs de UI contra refac (QA) en vez de emuladores

Desde el 26-ago `apiToken.js` decide solo contra qué Firebase autenticarse:
si `API` apunta a localhost usa el emulador (comportamiento de siempre), y si
apunta a otra cosa usa el Firebase real. Con eso, buena parte de la suite se
puede correr contra QA sin tocar los specs.

```powershell
$env:BASE_URL="https://ccc-frontend-qa.vercel.app"
$env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"
$env:SEED_EMAIL="rsv.cup@gmail.com"; $env:SEED_PASSWORD="admin123"
$env:ID_WORKSHOP="05Pf5VZ7IGCbi6JA8ObU"   # ← IMPRESCINDIBLE
$env:SKIP_SEED="1"
npm run test:comercial      # o el área que quieras
```

**`ID_WORKSHOP` no es opcional.** Casi todos los specs traen
`ID_WORKSHOP = "taller-prueba"` por defecto (el taller de la semilla local).
Contra QA, el middleware multitenant responde
`403 "No tienes acceso a los datos de ese taller"` a TODO, porque el token es
de otro taller. Si ves ese 403 repetido, es esto — no es el front.

`MECHANIC_ID` (default `mecanico-prueba`) tiene el mismo problema en los
specs que lo usan: hay que pasar el uid de un mecánico real del taller.

### Los que NO pueden pasar contra QA (por diseño)

20 de los 56 specs llaman directo a la API REST del **emulador de Auth**
(crear usuarios de prueba, leer el `oobCode` del correo de activación,
etc.). Eso no existe en Firebase real, así que fallarán siempre contra QA y
no significan una regresión. En `comercial` son:
`alta-con-cuenta`, `cancelar-entrada`, `desafiliacion`, `editar-cliente` y
parte de `q3-aprobacion`.

Para saber si uno está en ese grupo:

```powershell
Select-String -Path tests\<area>\*.spec.js -Pattern "AUTH_EMU|identitytoolkit|oobCode" -List
```

### Cómo leer los fallos

| Síntoma | Qué significa |
|---|---|
| `403 No tienes acceso a los datos de ese taller` | Falta `ID_WORKSHOP` (o está mal). No es el front. |
| Falla buscando `taller-prueba`, `mecanico-prueba`, placas concretas | El spec asume la semilla local. Ajustar datos o correrlo en local. |
| Falla leyendo un `oobCode` / llamando a `127.0.0.1:9099` | Spec atado al emulador. No aplica contra QA. |
| **No encuentra un botón, un campo o un texto de la pantalla** | **Eso sí es una regresión del front.** |

## Mapa completo

**`publico/`**
- `landings-publicas.spec.js`

**`acceso/`**
- `smoke.spec.js`
- `roles-permisos.spec.js`
- `configuracion.spec.js`

**`operacion/`**
- `ciclo-completo.spec.js`
- `jornada-ui.spec.js`
- `jornada-entrega.spec.js`
- `flujo-costeo.spec.js`
- `q5-maquina-estados.spec.js`
- `q11-expediente.spec.js`
- `q15-produccion.spec.js`
- `produccion-mecanico.spec.js`

**`comercial/`**
- `q32-clientes-v2.spec.js`
- `q3-aprobacion.spec.js`
- `q4-numeracion.spec.js`
- `q31-conceptos.spec.js`
- `pdf-real.spec.js`

**`abastecimiento/`**
- `q2-recepcion-directa.spec.js`
- `flujo-20jul.spec.js`

**`direccion/`**
- `ccv2-centro-control.spec.js`
- `q14-contadores.spec.js`
- `q19-garantias.spec.js`

**`marketing/`**
- `cms-site-content.spec.js`

**`regresiones/`**
- `fixes-generales.spec.js`

**`demo/`**
- `recorrido-cliente.spec.js`
- `recorrido-aprobacion-movil.spec.js`
- `recorrido-multirol-qa.spec.js`
