# cd-proxy performance divide-and-conquer plan

Goal: improve proxy speed without breaking:

- Codex OAuth correctness
- credential rotation/failover
- WebSocket-first behavior
- Pi `websocket-cached` preservation
- prompt-cache/session affinity
- bounded debug/debug-profile overhead

## 1. Benchmarking rules

1. Benchmark micro paths and macro request loops separately.
2. Benchmark candidates against the current runtime, not only theoretical baselines.
3. Keep a fast loop for frequent checks and a full loop before claiming final numbers.
4. Run correctness tests after every accepted speed change.
5. Treat micro wins that hurt macro latency as regressions.
6. Prefer avoiding work over making unnecessary work faster.

## 2. Commands

Fast loop:

```bash
bun run bench:request-response
bun run bench:proxy-hot-path
bun run bench:stage-profile
bun run bench:local-loop
```

Full loop:

```bash
CD_PROXY_BENCH_FAST=0 bun run bench:request-response
CD_PROXY_BENCH_FAST=0 bun run bench:proxy-hot-path
CD_PROXY_BENCH_FAST=0 bun run bench:stage-profile
CD_PROXY_BENCH_FAST=0 bun run bench:local-loop
```

Correctness gate:

```bash
bun run test
```

## 3. Benchmark layers

| Layer | Script | Purpose |
|---|---|---|
| Synthetic micro | `benchmarks/request-response.ts` | Route parsing, models body, WS header checks, terminal event detection. |
| Runtime hot path | `benchmarks/proxy-hot-path.ts` | Actual helpers: headers, affinity scanner/map, auth pick, debug no-op. |
| Stage profile | `benchmarks/stage-profile.ts` | Runs with `CD_PROXY_PROFILE=1` and prints exact per-stage timings. |
| Persistent WS throughput | `benchmarks/ws-throughput.ts` | Direct vs proxied frame throughput on one reused WebSocket. |
| Macro local loop | `benchmarks/local-loop.ts` | End-to-end proxy overhead against a local mock upstream. |

## 4. Latest fast-loop baseline

### 4.1 `bench:request-response`

| Path | Result |
|---|---:|
| Request pathname extraction | 10,059,204 ops/s |
| Request route resolution | 7,781,028 ops/s |
| Cached models body | 83,314,032 ops/s |
| WS upgrade header check | 17,778,744 ops/s |
| WS upstream header forwarding | 409,212 ops/s |
| WS terminal event, text | 110,896,366 ops/s |
| WS terminal event, binary Zig helper | 1,700,132 ops/s |

### 4.2 `bench:proxy-hot-path`

| Path | Finding |
|---|---|
| Runtime HTTP header construction | 404,043 ops/s. |
| Small JSON cache-key scanner | 852,756 ops/s; 1.65x faster than `JSON.parse`. |
| 64KiB JSON cache-key scanner | 330,678 ops/s; 16.26x faster than `JSON.parse`. |
| Header affinity key extraction | 3,889,235 ops/s. |
| Cache-affinity lookup hit | 4,022,436 ops/s. |
| Auth round-robin choose one | 12,101,532 ops/s. |
| Debug capture disabled call | 114,100,545 ops/s. |

### 4.3 `bench:stage-profile`

| Flow | Primary bottleneck | Persistent fix / posture |
|---|---|---|
| HTTP with `session_id` header affinity | `http.fetch` ~1.063 ms of ~1.256 ms. | Keep header affinity; upstream/network hop dominates. |
| HTTP body-only affinity | `http.fetch` dominates; body scan ~0.083 ms for 4KiB body. | Prefer `session_id` header; keep scanner fallback. |
| WS open + one frame | upstream open wait, client upgrade, upstream ctor dominate. | Use Pi `websocket-cached` to amortize handshakes. |
| Persistent WS frames | send/forward ~0.015 ms each; terminal detection tiny. | Focus on persistent sessions and avoid per-frame optional work. |
| Debug capture disabled | effectively free. | Keep disabled by default; bounded async when enabled. |

### 4.4 `bench:local-loop`

| Path | Avg latency | Throughput |
|---|---:|---:|
| Proxy `GET /v1/models` | 0.217 ms | 4,601.2 ops/s |
| Direct mock `POST /responses` | 0.152 ms | 6,575.4 ops/s |
| Proxy `POST /v1/responses` | 0.774 ms | 1,291.6 ops/s |
| Direct mock WS open+roundtrip | 0.315 ms | 3,176.2 ops/s |
| Proxy WS open+roundtrip | 1.143 ms | 874.6 ops/s |

## 5. Bottleneck map by implementation area

### 5.1 Startup/auth load

Runtime work:

1. read env
2. load Zig helper
3. load API key
4. parse auth JSON
5. compute expiry
6. build auth maps

Status: not per request except periodic reload. Optimize only for large auth pools.

Next benchmark: auth load time with 10, 100, 1,000, 10,000 auth files.

### 5.2 Route dispatch

Runtime work:

1. extract pathname
2. detect WebSocket upgrade
3. switch on route
4. dispatch

