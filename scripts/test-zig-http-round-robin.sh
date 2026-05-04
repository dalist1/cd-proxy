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
ACCOUNTS=(AAAAA-account BBBBB-account CCCCC-account)
for i in 0 1 2; do
  cat >"$AUTH_DIR/codex-$i.json" <<JSON
{"type":"codex","email":"u$i@example.test","account_id":"${ACCOUNTS[$i]}","access_token":"access-token-$i","refresh_token":"refresh-token-$i","expired":"2099-01-01T00:00:00Z","disabled":false}
JSON
done
MOCK_PORT=$((31000 + RANDOM % 1000))
PROXY_PORT=$((32000 + RANDOM % 1000))
cat >"$TMP/mock.ts" <<'TS'
const log = [];
const fail = new Set((process.env.FAIL_ACCOUNTS ?? '').split(',').filter(Boolean));
Bun.serve({ host: '127.0.0.1', port: Number(process.env.MOCK_PORT), fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === '/__health') return Response.json({ ok: true });
  if (url.pathname === '/__log') return Response.json(log);
  const account = req.headers.get('chatgpt-account-id');
  log.push(account);
  if (fail.has(account ?? '')) return Response.json({ error: 'forced 429', account }, { status: 429 });
  return Response.json({ account, auth: req.headers.get('authorization') });
}});
TS
MOCK_PORT="$MOCK_PORT" FAIL_ACCOUNTS="BBBBB-account" bun "$TMP/mock.ts" >/tmp/cd-proxy-zig-mock.out 2>/tmp/cd-proxy-zig-mock.err & mock_pid=$!
for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$MOCK_PORT/__health" >/dev/null 2>&1 && break; sleep 0.1; done
zig build -Doptimize=Debug -p "$ROOT/zig-out" >/dev/null
CD_PROXY_HOST=127.0.0.1 \
CD_PROXY_PORT="$PROXY_PORT" \
CD_PROXY_AUTH_DIR="$AUTH_DIR" \
CD_PROXY_API_KEY=zig-test-key \
CD_PROXY_UPSTREAM_BASE="http://127.0.0.1:$MOCK_PORT" \
"$ROOT/zig-out/bin/cd-proxy-zig" --serve >/tmp/cd-proxy-zig-proxy.out 2>/tmp/cd-proxy-zig-proxy.err & proxy_pid=$!
for _ in $(seq 1 50); do curl -fsS -H 'Authorization: Bearer zig-test-key' "http://127.0.0.1:$PROXY_PORT/health" >/dev/null 2>&1 && break; sleep 0.1; done
mapfile -t returned < <(for _ in 0 1 2; do curl -fsS -H 'Authorization: Bearer zig-test-key' -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$PROXY_PORT/v1/responses" | bun -e 'const j=await new Response(Bun.stdin.stream()).json(); console.log(j.account)'; done)
expected=(AAAAA-account CCCCC-account AAAAA-account)
if [[ "${returned[*]}" != "${expected[*]}" ]]; then
  echo "returned mismatch: ${returned[*]}" >&2
  cat /tmp/cd-proxy-zig-proxy.err >&2
  exit 1
fi
log="$(curl -fsS "http://127.0.0.1:$MOCK_PORT/__log")"
case "$log" in
  *AAAAA-account*BBBBB-account*CCCCC-account*) ;;
  *) echo "upstream tried sequence missing failed account: $log" >&2; exit 1 ;;
esac
echo "pure Zig HTTP round-robin failover test: PASS"
