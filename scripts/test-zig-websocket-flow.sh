#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
cleanup() {
  kill "${mock_pid:-}" "${proxy_pid:-}" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT
AUTH_DIR="$TMP/auths"
mkdir -p "$AUTH_DIR"
ACCOUNTS=(AAAAA-ws-account BBBBB-ws-account)
for i in 0 1; do
  cat >"$AUTH_DIR/codex-$i.json" <<JSON
{"type":"codex","email":"u$i@example.test","account_id":"${ACCOUNTS[$i]}","access_token":"access-token-$i","refresh_token":"refresh-token-$i","expired":"2099-01-01T00:00:00Z","disabled":false}
JSON
done
MOCK_PORT=$((35000 + RANDOM % 1000))
PROXY_PORT=$((36000 + RANDOM % 1000))
cat >"$TMP/mock-ws.ts" <<'TS'
const log = [];
const fail = new Set((process.env.FAIL_UPGRADE_ACCOUNTS ?? '').split(',').filter(Boolean));
Bun.serve({ host: '127.0.0.1', port: Number(process.env.MOCK_PORT), fetch(req, server) {
  const url = new URL(req.url);
  if (url.pathname === '/__health') return Response.json({ ok: true });
  if (url.pathname === '/__log') return Response.json(log);
  const account = req.headers.get('chatgpt-account-id');
  log.push({ account, beta: req.headers.get('openai-beta') });
  if (fail.has(account ?? '')) return new Response('forced upgrade failure', { status: 429 });
  if (server.upgrade(req, { data: { account } })) return;
  return new Response('upgrade failed', { status: 400 });
}, websocket: {
  message(ws, msg) { ws.send(JSON.stringify({ type: 'response.completed', account: ws.data.account, got: String(msg) })); },
}});
TS
MOCK_PORT="$MOCK_PORT" FAIL_UPGRADE_ACCOUNTS="BBBBB-ws-account" bun "$TMP/mock-ws.ts" >/tmp/cd-proxy-zig-ws-mock.out 2>/tmp/cd-proxy-zig-ws-mock.err & mock_pid=$!
for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$MOCK_PORT/__health" >/dev/null 2>&1 && break; sleep 0.1; done
zig build -Doptimize=Debug -p "$ROOT/zig-out" >/dev/null
CD_PROXY_HOST=127.0.0.1 \
CD_PROXY_PORT="$PROXY_PORT" \
CD_PROXY_AUTH_DIR="$AUTH_DIR" \
CD_PROXY_API_KEY=zig-ws-test-key \
CD_PROXY_UPSTREAM_BASE="http://127.0.0.1:$MOCK_PORT" \
"$ROOT/zig-out/bin/cd-proxy-zig" --serve >/tmp/cd-proxy-zig-ws-proxy.out 2>/tmp/cd-proxy-zig-ws-proxy.err & proxy_pid=$!
for _ in $(seq 1 50); do curl -fsS -H 'Authorization: Bearer zig-ws-test-key' "http://127.0.0.1:$PROXY_PORT/health" >/dev/null 2>&1 && break; sleep 0.1; done
mapfile -t returned < <(for msg in one two; do bun -e '
const port=process.argv[1], msg=process.argv[2];
const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`, { headers: { authorization: "Bearer zig-ws-test-key", "openai-beta": "responses_websockets=2026-02-06" } });
const timer = setTimeout(() => { console.error("timeout"); process.exit(2); }, 5000);
ws.onopen = () => ws.send(msg);
ws.onmessage = (event) => { clearTimeout(timer); const j = JSON.parse(String(event.data)); console.log(j.account); ws.close(); };
ws.onerror = () => { clearTimeout(timer); process.exit(1); };
' "$PROXY_PORT" "$msg"; done)
expected=(AAAAA-ws-account AAAAA-ws-account)
if [[ "${returned[*]}" != "${expected[*]}" ]]; then
  echo "returned mismatch: ${returned[*]}" >&2
  cat /tmp/cd-proxy-zig-ws-proxy.err >&2
  exit 1
fi
log="$(curl -fsS "http://127.0.0.1:$MOCK_PORT/__log")"
case "$log" in
  *AAAAA-ws-account*BBBBB-ws-account*AAAAA-ws-account*) ;;
  *) echo "upstream WS tried sequence missing failed account: $log" >&2; exit 1 ;;
esac
echo "pure Zig websocket flow/failover test: PASS"
