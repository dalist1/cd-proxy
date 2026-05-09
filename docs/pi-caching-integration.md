# Pi caching integration notes

## Big picture

There are 4 separate cache layers:

1. **Provider prompt cache**: upstream model-side cache, keyed by Pi session/request IDs.
2. **Codex WebSocket session cache**: Pi can reuse a WS connection and send only context deltas.
3. **Credential/config cache**: API keys, auth files, token refresh state.
4. **cd-proxy hot-path cache**: tiny runtime caches only; no response/body caching.

For speed, the important layer is **Codex WebSocket session caching**. For cost, the important layer is **provider prompt cache hits** (`cacheRead`).

## Codebase verification

Checked against the installed Pi code, not only docs:

| Code area | Verified behavior |
|---|---|
| `@earendil-works/pi-coding-agent/dist/core/settings-manager.js` | `getTransport()` currently defaults to `"auto"`; settings persist the `transport` enum directly. |
| `@earendil-works/pi-coding-agent/dist/core/sdk.js` | Pi passes `sessionManager.getSessionId()`, `transport`, retry settings, auth headers, and extension `onPayload`/`onResponse` hooks into the agent stream. |
| `@earendil-works/pi-agent-core/dist/agent.js` | Agent forwards `sessionId`, `transport`, `thinkingBudgets`, `maxRetryDelayMs`, and resolved API key into provider stream calls. |
| `@earendil-works/pi-ai/dist/types.d.ts` | `Transport = "sse" | "websocket" | "websocket-cached" | "auto"`; `CacheRetention = "none" | "short" | "long"`. |
| `@earendil-works/pi-ai/dist/providers/openai-codex-responses.js` | Codex WS cache uses a per-session WebSocket map, 5-minute idle expiry, continuation state, and `previous_response_id` deltas. |
| `src/server.ts` | cd-proxy forwards app headers/body fields, rotates credentials, keeps cache-affinity sessions sticky to one credential, byte-scans root JSON cache fields without `JSON.parse`, and does not cache model responses or request bodies. |

Local code tests added:

```bash
bun run scripts/test-cache-affinity.ts
bun run scripts/test-codex-websocket-cached.ts
```

They verify:

- cd-proxy keeps repeated `session_id` requests on the same upstream credential while new sessions continue round-robin.
- cd-proxy also keeps repeated body-only `prompt_cache_key` requests on the same credential without parsing full request JSON.
- two `openai-codex-responses` calls through cd-proxy with the same `sessionId` and `transport: "websocket-cached"` produce a second WS `response.create` frame with `previous_response_id` and delta-sized `input` over one proxied WebSocket.

## Pi cache params

### Settings / env

```json
{
  "transport": "websocket-cached"
}
```

```bash
PI_CACHE_RETENTION=long pi
```

| Param | Values | What it does |
|---|---|---|
| `transport` | `sse`, `websocket`, `websocket-cached`, `auto` | Transport choice; `websocket-cached` and `auto` can use Codex WS context deltas. |
| `PI_CACHE_RETENTION` | unset, `long` | Back-compat env knob for prompt cache retention. `long` means Anthropic 1h, OpenAI 24h where supported. |
| `cacheRetention` | `none`, `short`, `long` | SDK/provider option. Overrides `PI_CACHE_RETENTION`. |
| `sessionId` | string | Cache affinity key. Pi uses session IDs for prompt cache keys, headers, WS reuse, and Codex deltas. |

Recommended modes for cd-proxy testing:

| Mode | Speed/cache behavior | Risk |
|---|---|---|
| `websocket` | Fast WS, deterministic no SSE fallback; no Codex delta-context mode. | Safest for proving WS-only integration. |
| `websocket-cached` | WS plus Codex connection/context reuse. | Best speed path if stable. |
| `auto` | Current Pi default in code. WS first, cached context; may fall back to SSE after WS failures. | Fast, but not WS-only. |
| `sse` | HTTP stream only. | Slowest/fallback path. |

Important distinction from code:

- `websocket` tries WS and **does not** use Codex continuation/delta caching.
- `websocket-cached` tries WS and uses continuation/delta caching.
- `auto` tries WS, uses continuation/delta caching, and can fall back to SSE if WS fails before message streaming starts.
- `sse` never uses the WS connection cache.

## Codex / GPT via `openai-codex-responses`

Pi request body includes:

