# Cómo están organizadas las pruebas

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
| `regresiones` | Fixes puntuales que no pertenecen a un área concreta. Si esta carpeta crece mucho, es señal de que hace falta un área nueva. | 1 |

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

**`regresiones/`**
- `fixes-generales.spec.js`
