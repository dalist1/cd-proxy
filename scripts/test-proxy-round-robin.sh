#!/usr/bin/env bash
set -euo pipefail
MOCK_PORT="${CD_PROXY_TEST_MOCK_PORT:-18444}"
PROXY_PORT="${CD_PROXY_TEST_PROXY_PORT:-8320}"
AUTH_DIR="${CD_PROXY_AUTH_DIR:-$HOME/.local/share/cd-proxy/auths}"
API_KEY="${CD_PROXY_API_KEY:-$(cat "${CD_PROXY_API_KEY_FILE:-$HOME/.config/cd-proxy/api-key}")}"
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
bun -e '
const key = process.argv[1];
const port = process.argv[2];
const accounts = [];
for (let i = 0; i < 14; i++) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`request ${i} failed: ${res.status} ${await res.text()}`);
  accounts.push((await res.json()).account);
}
for (const [i, a] of accounts.entries()) console.log(i, a ? `${a.slice(0, 5)}…${a.slice(-4)}` : null);
if (JSON.stringify(accounts.slice(0, 7)) !== JSON.stringify(accounts.slice(7, 14))) {
  throw new Error("first seven routed accounts did not repeat");
}
console.log("actual proxy round-robin ok: first 7 routed accounts repeat");
' "$API_KEY" "$PROXY_PORT"