| Field/header | How caching uses it |
|---|---|
| `prompt_cache_key: sessionId` | Upstream prompt cache affinity. |
| `session_id` | Sent on SSE and WS; same affinity/tracing role. |
| `x-client-request-id` | Sent on SSE/WS; WS may use a generated per-request ID. |
| `previous_response_id` | Used only in cached WS mode when Pi can send a delta instead of full context. |
| `input` | Full context normally; delta-only when `previous_response_id` is used. |
| `store: false` | Codex requires this; Pi does not rely on stored responses. |

Internal Codex WS behavior:

- Pi keeps a reusable session WebSocket for about **5 minutes idle** (`SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000`).
- Cache key is the Pi `sessionId`; no `sessionId` means no reusable per-session socket.
- If the cached socket is idle and open, Pi reuses it; if it is busy, Pi opens a temporary second socket for that request.
- After a successful cached WS response, Pi stores continuation state: full request body, upstream `response.id`, and assistant response items.
- On the next request, Pi strips `input`/`previous_response_id` from both bodies and requires the rest of the request shape to match.
- It then checks that current `input` starts with: previous request `input` + previous assistant response items.
- If that prefix matches and a previous response id exists, Pi sends `previous_response_id` and only the remaining input delta.
- Function-call output items are filtered out of stored assistant response items before building continuation state.
- If request shape/prefix validation fails, Pi clears continuation and sends full context.
- If a cached WS request errors, Pi clears continuation, closes/drops the socket, and surfaces/falls back depending on transport mode.
- `auto` records WS failures and activates SSE fallback for that session when the failure occurs before message streaming starts.

## Codex WS cache debug stats

The `openai-codex-responses` provider exposes debug helpers for SDK/tests:

| Helper | Use |
|---|---|
| `getOpenAICodexWebSocketDebugStats(sessionId)` | Inspect per-session WS/cache counters. |
| `resetOpenAICodexWebSocketDebugStats(sessionId?)` | Clear debug counters and fallback marker. |
| `closeOpenAICodexWebSocketSessions(sessionId?)` | Close cached WS sessions; useful for tests and shutdown. |

Stats fields seen in code:

| Field | Meaning |
|---|---|
| `requests` | WS requests sent for this session. |
| `connectionsCreated` | New sockets opened. |
| `connectionsReused` | Cached sockets reused. |
| `cachedContextRequests` | Requests where cached-context mode was active. |
| `fullContextRequests` | Requests sent with full input context. |
| `deltaRequests` | Requests sent with `previous_response_id` and delta input. |
| `lastInputItems` | Input item count for latest request. |
| `lastDeltaInputItems` | Delta input item count for latest delta request. |
| `lastPreviousResponseId` | Previous response id used for latest delta request. |
| `websocketFailures` | WS failures recorded for the session. |
| `sseFallbacks` | SSE fallbacks recorded for the session. |
| `websocketFallbackActive` | Whether auto-mode fallback is active. |
| `lastWebSocketError` | Formatted last WS error. |
| `storeTrueRequests` | Should stay `0`; Codex rejects `store: true`. |

## Generic OpenAI Responses caching

For `api: "openai-responses"`, Pi sends:

| Field/header | When |
|---|---|
| `prompt_cache_key: sessionId` | Unless `cacheRetention: "none"`. |
| `prompt_cache_retention: "24h"` | When retention is `long` and `supportsLongCacheRetention !== false`. |
| `session_id` header | When `sessionId` exists and `compat.sendSessionIdHeader !== false`. |
| `x-client-request-id` | Same session affinity/tracing value. |
| `store: false` | Default. |

Compat params:

```json
{
  "compat": {
    "sendSessionIdHeader": true,
    "supportsLongCacheRetention": true
  }
}
```

## OpenAI Chat Completions-compatible caching

For `api: "openai-completions"`, Pi can send:

| Field/header | When |
|---|---|
| `prompt_cache_key: sessionId` | Direct `api.openai.com` when not `none`, or long retention with compatible providers. |
| `prompt_cache_retention: "24h"` | `cacheRetention: "long"` and `supportsLongCacheRetention !== false`. |
| `session_id`, `x-client-request-id`, `x-session-affinity` | Only when `compat.sendSessionAffinityHeaders: true`. |
| `cache_control` markers | Only with `compat.cacheControlFormat: "anthropic"`. |

Useful compat params:

```json
{
  "compat": {
    "sendSessionAffinityHeaders": true,
    "cacheControlFormat": "anthropic",
    "supportsLongCacheRetention": true
  }
}
```

`cacheControlFormat: "anthropic"` marks:

- system/developer prompt
- last tool definition
- last user/assistant text content

With long retention it adds `ttl: "1h"` for Anthropic-style cache control.

## Anthropic-compatible caching

For `api: "anthropic-messages"`:

