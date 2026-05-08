# cd-proxy

Native Codex-only proxy in **Bun**, with **Zig** hot-path helpers.

- default/runtime path is Bun (`bun run start`) to keep WebSocket latency/throughput fastest
- default upstream is the real Codex backend: `https://chatgpt.com/backend-api/codex`
- browser OAuth, device-code OAuth, token refresh, credential storage, request handling, routing, retries, and WebSockets are implemented here

This project only implements Codex/ChatGPT OAuth token auth.

## Native auth

cd-proxy implements Codex OAuth credential handling directly:

- authorization endpoint: `https://auth.openai.com/oauth/authorize`
- authorization params: PKCE `S256`, `scope = openid email profile offline_access`, `prompt = login`, `id_token_add_organizations = true`, `codex_cli_simplified_flow = true`
- callback URI: `http://localhost:1455/auth/callback`
- token exchange endpoint: `https://auth.openai.com/oauth/token` with `application/x-www-form-urlencoded`
- refresh grant includes `scope = openid profile email`
- device flow uses `https://auth.openai.com/api/accounts/deviceauth/usercode`, `https://auth.openai.com/api/accounts/deviceauth/token`, then exchanges at the token endpoint with redirect `https://auth.openai.com/deviceauth/callback`
- credential files are native `codex-*.json` files stored under the cd-proxy auth dir

## What matches Codex upstream

ChatGPT/Codex API access uses:

- token refresh endpoint: `https://auth.openai.com/oauth/token`
- OAuth refresh grant form body:
  - `client_id = app_EMoamEEZ73f0CkXaXp7hrann`
  - `grant_type = refresh_token`
  - `refresh_token = ...`
  - `scope = openid profile email`
- upstream Codex backend base: `https://chatgpt.com/backend-api/codex`
- request auth headers:
  - `Authorization: Bearer <access_token>`
  - `ChatGPT-Account-ID: <account_id>` when present
  - `X-OpenAI-Fedramp: true` only for FedRAMP accounts (not enabled here unless added later)

## Bun proxy

```bash
bun run check
bun run start
```

Defaults:

- listen: `127.0.0.1:8318`
- auth dir: `~/.local/share/cd-proxy/auths`
- API key file: `~/.config/cd-proxy/api-key` (or set `CD_PROXY_API_KEY`; unauthenticated local use is allowed when no key is configured)

Create a local bearer key if you want client authorization enabled:

```bash
mkdir -p ~/.config/cd-proxy
openssl rand -hex 32 > ~/.config/cd-proxy/api-key
chmod 600 ~/.config/cd-proxy/api-key
```

Health check:

```bash
curl -H "Authorization: Bearer $(cat ~/.config/cd-proxy/api-key)" \
  http://127.0.0.1:8318/health
```

Models check:

```bash
curl -H "Authorization: Bearer $(cat ~/.config/cd-proxy/api-key)" \
  http://127.0.0.1:8318/v1/models
```

Supported proxy paths:

- `GET /v1/models` returns a static OpenAI-compatible model list
- `POST /v1/responses` proxies to `https://chatgpt.com/backend-api/codex/responses`
- `POST /v1/responses/compact` proxies to `https://chatgpt.com/backend-api/codex/responses/compact`
- `WS /v1/responses` proxies to `wss://chatgpt.com/backend-api/codex/responses` for OpenAI/Codex Responses WebSockets
- same paths without `/v1` are also accepted
- Pi/OpenAI-Codex-compatible `/codex/responses` and `/codex/responses/compact` are accepted too

Round-robin behavior:

