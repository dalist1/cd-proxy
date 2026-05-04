#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() {
  echo "native implementation assertion failed: $*" >&2
  exit 1
}

# Runtime code must not shell out to another process to handle requests.
if grep -RInE 'child_process|Bun\.spawn|spawn\(|execFile|exec\(' src package.json systemd build.zig zig-src | grep -v 'std\.Thread\.spawn' >/tmp/cd-proxy-native-spawn.$$; then
  cat /tmp/cd-proxy-native-spawn.$$ >&2
  rm -f /tmp/cd-proxy-native-spawn.$$
  fail "runtime path contains process-spawning patterns; cd-proxy must proxy natively in-process"
fi
rm -f /tmp/cd-proxy-native-spawn.$$

# Runtime configuration must not point at the retired local proxy port.
if grep -RInE '127\.0\.0\.1:8317|localhost:8317|\[::1\]:8317|:8317/v1' \
  src package.json systemd .env.example build.zig zig-src | grep -v 'NATIVE_ASSERT_ALLOW' >/tmp/cd-proxy-native-wrapper.$$; then
  cat /tmp/cd-proxy-native-wrapper.$$ >&2
  rm -f /tmp/cd-proxy-native-wrapper.$$
  fail "runtime configuration appears to wrap or target a retired local proxy"
fi
rm -f /tmp/cd-proxy-native-wrapper.$$

# Auth must also be native: no delegating login to an external CLI.
if grep -RInE 'codex login|CODEX_HOME=.*codex' \
  scripts/codex-login-to-cd-proxy.sh scripts/codex-oauth-login.ts src package.json systemd >/tmp/cd-proxy-native-auth.$$; then
  cat /tmp/cd-proxy-native-auth.$$ >&2
  rm -f /tmp/cd-proxy-native-auth.$$
  fail "auth path appears to delegate to an external CLI; cd-proxy auth must be native"
fi
rm -f /tmp/cd-proxy-native-auth.$$

# The native Bun runtime and Zig helper/checker must keep using the real Codex backend as their default upstream.
grep -q 'DEFAULT_CHATGPT_CODEX_BASE = "https://chatgpt.com/backend-api/codex"' src/server.ts \
  || fail "Bun runtime default upstream is not the native ChatGPT Codex backend"
grep -q 'DEFAULT_CHATGPT_CODEX_BASE = "https://chatgpt.com/backend-api/codex"' zig-src/main.zig \
  || fail "pure Zig default upstream is not the native ChatGPT Codex backend"
grep -q 'ExecStart=%h/.bun/bin/bun run src/server.ts' systemd/cd-proxy.service \
  || fail "default service template must run Bun cd-proxy for fastest WebSocket runtime"

grep -q 'scope: "openid email profile offline_access"' src/codex-auth.ts \
  || fail "native Codex OAuth authorization scope changed"
grep -q 'scope: "openid profile email"' src/codex-auth.ts \
  || fail "native Codex refresh scope changed"

grep -q '"transport"[[:space:]]*:[[:space:]]*"websocket"' .pi/settings.json \
  || fail "Pi project settings must force websocket transport to disable SSE fallback"

echo "ok: cd-proxy runtime/auth are native; default service uses Bun for WebSocket speed; Pi transport forces websocket (no SSE fallback)"
