#!/usr/bin/env bash
set -euo pipefail
LOGIN_HOME="${CD_PROXY_CODEX_HOME:-$HOME/.local/share/cd-proxy/codex-home}"
DEST="${CD_PROXY_AUTH_DIR:-$HOME/.local/share/cd-proxy/auths}"
mkdir -p "$LOGIN_HOME" "$DEST"
chmod 700 "$LOGIN_HOME" "$DEST"
for arg in "$@"; do
  if [[ "$arg" == "--with-api-key" ]]; then
    echo "cd-proxy Codex backend uses ChatGPT/Codex OAuth, not API-key auth. Use browser login or --device-auth." >&2
    exit 2
  fi
done
CODEX_HOME="$LOGIN_HOME" codex login "$@"
CD_PROXY_AUTH_DIR="$DEST" bun run "$(dirname "$0")/import-codex-auth.ts" "$LOGIN_HOME/auth.json"
if systemctl --user is-active --quiet cd-proxy.service; then
  systemctl --user restart cd-proxy.service
fi
echo "Imported Codex OAuth login into $DEST"
