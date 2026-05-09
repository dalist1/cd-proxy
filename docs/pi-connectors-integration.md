# Pi connector integration params

Verified locally:

- `bun run scripts/test-websocket-flow.ts` ✅ WS rotation + failover
- `bun run scripts/test-pi-coding-agent.ts` ✅ real Pi -> cd-proxy -> mock upstream over WS, zero SSE/HTTP fallback

## Connectivity shape

```text
Pi connector/provider
  -> http://127.0.0.1:8318
  -> cd-proxy credential rotation
  -> https://chatgpt.com/backend-api/codex
```

Fast path for Codex/GPT agent work: **Pi WebSocket transport + cd-proxy Bun WS proxy**.

Caching details live in [`pi-caching-integration.md`](./pi-caching-integration.md).

## Pi settings params

Project: `.pi/settings.json` or global: `~/.pi/agent/settings.json`

```json
{
  "transport": "websocket",
  "defaultProvider": "cd-proxy",
  "defaultModel": "gpt-5.3-codex",
  "defaultThinkingLevel": "high",
  "retry": { "enabled": true, "provider": { "maxRetries": 0 } }
}
```

Important fields:

| Param | Values | Integration note |
|---|---|---|
| `transport` | `websocket`, `websocket-cached`, `sse`, `auto` | Use `websocket` for deterministic WS-only tests; use `websocket-cached` for fastest repeated Codex turns after validation. |
| `defaultProvider` | provider key | Match key in `models.json`. |
| `defaultModel` | model id | Must exist in provider models. |
| `defaultThinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` | Sent according to model support. |
| `enabledModels` | string[] | Optional Ctrl+P model cycling list. |
| `retry.provider.timeoutMs` | ms | Useful for long turns. |
| `retry.provider.maxRetries` | number | Often set `0` while testing transport behavior. |

## Pi connector/provider config

File: `~/.pi/agent/models.json`

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
          "name": "GPT 5.3 Codex via cd-proxy",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 4096,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

Provider fields that matter:

| Param | Required | Note |
|---|---:|---|
| `baseUrl` | yes | cd-proxy root URL, no `/v1` needed. |
| `api` | yes | Use `openai-codex-responses`. |
| `apiKey` | if proxy key enabled | Literal, env var name, or `!shell command`. |
| `headers` | no | Extra headers; values may be literal/env/`!command`. |
| `authHeader` | no | Usually not needed; Codex connector already uses bearer auth. |
| `models` | yes for custom provider | Model list exposed to Pi. |
| `modelOverrides` | no | Override built-in model metadata without redefining every model. |
| `compat` | no | Provider-level OpenAI/Anthropic compatibility flags. |

Useful `api` connector values:

| `api` | Use for |
|---|---|
| `openai-codex-responses` | cd-proxy / Codex Responses; best match here. |
| `openai-responses` | Standard OpenAI Responses API. |
| `azure-openai-responses` | Azure OpenAI Responses API. |
| `openai-completions` | OpenAI Chat Completions compatibles. |
| `anthropic-messages` | Anthropic Messages compatibles. |
| `google-generative-ai` | Google AI Studio/Gemini API. |
| `google-vertex` | Google Vertex. |
| `bedrock-converse-stream` | AWS Bedrock Converse. |
| `mistral-conversations` | Native Mistral conversations. |

Model fields that help integration:

| Param | Note |
|---|---|
| `id` | Sent as the upstream model. |
| `name` | Human label in Pi. |
| `api` | Optional per-model API override. |
| `baseUrl` | Optional per-model endpoint override. |
| `reasoning` | Enables Pi thinking controls. |
| `thinkingLevelMap` | Hide/remap unsupported levels with `null` or strings. |
| `input` | Usually `["text"]`; use `["text","image"]` only if verified. |
| `contextWindow` | Token budget Pi uses. |
| `maxTokens` | Max assistant output budget. |
| `cost` | UI accounting only. |
| `headers` | Per-model headers if needed later. |
| `compat` | Per-model compatibility overrides. |

Compatibility params worth knowing for future connectors:

