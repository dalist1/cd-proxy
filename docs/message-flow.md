# cd-proxy message flow

This document breaks down the runtime flow at a granular level: startup, request routing, HTTP/SSE proxying, WebSocket proxying, Pi `websocket-cached`, cache affinity, debug capture, retries, and shutdown behavior.

## 1. Runtime startup flow

1. `src/server.ts` imports config and runtime modules.
2. `src/config.ts` reads environment variables exactly once at process startup.
3. `src/config.ts` normalizes `CD_PROXY_UPSTREAM_BASE` by removing trailing slashes.
4. `src/config.ts` refuses the retired local proxy port `8317` so cd-proxy cannot accidentally wrap another local proxy.
5. `src/config.ts` derives HTTP upstream URLs:
   - `https://chatgpt.com/backend-api/codex/responses`
   - `https://chatgpt.com/backend-api/codex/responses/compact`
6. `src/config.ts` derives WebSocket upstream URL:
   - `wss://chatgpt.com/backend-api/codex/responses`
7. `src/config.ts` prebuilds `/models` JSON from `CD_PROXY_MODELS`.
8. `src/server.ts` creates one `AuthStore` instance.
9. `src/server.ts` creates one `CacheAffinityStore` instance.
10. `src/server.ts` creates one `DebugRequestCapture` instance.
11. `src/server.ts` creates one shared `transportStats` object.
12. `src/server.ts` loads Zig FFI helpers via `loadZigCore()` when the compiled library exists.
13. `src/server.ts` starts optional debug request capture directory setup.
14. `src/server.ts` loads the local proxy API key:
    - first from `CD_PROXY_API_KEY`
    - otherwise from `CD_PROXY_API_KEY_FILE`
15. `src/server.ts` loads Codex auth files from `CD_PROXY_AUTH_DIR`.
16. `AuthStore.load()` scans for `codex-*.json` files.
17. `AuthStore.load()` parses each auth file.
18. `AuthStore.load()` skips wrong `type` values.
19. `AuthStore.load()` skips entries without both `access_token` and `refresh_token`.
20. `AuthStore.load()` computes token expiry from `expired` or JWT `exp`.
21. `AuthStore.load()` preserves per-auth cooldown and in-flight refresh state across reloads.
22. `CacheAffinityStore.updateAuths()` receives the current auth list.
23. `CacheAffinityStore.updateAuths()` rebuilds its `authByPath` lookup map.
24. `CacheAffinityStore.updateAuths()` prunes stale affinity entries whose auth file disappeared.
25. `src/server.ts` starts a periodic auth reload every 60 seconds.
26. `Bun.serve()` starts listening on `CD_PROXY_HOST` / `CD_PROXY_PORT`.

## 2. Top-level request dispatch flow

Every incoming request enters `handle(req, server)` in `src/server.ts`.

1. `handle()` extracts the pathname without allocating a full `URL` object.
2. `handle()` checks whether the request is a WebSocket upgrade.
3. If it is a WebSocket upgrade:
   1. It maps the pathname to a supported upstream path.
   2. It only allows WebSocket upgrades for `responses`.
   3. It rejects unknown WebSocket endpoints with 404.
   4. It checks local proxy authorization.
   5. It checks that at least one Codex auth file exists.
   6. It delegates to `proxyWebSocketUpgrade()`.
4. If it is not a WebSocket upgrade:
   1. `/health` and `/v1/health` are handled publicly.
   2. `POST /reload` requires local proxy authorization.
   3. All remaining endpoints require local proxy authorization when a local API key exists.
   4. `/status` and `/v1/status` return internal status.
   5. `/debug/rotation` previews credential picks.
   6. `/models` and `/v1/models` return prebuilt model JSON.
   7. `/responses`, `/v1/responses`, `/codex/responses` go through HTTP/SSE proxying.
   8. `/responses/compact`, `/v1/responses/compact`, `/codex/responses/compact` go through HTTP proxying.
   9. Unknown paths return 404.

## 3. Local client authorization flow

1. If no local API key is configured, requests are allowed without local bearer auth.
2. If `CD_PROXY_API_KEY` or `CD_PROXY_API_KEY_FILE` exists, cd-proxy expects:
   - `Authorization: Bearer <local-key>`
