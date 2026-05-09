# Benchmarks

Request/response and proxy hot-path benchmarks live in `benchmarks/`.

Fast feedback loop:

```bash
bun run bench
bun run bench:request-response
bun run bench:proxy-hot-path
bun run bench:stage-profile
bun run bench:local-loop
```

Full feedback loop:

```bash
CD_PROXY_BENCH_FAST=0 bun run bench:request-response
CD_PROXY_BENCH_FAST=0 bun run bench:proxy-hot-path
CD_PROXY_BENCH_FAST=0 bun run bench:stage-profile
CD_PROXY_BENCH_FAST=0 bun run bench:local-loop
```

Run all benchmark layers:

```bash
bun run bench:all
```

These benchmarks separate micro paths from macro proxy behavior. They cover request routing, response-body generation, WebSocket upgrade/header forwarding, response-frame handling, cache-affinity extraction, auth selection, debug-capture no-op overhead, and local-loop end-to-end proxy overhead.

For the divide-and-conquer optimization plan, see [`docs/performance-plan.md`](./docs/performance-plan.md).

## Benchmark layers

| Layer | Script | Purpose |
|---|---|---|
| Synthetic micro | `benchmarks/request-response.ts` | Fast pathname/route/model/WS terminal checks. |
| Runtime hot path | `benchmarks/proxy-hot-path.ts` | Actual modular helpers: headers, affinity scanner, affinity map, auth pick, debug no-op. |
| Stage profile | `benchmarks/stage-profile.ts` | `CD_PROXY_PROFILE=1` per-stage timing for HTTP, WS open, and persistent WS frames. |
| Macro local loop | `benchmarks/local-loop.ts` | End-to-end cd-proxy overhead against a local mock upstream. |

## Latest request/response micro result

Command:

```bash
bun run bench:request-response
```

Environment:

- Bun 1.3.14-canary
- Zig ReleaseFast helper
- Linux x86_64

Results:

| Hot path | Baseline | Optimized | Gain |
|---|---:|---:|---:|
| Request pathname extraction | 687,880 ops/s | 8,164,885 ops/s | 11.87x faster |
| Request route resolution | 798,794 ops/s | 6,162,174 ops/s | 7.71x faster |
| Models response body generation | 181,114 ops/s | 94,168,032 ops/s | 519.94x faster |
| WebSocket upgrade header check | 9,489,668 ops/s | 12,789,230 ops/s | 1.35x faster |
| WebSocket upstream header forwarding | 185,597 ops/s | 283,546 ops/s | 1.53x faster |
| Responses WS terminal event, text | 847,585 ops/s | 71,221,317 ops/s | 84.03x faster |
| Responses WS terminal event, binary | 893,545 ops/s | 1,180,622 ops/s | 1.32x faster |

## Latest runtime hot-path result

Command:

```bash
bun run bench:proxy-hot-path
```

Results:

| Hot path | Result / finding |
|---|---|
| Runtime HTTP `Headers` clone/delete | 815,457 ops/s; kept because candidate JS object path was slower. |
| Candidate single-pass HTTP header object | Rejected; 1.27x slower. |
| Small JSON cache-key scanner | 1,694,765 ops/s; 1.38x faster than `JSON.parse`. |
| 64KiB JSON cache-key scanner | 504,109 ops/s; 18.59x faster than `JSON.parse`. |
| Header affinity key extraction | 7,685,634 ops/s. |
| Cache-affinity lookup hit | 6,498,533 ops/s. |
| Auth round-robin choose one | 17,713,459 ops/s. |
| Debug capture disabled call | 159,487,090 ops/s. |

## Latest stage-profile result

Command:

```bash
bun run bench:stage-profile
```

Findings:

| Path | Dominant stages |
|---|---|
| HTTP with header affinity | `http.fetch` averaged 0.344 ms of 0.427 ms total; network/upstream hop dominates. |
| HTTP with body affinity | `http.fetch` averaged 0.290 ms; `http.affinity_body` averaged 0.041 ms for a 4KiB prompt body. |
| WS open + one frame | `ws.upstream_open_wait` averaged 0.235 ms, `ws.client_upgrade` 0.136 ms, `ws.upstream_ctor` 0.079 ms; double handshake dominates. |
| Persistent WS frame loop | per-frame send and upstream-message forwarding were ~0.01 ms each; handshake cost is amortized. |

## Latest local-loop macro result

Command:

```bash
bun run bench:local-loop
```

Bun runtime result:

| Path | Avg latency | Throughput |
|---|---:|---:|
| Proxy `GET /v1/models` | 0.217 ms | 4,601.2 ops/s |
| Direct mock `POST /responses` | 0.152 ms | 6,575.4 ops/s |
| Proxy `POST /v1/responses` | 0.774 ms | 1,291.6 ops/s |
| Direct mock WS open + roundtrip | 0.315 ms | 3,176.2 ops/s |
| Proxy WS open + roundtrip | 1.143 ms | 874.6 ops/s |

Takeaway: the default runtime remains Bun because Bun's evented WebSocket implementation is faster than the old pure Zig WebSocket bridge. Zig remains as a Bun FFI hot-path helper and native auth/HTTP checker.
