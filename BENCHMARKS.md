# Benchmarks

Request/response hot-path benchmarks live in `benchmarks/`.

Run the fast feedback loop:

```bash
bun run bench
# or
bun run bench:request-response
```

Run the local-loop macro benchmark against a mock upstream:

```bash
bun run bench:local-loop
# compare runtimes
CD_PROXY_BENCH_IMPL=bun bun run bench:local-loop
CD_PROXY_BENCH_IMPL=zig bun run bench:local-loop
```

For a longer run:

```bash
CD_PROXY_BENCH_FAST=0 bun run bench:request-response
CD_PROXY_BENCH_FAST=0 bun run bench:local-loop
```

These benchmarks intentionally exclude authentication and credential-loading work. They focus only on request routing, response-body generation, WebSocket upgrade/header forwarding, and WebSocket response-frame handling.

## Latest local result

Command:

```bash
bun run bench:request-response
```

Environment:

- Bun 1.3.14
- Zig 0.16.0
- Zig core built with `-Doptimize=ReleaseFast`
- Linux x86_64

Results:

| Hot path | Baseline | Optimized | Gain |
| --- | ---: | ---: | ---: |
| Request pathname extraction | 975,035 ops/s | 11,024,876 ops/s | 11.31x faster |
| Request route resolution | 1,232,454 ops/s | 9,811,632 ops/s | 7.96x faster |
| Models response body generation | 260,603 ops/s | 167,145,259 ops/s | 641.38x faster |
| WebSocket upgrade header check | 14,393,889 ops/s | 17,689,288 ops/s | 1.23x faster |
| WebSocket upstream header forwarding | 273,627 ops/s | 402,371 ops/s | 1.47x faster |
| Responses WebSocket terminal-event detection, text frames | 1,387,394 ops/s | 134,910,891 ops/s | 97.24x faster |
| Responses WebSocket terminal-event detection, binary frames | 1,443,993 ops/s | 1,534,208 ops/s | 1.06x faster |

## What each benchmark compares

- `new URL(req.url).pathname` vs the runtime fast pathname extractor.
- `new URL + if-chain route matching` vs fast pathname + `switch` route matching.
- Per-request `/models` `JSON.stringify` vs cached response JSON.
- `upgrade?.toLowerCase() === "websocket"` vs allocation-free common-case plus ASCII case-insensitive upgrade checks.
- `Headers` clone + `Object.fromEntries()` vs single-pass WebSocket upstream header object construction.
- Per-frame `JSON.parse` terminal-event detection vs compact root-type text-frame sentinels.
- Per-frame decoded `JSON.parse` for binary frames vs ReleaseFast Zig binary-frame detection.

## Latest local-loop macro result

Commands:

```bash
CD_PROXY_BENCH_IMPL=bun CD_PROXY_BENCH_FAST=1 bun run bench:local-loop
CD_PROXY_BENCH_IMPL=zig CD_PROXY_BENCH_FAST=1 bun run bench:local-loop
```

Runtime comparison:

| Path | Bun fallback | Pure Zig | Change |
| --- | ---: | ---: | ---: |
| Proxy `GET /v1/models` avg latency | 0.147 ms | 0.189 ms | Zig 1.29x slower |
| Proxy `POST /v1/responses` avg latency | 0.319 ms | 0.184 ms | Zig 1.73x faster |
| Proxy `POST /v1/responses` throughput | 3,137.6 ops/s | 5,444.5 ops/s | Zig 1.74x faster |
| Proxy WS open + roundtrip avg latency | 0.694 ms | 1.706 ms | Zig 2.46x slower |
| Proxy WS open + roundtrip throughput | 1,441.6 ops/s | 586.3 ops/s | Zig 0.41x throughput |

Measured pure Zig proxy overhead in that run:

- HTTP Responses POST: 0.064 ms/request over direct mock upstream.
- WebSocket open + one frame: 1.509 ms/request over direct mock upstream.

Takeaway: the pure Zig port already improves the HTTP Responses proxy hot path substantially, while the initial WebSocket bridge prioritizes correctness/parity and still has optimization headroom.
