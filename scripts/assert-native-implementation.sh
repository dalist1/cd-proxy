#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() {
  echo "native implementation assertion failed: $*" >&2
  exit 1
}

# Runtime code must not shell out to cliproxy or any other process to handle requests.
if grep -RInE 'child_process|Bun\.spawn|spawn\(|execFile|exec\(' src package.json systemd build.zig zig-src >/tmp/cd-proxy-native-spawn.$$; then
  cat /tmp/cd-proxy-native-spawn.$$ >&2
  rm -f /tmp/cd-proxy-native-spawn.$$
  fail "runtime path contains process-spawning patterns; cd-proxy must proxy natively in-process"
fi
rm -f /tmp/cd-proxy-native-spawn.$$

# Runtime configuration must not point to the global cliproxy service on its default port.
if grep -RInE '127\.0\.0\.1:8317|localhost:8317|\[::1\]:8317|:8317/v1|cliproxyapi\.service|ExecStart=.*cliproxy' \
  src package.json systemd .env.example build.zig zig-src | grep -v 'NATIVE_ASSERT_ALLOW' >/tmp/cd-proxy-native-wrapper.$$; then
  cat /tmp/cd-proxy-native-wrapper.$$ >&2
  rm -f /tmp/cd-proxy-native-wrapper.$$
  fail "runtime configuration appears to wrap or target global cliproxy"
fi
rm -f /tmp/cd-proxy-native-wrapper.$$

# Auth must also be native: no delegating login to Codex CLI or CLIProxyAPI/cliproxy.
if grep -RInE 'codex login|CODEX_HOME=.*codex|CLIProxyAPI -config|cliproxyapi\.service' \
  scripts/codex-login-to-cd-proxy.sh scripts/codex-oauth-login.ts src package.json systemd >/tmp/cd-proxy-native-auth.$$; then
  cat /tmp/cd-proxy-native-auth.$$ >&2
  rm -f /tmp/cd-proxy-native-auth.$$
  fail "auth path appears to delegate to codex CLI or CLIProxyAPI; cd-proxy auth must be native"
fi
rm -f /tmp/cd-proxy-native-auth.$$

# The native implementation must keep using the real Codex backend as its default upstream.
grep -q 'DEFAULT_CHATGPT_CODEX_BASE = "https://chatgpt.com/backend-api/codex"' src/server.ts \
  || fail "default upstream is not the native ChatGPT Codex backend"

grep -q 'scope: "openid email profile offline_access"' src/codex-auth.ts \
  || fail "native Codex OAuth authorization scope does not match CLIProxyAPI"
grep -q 'scope: "openid profile email"' src/codex-auth.ts \
  || fail "native Codex refresh scope does not match CLIProxyAPI"

grep -q '"transport"[[:space:]]*:[[:space:]]*"websocket"' .pi/settings.json \
  || fail "Pi project settings must force websocket transport to disable SSE fallback"

echo "ok: cd-proxy runtime and auth are native; Pi transport forces websocket (no SSE fallback)"
