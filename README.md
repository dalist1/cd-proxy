# cd-proxy

Minimal Codex-only proxy in **Bun**, plus a small **Zig** auth checker. It mirrors the relevant `cliproxy` setup installed on this machine:

- `cliproxy` wrapper: `~/.local/bin/cliproxy`
- service: `cliproxyapi.service`
- health target: `http://127.0.0.1:8317/v1/models`
- API key: `~/.config/cliproxyapi/api-key`
- Source Codex auth dir: `~/.local/share/cliproxyapi/auths`
- Mirrored cd-proxy auth dir: `~/.local/share/cd-proxy/auths`
- routing strategy in current cliproxy config: `round-robin`

This project only implements Codex/ChatGPT OAuth token auth, not the full CLIProxyAPI provider matrix.

## What matches Codex login

From the current OpenAI Codex CLI sources, ChatGPT/Codex auth uses:

- token refresh endpoint: `https://auth.openai.com/oauth/token`
- OAuth refresh grant body:
  - `client_id = app_EMoamEEZ73f0CkXaXp7hrann`
  - `grant_type = refresh_token`
  - `refresh_token = ...`
- upstream Codex backend base: `https://chatgpt.com/backend-api/codex`
- request auth headers:
  - `Authorization: Bearer <access_token>`
  - `ChatGPT-Account-ID: <account_id>` when present
  - `X-OpenAI-Fedramp: true` only for FedRAMP accounts (not enabled here unless added later)

## Bun proxy

```bash
bun run src/server.ts --check
bun run start
```

Defaults:

- listen: `127.0.0.1:8318` (keeps global `cliproxy` on `8317` untouched)
- auth dir: `~/.local/share/cd-proxy/auths` after mirroring from cliproxy
- API key file: `~/.config/cliproxyapi/api-key` (same bearer key cliproxy uses)

Health check:

```bash
curl -H "Authorization: Bearer $(cat ~/.config/cliproxyapi/api-key)" \
  http://127.0.0.1:8318/health
```

Models check:

```bash
curl -H "Authorization: Bearer $(cat ~/.config/cliproxyapi/api-key)" \
  http://127.0.0.1:8318/v1/models
```

Supported proxy paths:

- `GET /v1/models` returns a static OpenAI-compatible model list
- `POST /v1/responses` proxies to `https://chatgpt.com/backend-api/codex/responses`
- `POST /v1/responses/compact` proxies to `https://chatgpt.com/backend-api/codex/responses/compact`
- same paths without `/v1` are also accepted

Round-robin behavior:

1. Loads `codex-*.json` auth files from the cd-proxy auth dir.
2. Picks the next enabled credential for every request.
3. Refreshes a credential before use if its expiry is near.
4. On `401`, refreshes and retries once.
5. On `429`, cools that credential briefly and rotates to the next credential.

Useful env vars:

```bash
CD_PROXY_HOST=127.0.0.1
CD_PROXY_PORT=8318
CD_PROXY_AUTH_DIR=~/.local/share/cd-proxy/auths
CD_PROXY_API_KEY_FILE=~/.config/cliproxyapi/api-key
CD_PROXY_API_KEY=override-local-bearer-key
CD_PROXY_MAX_RETRY_CREDENTIALS=5
CD_PROXY_COOLDOWN_MS=30000
CD_PROXY_DEBUG=1
CD_PROXY_MODELS=gpt-5.3-codex,codex-auto-review
```

## Zig acceleration

The Zig side now has two pieces:

- `zig-src/core.zig` builds `zig-out/lib/libcd_proxy_core.so`, a tiny native round-robin/skip-scan core used by Bun through `bun:ffi` when present.
- `zig-src/main.zig` builds `zig-out/bin/cd-proxy-zig`, a fast auth-dir checker that prints redacted account prefixes.

`bun run start` and `bun run check` try to build the Zig artifacts first, then gracefully fall back to the TypeScript implementation if Zig is unavailable.

```bash
zig build test
zig build -p zig-out
./zig-out/bin/cd-proxy-zig
bun run check   # shows zig_core: true when the shared library loaded
```

Optional override:

```bash
CD_PROXY_ZIG_CORE=/absolute/path/to/libcd_proxy_core.so bun run start
```

## Codex CLI pointing at cd-proxy

For Codex CLI/OpenAI-compatible configs, use this as a local Responses provider:

```toml
model_provider = "cd-proxy"
model = "gpt-5.3-codex"

[model_providers.cd-proxy]
name = "cd-proxy"
base_url = "http://127.0.0.1:8318/v1"
wire_api = "responses"
env_key = "CD_PROXY_API_KEY"
```

Then run:

```bash
export CD_PROXY_API_KEY="$(cat ~/.config/cliproxyapi/api-key)"
bun run start
```

Keep global `cliproxy` running or stopped independently; this project defaults to a different port.

## Credential mirroring and new logins

Mirror existing cliproxy Codex credentials into cd-proxy's own auth dir:

```bash
./scripts/mirror-credentials.sh
```

Import the active `~/.codex/auth.json` ChatGPT login:

```bash
bun run scripts/import-codex-auth.ts
```

Authenticate a new Codex OAuth account without overwriting your normal `~/.codex` login:

```bash
./scripts/codex-login-to-cd-proxy.sh
# or use device-code auth
./scripts/codex-login-to-cd-proxy.sh --device-auth
```

`--with-api-key` is intentionally rejected for cd-proxy upstream auth: the Codex ChatGPT backend uses Codex/ChatGPT OAuth tokens. The local proxy API key is still supported for clients via `CD_PROXY_API_KEY` / `CD_PROXY_API_KEY_FILE`.

Test selector rotation without hitting upstream:

```bash
./scripts/test-rotation.sh 14
# or
curl -H "Authorization: Bearer $(cat ~/.config/cliproxyapi/api-key)" \
  'http://127.0.0.1:8318/debug/rotation?count=10'
```

Test actual proxied request rotation against a local mock upstream:

```bash
./scripts/test-proxy-round-robin.sh
```

Run the granular rotation suite. This uses a temporary auth dir with fake Codex credentials, turns on debug rotation headers, and proves:

- exact A → B → C → A → B → C per-request routing
- disabled credentials are skipped after `/reload`
- `429` cools the failing credential and retries the next credential in the same external request
- the mock upstream saw the attempted failing credential before the retry

```bash
./scripts/granular-round-robin-test.ts
```

