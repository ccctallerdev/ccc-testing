#!/usr/bin/env bash
#
# limpiar-ramas.sh — Borra ramas git inactivas
#
# LOCALES: se borran las que tienen N días o más sin commits (default 30).
# REMOTAS (origin): se borran las que YA FUERON MERGEADAS a la rama base,
#                    o las que tienen N días o más sin commits.
#
# Nunca toca la rama protegida, ni la rama actual, ni la rama base
# (main/master/develop, la que use tu repo).
#
# Uso:
#   ./limpiar-ramas.sh                # dry-run (solo muestra qué borraría)
#   ./limpiar-ramas.sh ejecutar       # borra de verdad
#   ./limpiar-ramas.sh ejecutar 45    # borra de verdad, umbral de 45 días
#
# Correr desde la raíz del repo (donde está la carpeta .git).

set -euo pipefail

MODO="${1:-dry-run}"
DIAS_INACTIVIDAD="${2:-30}"

# Ramas que nunca se tocan, sin importar antigüedad ni merge.
RAMAS_PROTEGIDAS=(
  main master develop
  prod-api prod-front prod-mobile
  dev-api dev-front dev-mobile
  qa-api qa-front qa-mobile
)

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: esto no es un repo git. Corre el script desde la raíz de tu repo." >&2
  exit 1
fi

es_protegida() {
  local rama="$1"
  for p in "${RAMAS_PROTEGIDAS[@]}"; do
    [[ "$rama" == "$p" ]] && return 0
  done
  return 1
}

rama_actual="$(git branch --show-current)"
ahora="$(date +%s)"

echo "=================================================================="
echo " Umbral de inactividad: ${DIAS_INACTIVIDAD} días"
echo " Modo: ${MODO}"
echo "=================================================================="
echo ""
echo "--- Ramas LOCALES con ${DIAS_INACTIVIDAD}+ días de inactividad ---"
echo ""

local_borradas=0
while IFS='|' read -r rama fecha; do
  [[ -z "$rama" ]] && continue
  [[ "$rama" == "$rama_actual" ]] && continue
  es_protegida "$rama" && continue

  dias=$(( (ahora - fecha) / 86400 ))
  if (( dias >= DIAS_INACTIVIDAD )); then
    echo "  [LOCAL]  $rama  (${dias} días sin commits)"
    if [[ "$MODO" == "ejecutar" ]]; then
      git branch -D "$rama"
    fi
    local_borradas=$((local_borradas + 1))
  fi
done < <(git for-each-ref --sort=committerdate refs/heads/ --format='%(refname:short)|%(committerdate:unix)')

if (( local_borradas == 0 )); then
  echo "  (ninguna)"
fi

echo ""
echo "--- Ramas REMOTAS (origin) mergeadas o con ${DIAS_INACTIVIDAD}+ días de inactividad ---"
echo ""

git fetch --prune origin >/dev/null 2>&1 || true

rama_base="$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || true)"
if [[ -z "$rama_base" ]]; then
  rama_base="main"
fi

mergeadas="$(git branch -r --merged "origin/${rama_base}" 2>/dev/null | sed 's/^[* ]*//' | grep '^origin/' | sed 's@^origin/@@' || true)"

remotas_borradas=0
while IFS='|' read -r ref fecha; do
  [[ -z "$ref" ]] && continue
  rama="${ref#origin/}"
  [[ "$rama" == "HEAD" ]] && continue
  [[ "$rama" == "$rama_base" ]] && continue
  es_protegida "$rama" && continue

  esta_mergeada=false
  if grep -qx "$rama" <<< "$mergeadas"; then
    esta_mergeada=true
  fi

  dias=$(( (ahora - fecha) / 86400 ))

  if $esta_mergeada || (( dias >= DIAS_INACTIVIDAD )); then
    if $esta_mergeada; then
      motivo="mergeada a ${rama_base}"
    else
      motivo="${dias} días sin commits"
    fi
    echo "  [REMOTA] $rama  (${motivo})"
    if [[ "$MODO" == "ejecutar" ]]; then
      git push origin --delete "$rama"
    fi
    remotas_borradas=$((remotas_borradas + 1))
  fi
done < <(git for-each-ref --sort=committerdate refs/remotes/origin/ --format='%(refname:short)|%(committerdate:unix)')

if (( remotas_borradas == 0 )); then
  echo "  (ninguna)"
fi

echo ""
echo "=================================================================="
if [[ "$MODO" != "ejecutar" ]]; then
  echo " Esto fue un DRY-RUN, no se borró nada todavía."
  echo " Para borrar de verdad corre:"
  echo "     ./limpiar-ramas.sh ejecutar"
else
  echo " Listo. Locales borradas: ${local_borradas} | Remotas borradas: ${remotas_borradas}"
fi
echo "=================================================================="