| Param | Note |
|---|---|
| `supportsDeveloperRole` | Send system prompt as `developer` vs `system`. |
| `supportsReasoningEffort` | Whether `reasoning_effort` is accepted. |
| `supportsUsageInStreaming` | Whether streaming usage blocks are accepted. |
| `maxTokensField` | `max_completion_tokens` vs `max_tokens`. |
| `requiresToolResultName` | Add name on tool results. |
| `requiresAssistantAfterToolResult` | Insert assistant message before user after tool results. |
| `requiresThinkingAsText` | Convert thinking blocks to text. |
| `requiresReasoningContentOnAssistantMessages` | Include empty `reasoning_content` when reasoning is on. |
| `thinkingFormat` | `openai`, `deepseek`, `zai`, `qwen`, `qwen-chat-template`. |
| `cacheControlFormat` | Currently `anthropic`. |
| `supportsStrictMode` | Include strict tool schema flag. |
| `supportsLongCacheRetention` | Allow long prompt cache TTLs. |
| `supportsEagerToolInputStreaming` | Anthropic fine-grained tool streaming behavior. |
| `openRouterRouting` | OpenRouter provider routing object. |
| `vercelGatewayRouting` | Vercel AI Gateway routing object. |

## CLI params for smoke tests

```bash
pi --provider cd-proxy --model gpt-5.3-codex --thinking off --no-session -p "ping"
```

Useful flags: `--provider`, `--model`, `--api-key`, `--thinking`, `--models`, `--list-models`, `--no-session`, `--tools`, `--no-tools`.

## cd-proxy endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health`, `/v1/health` | Public health + transport stats. |
| `GET /status`, `/v1/status` | Auth/rotation/status; requires local bearer if configured. |
| `POST /reload` | Reload auth files. |
| `GET /models`, `/v1/models` | OpenAI-compatible model list. |
| `POST /responses`, `/v1/responses`, `/codex/responses` | SSE/HTTP Responses path. |
| `WS /responses`, `/v1/responses`, `/codex/responses` | WebSocket Responses path. |
| `POST /responses/compact`, `/v1/responses/compact`, `/codex/responses/compact` | Compact endpoint. |
| `GET /debug/rotation?count=N` | Preview round-robin picks. |

## Headers and request params

Client -> cd-proxy:

| Header/param | Note |
|---|---|
| `Authorization: Bearer <local-key>` | Required only if `CD_PROXY_API_KEY` or key file is set. |
| `OpenAI-Beta: responses_websockets=2026-02-06` | Required for Codex Responses WS; Pi sends it and cd-proxy preserves it. |
| `x-client-request-id` | Preserved; useful for tracing. |
| `session_id` | Preserved if Pi/client sends it. |
| turn-state metadata | Preserved if Pi/client sends it. |
| `Content-Type` | Defaults to `application/json` for HTTP proxying. |
| `Accept` | Defaults to `text/event-stream` for non-GET HTTP responses when absent. |

cd-proxy removes hop-by-hop/upgrade headers and forwards useful app headers upstream.
For WS, it opens upstream first; only upgrades the client after upstream succeeds.

Optional debug response headers when `CD_PROXY_EXPOSE_ROTATION_HEADERS=1`:

- `x-cd-proxy-auth-label`
- `x-cd-proxy-auth-account-prefix`
- `x-cd-proxy-attempt`
- `x-cd-proxy-next-rr-index`

## cd-proxy env params