| Param | Effect |
|---|---|
| `cacheRetention: "short"` | Default short provider cache behavior. |
| `cacheRetention: "long"` or `PI_CACHE_RETENTION=long` | Adds `cache_control.ttl: "1h"` if supported. |
| `compat.supportsLongCacheRetention: false` | Prevents long-retention cache fields. |

## Cost/usage accounting

Pi normalizes usage into:

```json
{
  "input": 0,
  "output": 0,
  "cacheRead": 0,
  "cacheWrite": 0,
  "totalTokens": 0,
  "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 }
}
```

| Usage field | Meaning |
|---|---|
| `input` | Non-cached input tokens. |
| `cacheRead` | Tokens served from an existing provider cache. Lower latency/cost where provider discounts apply. |
| `cacheWrite` | Tokens written into cache this request, when provider reports it. |
| `cost.cacheRead` / `cost.cacheWrite` | Per-million token prices from `models.json`; UI accounting only. |

For OpenAI/Codex Responses, upstream `cached_tokens` maps to `cacheRead`; cache writes may not be reported separately.

## cd-proxy caching behavior

cd-proxy intentionally does **not** cache model responses or request bodies.

What it does cache/keep in memory:

| Item | Behavior |
|---|---|
| Local API key | Loaded from `CD_PROXY_API_KEY` or `CD_PROXY_API_KEY_FILE` on startup. |
| Auth files | Loaded on startup, reloaded every 60s, and via `POST /reload`. |
| Token refresh | `refreshInFlight` deduplicates concurrent refreshes for one credential. |
| Credential cooldown | Failed credentials stay cooled until `coolingUntil`. |
| Cache-affinity map | Bounded in-memory session/cache-key to credential bindings; LRU-ordered for O(1) hot-path eviction. |
| Model list body | `/models` JSON is prebuilt from `CD_PROXY_MODELS`. |
| Zig core handle | Loaded once if present. |
| Debug request capture | Disabled by default; when `CD_PROXY_DEBUG_SAVE_REQUESTS=1`, request snapshots with sensitive headers redacted are queued to disk asynchronously and bounded by `CD_PROXY_DEBUG_SAVE_MAX_PENDING`. |

cd-proxy forwards Pi cache headers/body fields upstream unchanged unless they are hop-by-hop transport headers. It also uses cache/session affinity to avoid defeating account-scoped upstream prompt caches when multiple credentials are configured.

Header/body behavior from `src/server.ts`:

| Path | Behavior |
|---|---|
| HTTP/SSE | Deletes `host`, `connection`, `content-length`; replaces `Authorization` with selected upstream Codex token; preserves request body fields such as `prompt_cache_key`, `previous_response_id`, `input`, `store`. |
| HTTP/SSE | Sets `Content-Type` to incoming value or `application/json`; sets `Accept: text/event-stream` for non-GET requests if absent. |
| HTTP/SSE | Adds `ChatGPT-Account-ID` from selected credential when present. |
| WebSocket | Opens upstream WS before client upgrade; deletes hop-by-hop WS headers; preserves app headers such as `OpenAI-Beta`, `x-client-request-id`, `session_id`. It also replaces client `Authorization`/`ChatGPT-Account-ID` so upstream only sees the selected cd-proxy credential. |
| WebSocket | Replaces `Authorization` and adds `ChatGPT-Account-ID` for the selected upstream credential; when no header affinity already bound the socket, the first client `response.create` frame is byte-scanned for `prompt_cache_key` to bind future affinity without blocking frame forwarding. |

Implication: cache affinity is controlled by Pi/provider fields, not by cd-proxy. cd-proxy only changes auth/account routing.

### Credential rotation vs cache hits

Provider-side prompt caches are usually account/session scoped. cd-proxy now keeps cache-affinity sessions sticky to the same credential:

- Affinity is enabled by default with `CD_PROXY_CACHE_AFFINITY=1`.
- Default affinity headers are `session_id` and `x-session-affinity`.
- The first request for a cache/session key chooses the normal round-robin credential and binds that key to the credential.
- Affinity keys are normalized from header values or body `prompt_cache_key`/`session_id` values, so the same session value maps to one credential even when it appears through different supported fields.
- Later requests with the same key prefer the bound credential while it is enabled, not cooling down, and the affinity entry has not expired.
- New sessions still continue the normal round-robin sequence.
- If the bound credential fails/cools down, cd-proxy retries other credentials and rebinds the session on success.
- A reused Pi cached WebSocket naturally keeps the same cd-proxy upstream WS connection and selected credential.
- For cache experiments, inspect `cache_affinity` in `/health` or `/status`, and inspect `x-cd-proxy-auth-label` with `CD_PROXY_EXPOSE_ROTATION_HEADERS=1`.

