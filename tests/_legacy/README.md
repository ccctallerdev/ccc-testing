# tests/_legacy — la suite anterior

Estos specs se movieron aquí el **26-ago-2026**. No están rotos y no son
basura: cubren reglas de negocio reales y muchos siguen pasando. Pero **no
sirven como red de seguridad**, y conviene entender por qué antes de confiar
en un ✅ suyo.

## El problema: pasan aunque la pantalla esté rota

Casi todos siembran y avanzan el flujo **por API**, y solo usan la interfaz
para un par de comprobaciones al final. Eso los hace rápidos y estables, pero
también **ciegos**: si mañana el formulario de alta de vehículo deja de
guardar, o el botón de aprobar desaparece, estos tests siguen en verde. Lo
que prueban es el backend, no el producto que usa el taller.

Además se saltan pasos del ciclo. Un ejemplo real que costó una tarde: varios
aprueban una cotización con `PUT /entries/:id { approvalState: "APROBADA" }`,
que marca el estado pero **no pasa por `applyApprovedSelection`** — la función
que de verdad genera la cotización oficial, reserva inventario y calcula
faltantes. El test pasa, el flujo real no ocurrió, y el siguiente paso
(Abastecimiento) se queda sin nada que hacer.

## Otras dos cosas que hay que saber

**20 de ellos están atados a los emuladores.** Llaman directo a la API REST
del emulador de Auth para crear usuarios o leer el `oobCode` del correo de
activación. Contra refac fallan siempre, y eso **no** es una regresión.
Para identificarlos:

```powershell
Select-String -Path tests\_legacy\<area>\*.spec.js -Pattern "AUTH_EMU|identitytoolkit|oobCode" -List
```

**Casi todos asumen la semilla local.** Traen `ID_WORKSHOP = "taller-prueba"`
y `MECHANIC_ID = "mecanico-prueba"` por default. Contra QA hay que pasarles el
taller real o el middleware multitenant responde `403 "No tienes acceso a los
datos de ese taller"` a absolutamente todo.

## Cómo correrlos (siguen funcionando)

Los comandos de siempre no cambiaron; solo cambió dónde viven los archivos:

```powershell
npm run test:comercial
npm run test:operacion
# ...etc
```

Contra QA hay que agregar el taller:

```powershell
$env:BASE_URL="https://ccc-frontend-qa.vercel.app"
$env:API="https://v1-hirpfgw7sa-uc.a.run.app/v1"
$env:SEED_EMAIL="..."; $env:SEED_PASSWORD="..."
$env:ID_WORKSHOP="<el taller real>"   # ← imprescindible
$env:SKIP_SEED="1"
npm run test:comercial
```

## Qué hacer con ellos

**No borrarlos.** Documentan reglas de negocio que costó descubrir (Q3, Q4,
Q31, unicidad de identidad, candados del undo-alta) y siguen siendo útiles
como pruebas de API rápidas.

Lo que corresponde es **completarlos, no reemplazarlos**: cada uno debería
tener su contraparte de UI. Ver la estrategia híbrida en `BACKLOG_TECNICO.md`
y en `tests/README.md`. Conforme una funcionalidad reciba su prueba de UI, su
spec de API puede volver de `_legacy/` a la suite viva.

## Lo que las reemplaza mientras tanto

| Carpeta | Qué hace |
|---|---|
| `tests/e2e_v2/` | El ciclo completo **por interfaz**, sin un solo atajo por API. Es la que sí detecta una regresión del front. |
| `tests/qa/` | Gemelos de 4 specs de aquí, adaptados para correr contra refac (Firebase real en vez de emuladores). |
| `tests/demo/` | Recorridos para presentar en vivo, con pausa real para la aprobación desde el celular. |
