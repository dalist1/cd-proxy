#!/usr/bin/env bash
set -euo pipefail
MOCK_PORT="${CD_PROXY_TEST_MOCK_PORT:-18444}"
PROXY_PORT="${CD_PROXY_TEST_PROXY_PORT:-8320}"
AUTH_DIR="${CD_PROXY_AUTH_DIR:-$HOME/.local/share/cd-proxy/auths}"
API_KEY="${CD_PROXY_API_KEY:-$(cat "${CD_PROXY_API_KEY_FILE:-$HOME/.config/cliproxyapi/api-key}")}"
mock="$(mktemp --suffix=.ts)"
cat >"$mock" <<TS
Bun.serve({host:'127.0.0.1', port:$MOCK_PORT, fetch(req) {
  return new Response(JSON.stringify({ account: req.headers.get('chatgpt-account-id') }), {headers:{'content-type':'application/json'}})
}})
TS
bun "$mock" >/tmp/cd-proxy-mock.out 2>/tmp/cd-proxy-mock.err & mock_pid=$!
CD_PROXY_PORT="$PROXY_PORT" CD_PROXY_AUTH_DIR="$AUTH_DIR" CD_PROXY_UPSTREAM_BASE="http://127.0.0.1:$MOCK_PORT" bun run src/server.ts >/tmp/cd-proxy-rr.out 2>/tmp/cd-proxy-rr.err & proxy_pid=$!
cleanup(){ kill "$proxy_pid" "$mock_pid" 2>/dev/null || true; rm -f "$mock"; }
trap cleanup EXIT
sleep 1
python3 - "$API_KEY" "$PROXY_PORT" <<'PY'
import json, subprocess, sys
key, port = sys.argv[1:3]
accounts=[]
for _ in range(14):
    out=subprocess.check_output(['curl','-fsS','-H',f'Authorization: Bearer {key}','-H','content-type: application/json','-d','{}',f'http://127.0.0.1:{port}/v1/responses'])
    accounts.append(json.loads(out)['account'])
for i,a in enumerate(accounts): print(i, (a[:5]+'…'+a[-4:]) if a else None)
assert accounts[:7] == accounts[7:14], 'first seven routed accounts did not repeat'
print('actual proxy round-robin ok: first 7 routed accounts repeat')
PY