| Env var | Default | Why it matters |
|---|---|---|
| `CD_PROXY_HOST` | `127.0.0.1` | Bind host. |
| `CD_PROXY_PORT` | `8318` | Bind port. |
| `CD_PROXY_UPSTREAM_BASE` | `https://chatgpt.com/backend-api/codex` | Upstream Codex base; tests can point at mocks. |
| `CD_PROXY_AUTH_DIR` | `~/.local/share/cd-proxy/auths` | `codex-*.json` credentials. |
| `CD_PROXY_API_KEY_FILE` | `~/.config/cd-proxy/api-key` | Local client bearer key file. |
| `CD_PROXY_API_KEY` | unset | Inline local bearer key override. |
| `CD_PROXY_MODELS` | `gpt-5.3-codex,gpt-5.3-codex-spark,codex-auto-review,gpt-5.5,gpt-5.2` | Model ids returned by `/v1/models`. |
| `CD_PROXY_MAX_RETRY_CREDENTIALS` | `0` | `0` means try every enabled credential. |
| `CD_PROXY_COOLDOWN_MS` | `30000` | Cooldown after retryable failures. |
| `CD_PROXY_RETRYABLE_HTTP_STATUSES` | `401,403,408,409,425,429,500,502,503,504` | HTTP statuses that rotate credentials. |
| `CD_PROXY_CACHE_AFFINITY` | `1` | Sticky session/cache key to credential for better upstream prompt-cache hits. |
| `CD_PROXY_CACHE_AFFINITY_TTL_MS` | `1800000` | Cache-affinity binding lifetime. |
| `CD_PROXY_CACHE_AFFINITY_MAX_ENTRIES` | `10000` | Max in-memory affinity bindings. |
| `CD_PROXY_CACHE_AFFINITY_HEADERS` | `session_id,x-session-affinity` | Headers used as affinity keys. |
| `CD_PROXY_CACHE_AFFINITY_BODY_FIELDS` | `prompt_cache_key,session_id` | Root JSON string fields byte-scanned for affinity when headers are absent or request-body cache keys are more direct. |
| `CD_PROXY_CACHE_AFFINITY_MAX_VALUE_BYTES` | `512` | Bounds normalized cache-affinity values. |
| `CD_PROXY_REFRESH_SKEW_MS` | `300000` | Refresh before token expiry. |
| `CD_PROXY_WS_CONNECT_TIMEOUT_MS` | `30000` | WS upstream handshake timeout before rotating. |
| `CD_PROXY_HTTP_IDLE_TIMEOUT_S` | `240` | Long SSE/HTTP turns. Bun max clamped to 255. |
| `CD_PROXY_WS_IDLE_TIMEOUT_S` | `600` | Long silent WS turns. Max clamped to 960. |
| `CD_PROXY_WS_MAX_PAYLOAD_BYTES` | `67108864` | Max single WS frame. |
| `CD_PROXY_EXPOSE_ROTATION_HEADERS` | `0` | Integration debugging only. |
| `CD_PROXY_DEBUG` | `0` | Verbose logs. |
| `CD_PROXY_DEBUG_SAVE_REQUESTS` | `0` | Save proxied HTTP requests and WebSocket client frames asynchronously for debugging; sensitive headers are redacted. |
| `CD_PROXY_DEBUG_SAVE_DIR` | `~/.local/share/cd-proxy/debug-requests` | Directory for debug request snapshots. |
| `CD_PROXY_DEBUG_SAVE_BODY_BYTES` | `1048576` | Per-request/body bytes saved before truncation. |
| `CD_PROXY_DEBUG_SAVE_MAX_PENDING` | `1024` | Max queued debug snapshot writes before dropping. |
| `CD_PROXY_ZIG_CORE` | `zig-out/lib/libcd_proxy_core.*` | Override Zig helper path. |
| `CD_PROXY_ZIG_AUTH_PARSE` | `0` | Opt-in auth JSON parser. Benchmark first. |
| `CD_PROXY_ZIG_JWT_EXP` | `0` | Opt-in JWT exp decoder. Benchmark first. |
| `CD_PROXY_ZIG_PICK` | `0` | Opt-in large-pool credential picker. |

Speed-sensitive knobs: `transport=websocket` or `transport=websocket-cached`, `CD_PROXY_CACHE_AFFINITY=1`, `CD_PROXY_CACHE_AFFINITY_BODY_FIELDS`, `CD_PROXY_WS_IDLE_TIMEOUT_S`, `CD_PROXY_WS_CONNECT_TIMEOUT_MS`, `CD_PROXY_WS_MAX_PAYLOAD_BYTES`, and keeping Bun as the runtime. Debug request capture is off by default and writes asynchronously when enabled.

## Credential file params

Files: `CD_PROXY_AUTH_DIR/codex-*.json`

```json
{
  "type": "codex",
  "email": "user@example.com",
  "account_id": "...",
  "access_token": "...",
  "refresh_token": "...",
  "id_token": "...",
  "expired": "2099-01-01T00:00:00Z",
  "last_refresh": "2026-01-01T00:00:00Z",
  "disabled": false
}
```

Fields:

| Field | Note |
|---|---|
| `type` | Use `codex`; other types are skipped. |
| `email` | Label/debug identity. |
| `account_id` | Sent upstream as `ChatGPT-Account-ID`. |
| `access_token` | Upstream bearer. |
| `refresh_token` | Used by native refresh. |
| `id_token` | Optional metadata/token source. |
| `expired` | Expiry timestamp; triggers refresh. |
| `last_refresh` | Metadata. |
| `disabled` | `true` skips the credential. |

Prefer creating these through `./scripts/codex-login-to-cd-proxy.sh`.