Status: already fast; avoid `new URL()` on hot path.

Persistent fix: keep allocation-free extractor and switch route table.

### 5.3 Credential selection

Runtime work:

1. affinity lookup
2. round-robin fallback
3. skip disabled/cooling/tried credentials
4. optional Zig large-pool picker

Status: not a bottleneck for normal pools.

Persistent fix: keep JS path for small pools; benchmark before lowering Zig threshold.

### 5.4 Token refresh

Runtime work:

1. check expiry
2. refresh when near expiry
3. persist refreshed auth

Status: rare; `refreshInFlight` deduplicates concurrent refreshes.

Persistent fix: keep refresh out of normal request path via refresh skew.

### 5.5 Cache-affinity extraction

Runtime work:

1. check headers first
2. scan root JSON only when needed
3. normalize bounded value

Status: header affinity is cheap; body scanner is now much faster for large prompts.

Persistent fix:

- Keep clients sending `session_id`.
- Keep byte scanner fallback.
- Add body-size sweeps for 1KiB, 16KiB, 64KiB, 256KiB, 1MiB.

### 5.6 HTTP/SSE proxy

Runtime work:

1. read body once for retry replay
2. compute affinity
3. pick credential
4. ensure fresh token
5. build headers
6. fetch upstream
7. stream upstream response

Precise bottleneck: upstream fetch/hop dominates local proxy CPU stages.

Persistent fix:

- Do not over-optimize header construction without proof.
- Prefer header affinity to skip body scan.
- Consider explicit no-retry streaming mode only if reliability tradeoff is acceptable.

### 5.7 WebSocket handshake

Runtime work:

1. pick credential
2. ensure fresh token
3. build headers
4. open upstream WS first
5. upgrade client after upstream succeeds
6. bind affinity

Precise bottleneck: double handshake and upstream open wait dominate.

Persistent fix:

- Keep upstream-before-client for reliability.
- Use Pi `websocket-cached` so this cost is paid once per session, not once per turn.
- Benchmark stage timings when changing WS handshake code.

### 5.8 WebSocket frames

Runtime work:

1. optional first-frame affinity scan
2. optional debug enqueue
3. upstream send
4. downstream send
5. terminal event detection

Precise bottleneck: per-frame forwarding is small once socket is persistent.

Persistent fix:

- Keep debug capture disabled by default.
- Only scan first unbound frame.
- Keep terminal detection fast path and Zig binary helper.

### 5.9 Debug capture/profile

Runtime work when disabled: immediate no-op.

Runtime work when enabled:

1. bounded enqueue
2. async JSON serialization/write
3. drop when queue full

Persistent fix: keep disabled by default, bounded and async when enabled.

## 6. Accepted / rejected decisions

| Candidate | Decision | Evidence |
|---|---|---|
| Fast pathname extractor | Accepted | 11.87x faster than `new URL().pathname`. |
| Prebuilt models body | Accepted | Hundreds of times faster than per-request stringify. |
| Text terminal-event sentinel | Accepted | Tens of millions ops/s, avoids per-frame `JSON.parse`. |
| Zig binary terminal detector | Accepted | Faster than decoded JSON parse for binary frames. |
| Native quote-search JSON scanner | Accepted | 64KiB body scan ~16x faster than `JSON.parse`. |
| `CD_PROXY_PROFILE` stage profiler | Accepted | Provides precise stage timings without default runtime work. |
| Native C/Rust ports | Not kept | Benchmarks did not show a meaningful end-to-end speedup on dominant paths, so no native port code is retained. |

## 7. Next optimization backlog

### Phase A: persistent WebSocket throughput

1. Keep `benchmarks/ws-throughput.ts` in the regular benchmark loop.
2. Track terminal and non-terminal frame overhead separately.
3. Current local proxy overhead is roughly 0.12-0.20 ms/frame on a reused WS.
4. Add a debug-capture-enabled variant.
5. Add binary-frame variant if upstream starts sending binary frames often.

Why: this reflects Pi `websocket-cached`, where handshake cost is amortized.

### Phase B: body-affinity sweep

1. Benchmark prompt body sizes from 1KiB to 1MiB.
2. Test cache key before and after large `input`.
3. Confirm scanner stays ahead of `JSON.parse`.
4. Document when clients should always send `session_id` header.

### Phase C: large credential pools

1. Benchmark 1, 10, 100, 1,000, 10,000 credentials.
2. Compare JS picker vs Zig picker.
3. Tune `ZIG_PICK_THRESHOLD` from data.

### Phase D: optional HTTP no-retry streaming mode

1. Prototype behind explicit env flag only.
2. Skip request-body buffering when safe.
3. Benchmark HTTP latency.
4. Reject unless reliability tradeoff is clear and documented.

## 8. Candidate checklist

For every speed change:

1. State the hypothesis.
2. Pick or add a benchmark.
3. Run baseline.
4. Implement the change.
5. Run benchmark again.
6. Run local-loop macro benchmark.
7. Run `bun run test`.
8. Document accepted/rejected status.
