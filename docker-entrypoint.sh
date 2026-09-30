#!/bin/sh
# OrbitaOs - entrypoint: corrige permisos del volumen de sesion, borra los
# locks de Chromium de una ejecucion anterior y baja a "node" con gosu.
set -e

SESSION_PATH="${SESSION_PATH:-/app/session}"
PROFILE_DIR="$SESSION_PATH/session-orbitaos"

echo "[entrypoint] preparando $SESSION_PATH"

# 1) Ownership: el volumen queda del usuario que corre la app.
mkdir -p "$SESSION_PATH" "$PROFILE_DIR"
chown -R node:node "$SESSION_PATH" 2>/dev/null || \
  echo "[entrypoint] aviso: no se pudo ajustar el owner (sigue adelante)"

# 2) Locks de Chromium. Singleton* son symlinks y algunos quedan rotos, por lo
#    que [ -e ] no los ve: hay que listarlos y borrarlos uno por uno.
for lock in "$PROFILE_DIR"/Singleton*; do
  [ -e "$lock" ] || [ -L "$lock" ] || continue
  if rm -f "$lock" 2>/dev/null; then
    echo "[entrypoint] lock eliminado: $(basename "$lock")"
  else
    echo "[entrypoint] aviso: no se pudo borrar $(basename "$lock")"
  fi
done

# 3) Permisos de escritura para el usuario node.
chmod -R u+rwX "$SESSION_PATH" 2>/dev/null || true

echo "[entrypoint] listo, ejecutando como $(id -un)"
exec gosu node "$@"
