# Pi SSE, WebSocket, and GPT/Codex connectivity

## Transports

- **SSE**: `POST /v1/responses` or `/codex/responses` over HTTP streaming.
- **WebSocket**: `WS /v1/responses` or `/codex/responses`.
- Pi selects this with `transport` in settings:

```json
{ "transport": "websocket" }
```

Use `"websocket"` for this repo. It disables Pi's `auto` SSE fallback.

## Speed notes

- **WebSocket is fastest for Codex/GPT agent turns**: one upgrade, bidirectional frames, less stream parsing, lower latency for tool/event traffic.
- **`websocket-cached` can be fastest for repeated Codex turns**: Pi may reuse the WS and send `previous_response_id` deltas.
- **SSE is simpler and widely compatible**: one HTTP stream per response, good fallback, usually a little more overhead.
- cd-proxy keeps the fast path in **Bun** for WebSockets; Zig only helps hot-path parsing/selection.

## GPT/Codex models through cd-proxy

Configure Pi in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "cd-proxy": {
      "baseUrl": "http://127.0.0.1:8318",
      "api": "openai-codex-responses",
      "apiKey": "!cat ~/.config/cd-proxy/api-key",
      "models": [
        { "id": "gpt-5.3-codex", "reasoning": true }
      ]
    }
  }
}
```

cd-proxy advertises models from `CD_PROXY_MODELS`.
Default: `gpt-5.3-codex,gpt-5.3-codex-spark,codex-auto-review,gpt-5.5,gpt-5.2`.
