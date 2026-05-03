#!/usr/bin/env bash
set -euo pipefail
SRC="${CLIPROXY_AUTH_DIR:-$HOME/.local/share/cliproxyapi/auths}"
DST="${CD_PROXY_AUTH_DIR:-$HOME/.local/share/cd-proxy/auths}"
mkdir -p "$DST"
chmod 700 "$DST"
count=0
shopt -s nullglob
for f in "$SRC"/codex-*.json; do
  cp -p "$f" "$DST/"
  chmod 600 "$DST/$(basename "$f")"
  count=$((count + 1))
done
if [[ "${IMPORT_CODEX_HOME:-0}" == "1" ]]; then
  CD_PROXY_AUTH_DIR="$DST" bun run "$(dirname "$0")/import-codex-auth.ts"
fi
echo "mirrored $count cliproxy codex credential(s) from $SRC to $DST"