1. Loads `codex-*.json` auth files from the cd-proxy auth dir.
2. Picks the next enabled credential for every HTTP request and WebSocket connection.
3. When cache/session affinity is enabled, requests with the same cache-affinity header (default: `session_id` or `x-session-affinity`) stick to the same credential while the affinity entry is valid, improving upstream prompt-cache hit rates.
4. Refreshes a credential before use if its expiry is near.
5. On HTTP `401`, refreshes and retries once before rotating away from that credential.
6. On retryable HTTP failures (`401,403,408,409,425,429,500,502,503,504` by default), cools that credential and retries the next account inside the same external request instead of surfacing that failure to the client.
7. For WebSockets, cd-proxy first opens the upstream Codex WebSocket with the selected account; if that handshake fails, it rotates to the next account before upgrading the client connection. Once connected, it freely pipes frames both ways; Codex headers such as `OpenAI-Beta: responses_websockets=2026-02-06`, `x-client-request-id`, `session_id`, and turn-state metadata are preserved.

Useful env vars:

```bash
CD_PROXY_HOST=127.0.0.1
CD_PROXY_PORT=8318
CD_PROXY_AUTH_DIR=~/.local/share/cd-proxy/auths
CD_PROXY_API_KEY_FILE=~/.config/cd-proxy/api-key
CD_PROXY_API_KEY=override-local-bearer-key
CD_PROXY_MAX_RETRY_CREDENTIALS=0     # 0/default means try every enabled credential before surfacing failure
CD_PROXY_COOLDOWN_MS=30000
CD_PROXY_RETRYABLE_HTTP_STATUSES=401,403,408,409,425,429,500,502,503,504
CD_PROXY_CACHE_AFFINITY=1                # keep same session/cache header on same credential for better prompt-cache hits
CD_PROXY_CACHE_AFFINITY_TTL_MS=1800000   # affinity lifetime (default 30 min)
CD_PROXY_CACHE_AFFINITY_MAX_ENTRIES=10000
CD_PROXY_CACHE_AFFINITY_HEADERS=session_id,x-session-affinity
CD_PROXY_WS_CONNECT_TIMEOUT_MS=30000      # how long to wait for the upstream Codex WS handshake before rotating
CD_PROXY_HTTP_IDLE_TIMEOUT_S=240          # Bun.serve idle timeout (sec, max 255); covers /responses streaming
CD_PROXY_WS_IDLE_TIMEOUT_S=600            # WebSocket idle timeout (sec, max 960); long Codex turns sit silent
CD_PROXY_WS_MAX_PAYLOAD_BYTES=67108864    # max single frame from upstream / client (default 64 MiB)
CD_PROXY_DEBUG=1
CD_PROXY_MODELS=gpt-5.3-codex,codex-auto-review
CD_PROXY_ZIG_AUTH_PARSE=0   # opt-in only; benchmark before enabling
CD_PROXY_ZIG_JWT_EXP=0      # opt-in only; benchmark before enabling
CD_PROXY_ZIG_PICK=0         # opt-in only for very large auth pools
```

## Zig acceleration

The Zig side is used for hot-path helpers and checks:

- `zig-src/core.zig` builds `zig-out/lib/libcd_proxy_core.so`, a native hot-path helper used by Bun through `bun:ffi` when present. It handles binary-frame terminal WebSocket event detection without per-frame JS `JSON.parse`; compact text frames use an even faster JS sentinel path. The Zig core also includes opt-in helpers for JWT `exp` decoding, auth-file JSON extraction, and large-pool credential scans.
- `zig-src/main.zig` builds `zig-out/bin/cd-proxy-zig` for native auth/HTTP parity checks. Its old WebSocket proxy path was removed because Bun is faster for WebSockets.

`bun run start` and `bun run check` use the Bun runtime, while still building ReleaseFast Zig artifacts when available for `bun:ffi` hot-path helpers.

```bash
zig build test
bun run zig:build
bun run start        # Bun runtime on CD_PROXY_HOST/CD_PROXY_PORT; fastest WebSocket path
bun run check        # Bun runtime check
bun run assert:native
bun run bench              # request/response hot-path microbenchmarks; see BENCHMARKS.md
bun run bench:local-loop   # local mock-upstream macro benchmark
```

Optional override:

```bash
CD_PROXY_ZIG_CORE=/absolute/path/to/libcd_proxy_core.so bun run start
```

## Pi coding agent pointing at cd-proxy

