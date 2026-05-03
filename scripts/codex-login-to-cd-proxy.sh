#!/usr/bin/env bash
set -euo pipefail
DEST="${CD_PROXY_AUTH_DIR:-$HOME/.local/share/cd-proxy/auths}"
mkdir -p "$DEST"
chmod 700 "$DEST"
CD_PROXY_AUTH_DIR="$DEST" bun run "$(dirname "$0")/codex-oauth-login.ts" "$@"
if systemctl --user is-active --quiet cd-proxy.service; then
  systemctl --user restart cd-proxy.service
fi