3. cd-proxy compares the incoming `authorization` header to the exact configured bearer value.
4. On mismatch, cd-proxy returns JSON 401.
5. The local API key is never forwarded upstream.
6. The upstream `Authorization` header is always replaced with the selected Codex credential's `access_token`.

## 4. Path normalization flow

Supported client paths map like this:

| Client path | Internal path | Upstream behavior |
|---|---|---|
| `/v1/models` | `models` | static local response |
| `/models` | `models` | static local response |
| `/v1/responses` | `responses` | Codex Responses HTTP/SSE or WS |
| `/responses` | `responses` | Codex Responses HTTP/SSE or WS |
| `/codex/responses` | `responses` | Pi/OpenAI-Codex-compatible path |
| `/backend-api/codex/responses` | `responses` | compatibility path |
| `/v1/responses/compact` | `responses/compact` | Codex compact HTTP |
| `/responses/compact` | `responses/compact` | Codex compact HTTP |
| `/codex/responses/compact` | `responses/compact` | Pi/OpenAI-Codex-compatible compact path |
| `/backend-api/codex/responses/compact` | `responses/compact` | compatibility path |

## 5. Credential selection flow

Credential selection uses two layers:

1. Cache affinity lookup.
2. Round-robin fallback.

Granular flow:

1. The proxy computes a cache-affinity key when possible.
2. The proxy asks `CacheAffinityStore.choose(key, tried)` for a matching credential.
3. If affinity returns an eligible credential, that credential is used.
4. If no affinity credential is available, the proxy asks `AuthStore.choose(tried)`.
5. `AuthStore.choose()` starts at the current round-robin index.
6. It skips credentials that are:
   - already tried in this external request
   - disabled
   - cooling down
7. When a credential is picked, the round-robin index advances.
8. If every credential is unavailable, selection fails.
9. On successful upstream use, the proxy binds the affinity key to the selected credential.
10. On retryable failure, the failing credential is cooled down and another credential is tried.

## 6. Cache-affinity key flow

Cache affinity exists to avoid breaking upstream prompt-cache hits across multiple accounts.

### 6.1 Header-based affinity

1. cd-proxy checks configured affinity headers first.
2. Defaults:
   - `session_id`
   - `x-session-affinity`
3. The first non-empty configured header value is used.
4. The value is trimmed.
5. The value is bounded by `CD_PROXY_CACHE_AFFINITY_MAX_VALUE_BYTES`.
6. The normalized key is stored as `cache:<value>`.
7. Header affinity is preferred because it avoids reading/scanning bodies when possible.

### 6.2 HTTP body affinity

1. If no header affinity is found, HTTP/SSE proxying checks the request body.
2. Defaults:
   - `prompt_cache_key`
   - `session_id`
3. The body is already buffered once because retries may need to replay it.
4. cd-proxy scans only root JSON string fields.
5. cd-proxy does not run full `JSON.parse` for affinity.
6. The first matching non-empty root string field becomes the affinity value.
7. The value is normalized the same way as header values.

### 6.3 WebSocket frame affinity

1. WebSocket handshake affinity is based on headers.
2. If the handshake already had an affinity key, cd-proxy binds that key after upgrade success.
3. If the handshake had no affinity key, cd-proxy inspects the first client message only.
4. That first message is normally Pi's `response.create` frame.
5. cd-proxy byte-scans the frame for root JSON fields such as `prompt_cache_key`.
6. If a field is found, cd-proxy binds that key to the already-selected WebSocket credential.
7. Frame forwarding is not blocked by future scans because only the first unbound frame is inspected.

## 7. Cache-affinity storage flow

1. `CacheAffinityStore` keeps a bounded in-memory `Map`.
2. Each entry stores:
   - selected auth file path
   - expiry timestamp
   - last-used timestamp
3. On lookup hit:
   1. The selected auth path is resolved via an O(1) map.
   2. Disabled or cooling credentials are rejected.
   3. The entry expiry is extended by the configured TTL.
   4. The entry is moved to the back of the `Map` for LRU behavior.
4. On bind:
   1. Existing entry is replaced/moved.
   2. Bind/rebind stats are updated.
   3. Hot-path pruning evicts old front entries only when possible.