## cd-proxy params that affect cache-like behavior

| Env var | Cache relevance |
|---|---|
| `CD_PROXY_AUTH_DIR` | Source of cached in-memory credential entries. |
| `CD_PROXY_REFRESH_SKEW_MS` | Refresh tokens before expiry; avoids auth misses during cached sessions. |
| `CD_PROXY_COOLDOWN_MS` | How long failed credentials are skipped. |
| `CD_PROXY_MAX_RETRY_CREDENTIALS` | How many credentials may be tried before surfacing failure. |
| `CD_PROXY_WS_IDLE_TIMEOUT_S` | Must exceed long quiet Codex turns; separate from Pi's WS session cache. |
| `CD_PROXY_HTTP_IDLE_TIMEOUT_S` | Must exceed long SSE/HTTP turns. |
| `CD_PROXY_WS_MAX_PAYLOAD_BYTES` | Needed for large context/cache frames. |
| `CD_PROXY_CACHE_AFFINITY` | Enable/disable sticky session-to-credential affinity; default enabled. |
| `CD_PROXY_CACHE_AFFINITY_TTL_MS` | Affinity entry lifetime; default 30 minutes. |
| `CD_PROXY_CACHE_AFFINITY_MAX_ENTRIES` | Bounds in-memory affinity map; default 10000. |
| `CD_PROXY_CACHE_AFFINITY_HEADERS` | Comma/space list of headers used as affinity keys; default `session_id,x-session-affinity`. |
| `CD_PROXY_CACHE_AFFINITY_BODY_FIELDS` | Comma/space list of root JSON string fields byte-scanned for affinity when useful; default `prompt_cache_key,session_id`. |
| `CD_PROXY_CACHE_AFFINITY_MAX_VALUE_BYTES` | Bounds any normalized affinity value; default `512`. |
| `CD_PROXY_MODELS` | Model IDs advertised; does not cache model capabilities. |
| `CD_PROXY_ZIG_AUTH_PARSE` | Optional auth-file parse fast path. |
| `CD_PROXY_ZIG_JWT_EXP` | Optional JWT expiry parse fast path. |
| `CD_PROXY_ZIG_PICK` | Optional large-pool credential picker. |

## models.json params for cache-aware connectors

```json
{
  "providers": {
    "cd-proxy": {
      "baseUrl": "http://127.0.0.1:8318",
      "api": "openai-codex-responses",
      "apiKey": "!cat ~/.config/cd-proxy/api-key",
      "models": [
        {
          "id": "gpt-5.3-codex",
          "reasoning": true,
          "contextWindow": 128000,
          "maxTokens": 4096,
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          }
        }
      ]
    }
  }
}
```

Cache-related config fields:

| Field | Note |
|---|---|
| `cost.cacheRead` | Price used for cached input reads in Pi UI. |
| `cost.cacheWrite` | Price used for cache writes in Pi UI. |
| `contextWindow` | Bigger stable prefixes improve cache usefulness but increase payload size. |
| `maxTokens` | Not cache-specific, but affects turn shape and cost accounting. |
| `headers` | Can inject cache/session headers for custom proxies. |
| `compat.supportsLongCacheRetention` | Turn off if provider/proxy rejects long cache fields. |
| `compat.cacheControlFormat` | Use `anthropic` for OpenAI-compatible Anthropic-style cache markers. |
| `compat.sendSessionAffinityHeaders` | OpenAI completions only; sends `session_id`, `x-client-request-id`, `x-session-affinity`. |
| `compat.sendSessionIdHeader` | OpenAI responses only; sends `session_id`. |

## API key command caching

| Location | Shell command caching |
|---|---|
| `~/.pi/agent/auth.json` API key entries | `!command` output is cached for process lifetime. |
| `~/.pi/agent/models.json` `apiKey` / `headers` | `!command` runs at request time; Pi does not add TTL/stale fallback. |

If a `models.json` command is slow or rate-limited, wrap it in your own TTL cache script.

## Integration guidance

- For deterministic transport tests: use `transport: "websocket"` and assert zero HTTP `/responses` posts.
- For fastest repeated Codex turns: test `transport: "websocket-cached"` and watch for `previous_response_id` deltas.
- For cache-cost experiments: set `PI_CACHE_RETENTION=long`, keep a stable `sessionId`, and compare `cacheRead` across turns.
- Do not put response caching in cd-proxy unless we also implement cache invalidation, privacy boundaries, and credential-aware keys.