This repo includes `.pi/settings.json` with:

```json
{ "transport": "websocket" }
```

That forces Pi's OpenAI/Codex transport to WebSocket and disables Pi's `auto` transport SSE fallback path for this project.

For Pi, configure an OpenAI-compatible Codex provider in `~/.pi/agent/models.json` using `api: "openai-codex-responses"` and `baseUrl: "http://127.0.0.1:8318"`. cd-proxy accepts Pi's `/codex/responses` WebSocket path and rotates its own native Codex credentials upstream.

The mock integration test starts a mock Codex WebSocket upstream, starts cd-proxy, runs the real `pi` CLI against provider `openai`, and asserts:

- Pi receives `pi-cd-proxy-ok`
- the upstream saw a WebSocket connection
- the upstream saw zero HTTP POSTs, proving no SSE fallback was used
- Pi's `OpenAI-Beta: responses_websockets=...` header and `response.create` frame passed through cd-proxy

```bash
bun run scripts/test-pi-coding-agent.ts
```

The real-credential smoke test uses `~/.local/share/cd-proxy/auths`, talks to `https://chatgpt.com/backend-api/codex` through cd-proxy, and asserts cd-proxy recorded WebSocket upgrades/upstream opens, a terminal WebSocket response event, and zero HTTP Responses POSTs. Pi currently keeps an internal one-shot Codex WebSocket idle timer alive after completion, so the smoke test cleans up the Pi subprocess after cd-proxy has proven the real WebSocket path completed:

```bash
bun run test:pi-real-ws
# optional model override
CD_PROXY_REAL_WS_MODEL=gpt-5.3-codex bun run test:pi-real-ws
```

## Native Codex login

Authenticate a new Codex OAuth account natively:

```bash
./scripts/codex-login-to-cd-proxy.sh
# or use native device-code auth
./scripts/codex-login-to-cd-proxy.sh --device-auth
# or skip automatic browser launch
./scripts/codex-login-to-cd-proxy.sh --no-browser
```

`--with-api-key` is intentionally rejected for cd-proxy upstream auth: the Codex ChatGPT backend uses Codex/ChatGPT OAuth tokens. The local proxy API key is still supported for clients via `CD_PROXY_API_KEY` / `CD_PROXY_API_KEY_FILE`.

Test selector rotation without hitting upstream:

```bash
./scripts/test-rotation.sh 14
# or
curl -H "Authorization: Bearer $(cat ~/.config/cd-proxy/api-key)" \
  'http://127.0.0.1:8318/debug/rotation?count=10'
```

Test actual proxied request rotation against a local mock upstream:

```bash
./scripts/test-proxy-round-robin.sh
```

Run the native auth checks plus the granular rotation suite. The auth check verifies OAuth params, form-encoded token exchange/refresh, filename convention, and saved JSON shape. The rotation suite uses a temporary auth dir with fake Codex credentials, turns on debug rotation headers, and proves:

- exact A → B → C → A → B → C per-request routing
- disabled credentials are skipped after `/reload`
- `429` cools the failing credential and retries the next credential in the same external request
- `5xx` upstream failures are retried on the next credential instead of being returned when another account succeeds
- WebSocket upstream handshake failures rotate to the next credential before the client is upgraded
- session/cache affinity keeps repeated `session_id` requests on the same credential while new sessions continue round-robin
- the mock upstream saw the attempted failing credential before the retry

```bash
./scripts/granular-round-robin-test.ts
```

Test OpenAI/Codex Responses WebSocket flow-through against a local mock upstream:

```bash
./scripts/test-websocket-flow.ts
./scripts/test-cache-affinity.ts
./scripts/test-codex-websocket-cached.ts
bun run scripts/test-pi-coding-agent.ts
# or run core tests together
bun run test
```

Test direct WebSocket connectivity to OpenAI/Codex without cd-proxy in the path. This performs only the WebSocket handshake and immediately closes; it does not send a model request:

```bash
bun run test:direct-ws       # first usable account
./scripts/test-direct-websocket.ts --all
```