5. On full prune:
   1. Expired entries are removed.
   2. Entries pointing to deleted auth files are removed.
   3. Oldest entries are removed until max size is respected.
6. The map never stores request bodies or responses.

## 8. HTTP/SSE proxy flow

HTTP/SSE proxying is handled by `proxyWithRotation()` in `src/http-proxy.ts`.

1. Increment `responsesHttpRequests` for `/responses` and `/responses/compact`.
2. Read the request body once into an `ArrayBuffer` unless method is `GET` or `HEAD`.
3. Compute cache-affinity key:
   1. check headers
   2. otherwise byte-scan body fields
4. Queue optional debug request capture.
5. Select a credential via affinity or round-robin.
6. Ensure the credential token is fresh.
7. Build upstream headers:
   1. copy incoming headers
   2. remove `host`
   3. remove `connection`
   4. remove `content-length`
   5. replace `authorization` with upstream Codex bearer token
   6. set `content-type` to incoming value or `application/json`
   7. set `ChatGPT-Account-ID` when the credential has an account id
   8. set `accept: text/event-stream` for non-GET requests when absent
8. Send request to the Codex upstream URL.
9. If upstream returns `401`:
   1. read response text for diagnostics
   2. refresh the credential
   3. retry the same upstream request once with the refreshed token
   4. if retry succeeds with non-retryable status, return it
   5. otherwise cool the credential and continue to the next credential
10. If upstream returns a retryable status:
    1. read response text for diagnostics
    2. cool the credential
    3. try the next credential
11. If upstream returns a non-retryable status:
    1. bind cache affinity to the successful credential
    2. return the upstream response stream directly to the client
12. If fetch throws:
    1. treat as `502`
    2. cool the credential briefly
    3. try the next credential
13. If no credential succeeds, return a JSON error with the last failure detail.

## 9. WebSocket handshake flow

WebSocket proxying is handled by `proxyWebSocketUpgrade()` in `src/websocket-proxy.ts`.

1. Compute affinity key from handshake headers.
2. Start with an empty `tried` credential list.
3. Select a credential via affinity or round-robin.
4. Ensure the credential token is fresh.
5. Build upstream WebSocket headers:
   1. copy incoming headers
   2. remove `host`
   3. remove `connection`
   4. remove `upgrade`
   5. remove `content-length`
   6. remove client `authorization`
   7. remove client `chatgpt-account-id`
   8. remove `sec-websocket-key`
   9. remove `sec-websocket-version`
   10. remove `sec-websocket-extensions`
   11. remove `sec-websocket-protocol`
   12. set upstream `authorization` to the selected Codex bearer token
   13. set upstream `ChatGPT-Account-ID` from the selected credential
6. Open the upstream WebSocket first.
7. Set upstream binary type to `arraybuffer`.
8. Start an upstream connect timeout.
9. If upstream opens:
   1. increment `responsesWebSocketUpstreamOpens`
   2. mark upstream open
   3. flush any queued client-to-upstream messages
   4. resolve connect success
10. If upstream errors before open:
    1. close upstream
    2. cool the credential
    3. try next credential
11. If upstream closes before open:
    1. close upstream
    2. cool the credential
    3. try next credential
12. If upstream times out:
    1. close upstream
    2. cool the credential
    3. try next credential
13. Only after upstream succeeds does cd-proxy upgrade the client connection.
14. If client upgrade fails, cd-proxy closes the already-open upstream socket.
15. If client upgrade succeeds:
    1. bind header affinity if present
    2. queue optional debug handshake capture
    3. increment `responsesWebSocketUpgrades`
    4. return control to Bun's WebSocket handler

## 10. WebSocket client-open flow

When Bun finishes upgrading the client socket:

1. `websocket.open()` runs.
2. cd-proxy attaches the downstream client socket to the upstream socket via an internal reference.
3. Any upstream messages that arrived before the client socket opened are flushed downstream.
4. From this point forward, upstream messages can be forwarded directly to the client.

## 11. WebSocket client-to-upstream frame flow

For each client message:

1. Bun invokes `websocket.message()`.
2. cd-proxy calls `handleClientWebSocketMessage()`.
3. If no affinity has been bound for this WebSocket yet:
   1. mark frame affinity as checked
   2. byte-scan this first frame for a body affinity key
   3. if found, bind the key to the WebSocket's selected credential
4. Queue optional debug capture for the client frame.
5. If upstream is open, send the message upstream immediately.
6. If upstream is not yet open, queue the message.
7. The queued message is flushed when the upstream open event fires.

In normal operation, upstream is already open before the client is upgraded, so client frames go straight upstream.

## 12. WebSocket upstream-to-client frame flow

For each upstream message:

1. The upstream WebSocket receives a frame.
2. cd-proxy reads `event.data`.
3. If downstream client is open, send the payload to the client immediately.
4. If downstream client is not open yet, queue it in `downstreamQueue`.
5. Check whether the frame is a terminal response event.
6. Terminal detection fast path:
   1. string frames check compact prefixes first
   2. binary frames use Zig helper when available
   3. fallback decodes and parses only when needed
7. If terminal, increment `responsesWebSocketTerminalEvents`.
8. cd-proxy does not modify the frame payload.

## 13. WebSocket close/error flow

### 13.1 Upstream closes after open

1. Upstream close event fires.
2. cd-proxy finds the downstream client socket.
3. cd-proxy closes the client socket with the upstream code/reason when possible.

### 13.2 Upstream errors after open

1. Upstream error event fires.
2. cd-proxy finds the downstream client socket.
3. cd-proxy closes the client socket with `1011 upstream websocket error`.

### 13.3 Client closes

1. Bun invokes `websocket.close()`.
2. cd-proxy closes the upstream socket.
3. Any Pi-side cached WebSocket entry will observe the close according to Pi's provider logic.

## 14. Pi `websocket` flow

For `transport: "websocket"`:

1. Pi builds a Codex Responses request body.
2. Pi sends a WebSocket upgrade to cd-proxy `/codex/responses` or `/v1/responses`.
3. Pi includes `OpenAI-Beta: responses_websockets=2026-02-06`.
4. Pi includes `session_id` and `x-client-request-id`.
5. cd-proxy opens the upstream Codex WebSocket first.
6. cd-proxy upgrades the client only after upstream succeeds.
7. Pi sends `response.create` over the WebSocket.
8. cd-proxy forwards it unchanged.
9. Upstream streams response events over the WebSocket.
10. cd-proxy forwards them unchanged.
11. Pi receives and processes the events.
12. On terminal event, cd-proxy increments terminal stats.
13. Pi closes or lets the socket close according to its transport behavior.

## 15. Pi `websocket-cached` flow

For `transport: "websocket-cached"`:

1. Pi creates or reuses a per-session WebSocket.
2. The cache key is the Pi session id.
3. Pi opens the WebSocket through cd-proxy if no reusable session socket exists.
4. cd-proxy opens one upstream WebSocket with one selected credential.
5. cd-proxy upgrades Pi's client socket.
6. Pi sends the first `response.create` with full context.
7. cd-proxy forwards the full-context frame unchanged.
8. Upstream returns response events.
9. Pi stores continuation state after successful completion:
   - previous full request body
   - upstream response id
   - assistant response items
10. Pi keeps the WebSocket alive for its idle cache window.
11. On the next turn with the same session id, Pi reuses the same WebSocket if it is idle and open.
12. No new cd-proxy handshake occurs for that reused socket.
13. Pi validates that the new request shape matches the previous one except for `input` / `previous_response_id`.
14. Pi validates that the new input starts with the previous input plus assistant response items.
15. If validation passes, Pi sends:
    - `previous_response_id`
    - delta-sized `input`
16. cd-proxy forwards that delta frame unchanged.
17. The same upstream WebSocket and same selected credential are used.
18. This preserves both WebSocket session caching and account-scoped prompt-cache affinity.
19. If Pi's validation fails, Pi sends full context instead.
20. If the cached WebSocket errors, Pi clears continuation state and closes/drops the socket.

## 16. Debug request capture flow

Debug capture is disabled by default.

When `CD_PROXY_DEBUG_SAVE_REQUESTS=1`:

1. cd-proxy creates `CD_PROXY_DEBUG_SAVE_DIR` asynchronously.
2. HTTP requests enqueue a debug record before upstream fetch.
3. WebSocket handshakes enqueue a debug record after successful client upgrade.
4. WebSocket client frames enqueue a debug record when forwarded.
5. Enqueueing is synchronous and bounded.
6. If the queue is full, the debug record is dropped and `dropped` is incremented.
7. Disk writing happens asynchronously from a timer callback.
8. The file name includes timestamp, sequence number, and record kind.
9. Sensitive headers are redacted:
   - `authorization`
   - `proxy-authorization`
   - `cookie`
   - `set-cookie`
   - headers containing `api-key`
   - headers containing `token`
   - headers containing `secret`
10. `ChatGPT-Account-ID` is partially redacted.
11. Body/frame capture is limited by `CD_PROXY_DEBUG_SAVE_BODY_BYTES`.
12. Text-looking payloads are saved as UTF-8.
13. Binary-looking payloads are saved as base64.
14. Capture stats are visible in `/health` and `/status`.

Important: request bodies can contain prompts, code, and tool data. Enable capture only in trusted debugging environments.

## 17. Token refresh flow

1. Before a credential is used, `AuthStore.ensureFresh()` checks expiry.
2. If the token is not near expiry, no refresh occurs.
3. If the token is near expiry, `AuthStore.refresh()` starts.
4. Concurrent refreshes for the same credential share `refreshInFlight`.
5. Refresh uses the Codex OAuth refresh token flow.
6. On refresh success:
   - access token is updated
   - refresh token is updated
   - id token is updated when present
   - expiry is recomputed
   - email/account id metadata is backfilled when possible
   - auth file is persisted with mode `0600`
7. On refresh failure:
   - the credential is cooled down
   - the request tries another credential when possible

## 18. Retry and cooldown flow

1. Retryable HTTP statuses are configured by `CD_PROXY_RETRYABLE_HTTP_STATUSES`.
2. Defaults:
   - `401`
   - `403`
   - `408`
   - `409`
   - `425`
   - `429`
   - `500`
   - `502`
   - `503`
   - `504`
3. For `401`, cd-proxy refreshes once before rotating.
4. For `401`, `403`, and `429`, cooldown uses `CD_PROXY_COOLDOWN_MS`.
5. For most transient 5xx/network failures, cooldown is capped to 5 seconds.
6. A cooled credential is skipped by both affinity and round-robin selection.
7. If an affinity credential is cooling, cd-proxy can select another credential.
8. On success with another credential, affinity is rebound to the successful credential.

## 19. Stats flow

`transport_stats` contains:

| Stat | Increment point |
|---|---|
| `responsesHttpRequests` | HTTP `/responses` or `/responses/compact` enters proxying |
| `responsesWebSocketUpgrades` | client WebSocket upgrade succeeds |
| `responsesWebSocketUpstreamOpens` | upstream WebSocket open event fires |
| `responsesWebSocketTerminalEvents` | upstream terminal response event is detected |

`cache_affinity` contains:

| Stat | Meaning |
|---|---|
| `lookups` | affinity lookup attempts |
| `hits` | usable affinity credential found |
| `misses` | no entry or expired/missing entry |
| `binds` | new key bound to credential |
| `rebinds` | key moved to a different credential |
| `evictions` | entries removed |
| `unavailable` | entry existed but credential was disabled/cooling/excluded |

`debug_request_capture` contains:

| Stat | Meaning |
|---|---|
| `queued` | records accepted into queue |
| `saved` | records written to disk |
| `dropped` | records dropped because queue was full/disabled by max pending |
| `errors` | write/setup errors |
| `pending` | current queue depth |

## 20. What cd-proxy deliberately does not do

1. It does not cache model responses.
2. It does not cache request bodies for reuse.
3. It does not mutate Pi `response.create` payloads.
4. It does not synthesize `previous_response_id`.
5. It does not implement Pi's WebSocket continuation logic.
6. It does not fall back from WebSocket to SSE internally.
7. It does not expose upstream Codex tokens to clients.
8. It does not delegate runtime proxying to another local process.

cd-proxy's caching responsibility is deliberately narrow: keep the same cache/session key on the same upstream credential and avoid interfering with Pi/provider cache protocols.
