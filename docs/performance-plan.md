# cd-proxy performance divide-and-conquer plan

Goal: improve proxy speed without sacrificing the properties that matter most for cd-proxy:

- upstream Codex OAuth correctness
- credential rotation/failover
- WebSocket-first behavior
- Pi `websocket-cached` preservation
- prompt-cache/session affinity
- bounded debug capture overhead

This plan breaks the proxy into measurable hot-path units so each speed change has a benchmark before it lands.

## 1. Benchmarking rules

1. Benchmark micro paths and macro request loops separately.
2. Keep fast feedback benchmarks short enough to run often.
3. Use full benchmarks before claiming a final number.
4. Benchmark candidates against the current runtime, not only against theoretical baselines.
5. Keep correctness tests in the loop after every optimization.
6. Treat any optimization that improves a microbenchmark but worsens macro latency as suspicious.
7. Prefer deleting or avoiding work over making unnecessary work faster.

## 2. Benchmark commands

Fast loop:

```bash
bun run bench:request-response
bun run bench:proxy-hot-path
bun run bench:local-loop
```

Full loop:

```bash
CD_PROXY_BENCH_FAST=0 bun run bench:request-response
CD_PROXY_BENCH_FAST=0 bun run bench:proxy-hot-path
CD_PROXY_BENCH_FAST=0 bun run bench:local-loop
```

Correctness gate:

```bash
bun run test
```

## 3. Current benchmark layers

| Layer | Script | Purpose |
|---|---|---|
| Micro synthetic | `benchmarks/request-response.ts` | Route parsing, models body, WS header checks, terminal event detection. |
| Runtime hot path | `benchmarks/proxy-hot-path.ts` | Actual module helpers: HTTP headers, JSON affinity scan, affinity map, auth pick, debug no-op. |
| Macro local loop | `benchmarks/local-loop.ts` | End-to-end proxy overhead against a local mock upstream. |

## 4. Latest fast-loop baseline

Environment from local run:

- Bun 1.3.14-canary
- Zig ReleaseFast helper built by `bun run zig:build`
- Local mock upstream on loopback

### 4.1 `bench:request-response`

| Path | Result |
|---|---:|
| Request pathname extraction | 8,164,885 ops/s |
| Request route resolution | 6,162,174 ops/s |
| Cached models body | 94,168,032 ops/s |
| WS upgrade header check | 12,789,230 ops/s |
| WS upstream header forwarding | 283,546 ops/s |
| WS terminal event, text | 71,221,317 ops/s |
| WS terminal event, binary Zig helper | 1,180,622 ops/s |

### 4.2 `bench:proxy-hot-path`

| Path | Result | Finding |
|---|---:|---|
| Runtime HTTP `Headers` clone/delete | 537,438 ops/s | Faster than candidate JS object path. Keep current. |
| Candidate single-pass HTTP header object | 401,290 ops/s | Rejected: 1.34x slower. |
| Small JSON cache-key scanner | 1,158,526 ops/s | 1.44x faster than `JSON.parse`. |
| 64KiB body cache-key scanner | 367,077 ops/s | 16.55x faster than `JSON.parse`. |
| Header affinity key extraction | 4,122,143 ops/s | Cheap enough for hot path. |
| Affinity lookup hit | 3,800,007 ops/s | Cheap enough for hot path. |
| Auth round-robin choose one | 13,930,759 ops/s | Not currently bottleneck. |
| Debug capture disabled call | 135,552,196 ops/s | Disabled capture is effectively no-op. |

### 4.3 `bench:local-loop`

| Path | Avg latency | Throughput |
|---|---:|---:|
| Proxy `GET /v1/models` | 0.592 ms | 1,689.8 ops/s |
| Direct mock `POST /responses` | 0.382 ms | 2,617.7 ops/s |
| Proxy `POST /v1/responses` | 1.371 ms | 729.2 ops/s |
| Direct mock WS open+roundtrip | 0.570 ms | 1,753.3 ops/s |
| Proxy WS open+roundtrip | 1.391 ms | 718.7 ops/s |

## 5. Hot-path decomposition

### 5.1 Startup path

Runtime work:

1. read env
2. load Zig helper
3. load API key
4. read auth files
5. parse auth JSON
6. compute expiry
7. build auth maps
8. start Bun server

Speed posture:

- Not per-request except periodic auth reload.
- Keep correctness first.
- Only optimize when auth pool is very large.

Benchmarks:

- auth load time with N auth files
- Zig auth parser vs Bun `JSON.parse`
- JWT expiry parse JS vs Zig helper

Priority: low unless auth pools become large.

### 5.2 Route dispatch path

Runtime work:

1. extract pathname
2. check WS upgrade
3. route via switch
4. reject or dispatch

Current status:

- Fast pathname extractor already avoids `new URL()`.
- Switch routing is fast.

Potential next work:

- Export actual routing helpers and benchmark imported runtime functions instead of duplicated benchmark code.
- Keep avoiding allocation in routing.

Priority: low.

### 5.3 Local auth check

Runtime work:

1. `req.headers.get("authorization")`
2. exact compare to configured local bearer value

Current status:

- Very small overhead.
- Required for security when local API key exists.

Potential next work:

- None unless profiling proves it matters.

Priority: low.

### 5.4 Credential selection

Runtime work:

1. affinity lookup
2. round-robin fallback
3. skip disabled/cooling/tried credentials
4. maybe Zig large-pool picker

Current benchmark:

- affinity hit: ~5.2M ops/s
- one-auth round-robin: ~12.4M ops/s

Potential next work:

- Add benchmark for 10, 100, 1,000, 10,000 credentials.
- Define threshold where Zig picker becomes worthwhile.
- Keep JS path for normal pools because FFI overhead can lose.

Priority: medium for large account pools, low otherwise.

### 5.5 Token refresh path

Runtime work:

1. check expiry
2. refresh before use when close to expiry
3. persist refreshed auth file

Current status:

- Mostly outside hot path because refresh is rare.
- `refreshInFlight` deduplicates concurrent refreshes.

Potential next work:

- Record refresh timing in debug/status counters.
- Benchmark expiry parsing only for large auth reloads.

Priority: low.

### 5.6 Cache affinity key extraction

Runtime work:

1. check headers first
2. if no header, scan body/root frame
3. normalize bounded value

Current benchmark:

- header extraction: ~4.9M ops/s
- small body scanner: 1.35x faster than `JSON.parse`
- 64KiB body scanner: 16.88x faster than `JSON.parse`

Recent improvement:

- The JSON scanner now uses native quote search while keeping root-depth tracking.
- This avoids recursive skipping of large `input` arrays.

Potential next work:

- Add body-size sweep: 1KiB, 16KiB, 64KiB, 256KiB, 1MiB.
- Add field-order sweep: key before `input`, key after `input`.
- Encourage clients to send `session_id` header to avoid body scanning entirely.

Priority: high because it protects large prompt paths.

### 5.7 HTTP/SSE proxy path

Runtime work:

1. read body once for replay
2. compute affinity
3. choose credential
4. ensure token fresh
5. build upstream headers
6. `fetch()` upstream
7. return upstream stream
8. rotate on retryable failure

Current benchmark:

- local-loop proxy POST: ~1.371 ms average
- local direct POST: ~0.382 ms average
- proxy overhead: ~0.989 ms/request

Rejected candidate:

- Single-pass JS object header construction was slower than Bun `Headers` clone/delete.

Potential next work:

- Add local-loop scenarios with:
  - one credential vs many credentials
  - header affinity vs body affinity
  - debug capture off vs on
  - no retry vs retryable failure
- Investigate whether body buffering can be skipped for explicitly no-retry single-credential mode.
- Keep default reliable replay behavior.

Priority: medium.

### 5.8 WebSocket handshake path

Runtime work:

1. validate local auth
2. select credential
3. ensure token fresh
4. build upstream WS headers
5. open upstream WS first
6. only then upgrade client
7. bind affinity

Current benchmark:

- local-loop proxy WS open+roundtrip: ~1.391 ms
- direct WS open+roundtrip: ~0.570 ms
- proxy overhead: ~0.821 ms

Important constraint:

- Opening upstream before client upgrade is intentionally reliable.
- It avoids giving Pi a successful WS if upstream auth/handshake fails.

Potential next work:

- Benchmark handshake stages separately:
  - selected credential only
  - upstream open time
  - client upgrade time
  - first frame forwarding
- Improve header construction only if imported runtime benchmark proves a win.
- Avoid pooling generic WS unless protocol semantics are proven safe.

Priority: high for perceived latency, but correctness constraints are strict.

### 5.9 WebSocket frame forwarding path

Runtime work:

1. optional first-frame affinity scan
2. optional debug enqueue
3. `upstream.send(message)`
4. downstream sends upstream frames
5. terminal event detection for stats

Current status:

- Text terminal event detection is already very fast.
- Binary terminal event detection uses Zig helper.

Potential next work:

- Add persistent-WS frame throughput benchmark, not only open+roundtrip.
- Benchmark with debug capture off/on.
- Benchmark terminal detection disabled vs enabled to quantify stats cost.

Priority: high for long-running `websocket-cached` sessions.

### 5.10 Debug capture path

Runtime work when disabled:

1. immediate return

Runtime work when enabled:

1. enqueue bounded record
2. serialize/write later from async drain
3. drop records if queue full

Current benchmark:

- disabled call: ~133M ops/s

Potential next work:

- Add enabled benchmark with tmpfs and bounded sample size.
- Add separate benchmark for enqueue-only vs write drain.
- Consider sampling mode if enabled capture is too expensive under load.

Priority: low by default, medium for debugging sessions.

## 6. Divide-and-conquer optimization backlog

### Phase A: protect correctness and measurement

1. Keep `bun run test` as non-negotiable correctness gate.
2. Add benchmark import coverage for actual route helpers.
3. Add repeated-trial summary to macro benchmark.
4. Add optional JSON output for benchmark trend tracking.

Expected gain: not direct speed; improves confidence.

### Phase B: cache-affinity and body scanning

1. Keep header affinity first.
2. Benchmark key extraction over body-size sweep.
3. Keep native quote-search scanner.
4. Add docs recommending `session_id` header for clients.
5. Consider field-specific fast search only if root-depth safety is preserved.

Expected gain: avoids large-prompt body-scan regressions.

### Phase C: HTTP/SSE proxy overhead

1. Benchmark current Bun `Headers` clone/delete vs alternatives before changing.
2. Add local-loop matrix for header/body affinity.
3. Investigate no-retry streaming mode behind an explicit env flag.
4. Only adopt if it preserves default reliability.

Expected gain: lower HTTP POST overhead in special cases.

### Phase D: WebSocket open latency

1. Break local-loop WS benchmark into handshake sub-stages.
2. Measure upstream mock open time separately.
3. Measure client upgrade time separately.
4. Measure first-frame path separately.
5. Avoid generic upstream WS pooling unless Codex protocol safety is proven.

Expected gain: identify whether latency is mostly unavoidable double-handshake or local overhead.

### Phase E: Persistent WebSocket throughput

1. Add benchmark that opens one proxied WS and sends N frames.
2. Compare direct mock WS vs proxied WS.
3. Measure `websocket-cached` style reuse.
4. Measure with first-frame affinity already bound.
5. Measure terminal event detection overhead.

Expected gain: optimize the path Pi uses most in `websocket-cached` mode.

### Phase F: Large credential pools

1. Benchmark 1, 10, 100, 1,000, 10,000 credentials.
2. Compare JS picker vs Zig picker.
3. Tune `ZIG_PICK_THRESHOLD` from data.
4. Keep JS for small pools.

Expected gain: scalable account rotation without slowing normal deployments.

## 7. Candidate changes must pass this checklist

For every speed change:

1. State the hypothesis.
2. Add or choose a benchmark that isolates it.
3. Run baseline.
4. Implement change.
5. Run benchmark again.
6. Run macro local-loop benchmark.
7. Run `bun run test`.
8. Document whether the candidate was accepted or rejected.

## 8. Accepted / rejected decisions so far

| Candidate | Decision | Evidence |
|---|---|---|
| Fast pathname extractor | Accepted | ~9x faster than `new URL().pathname`. |
| Prebuilt models body | Accepted | hundreds of times faster than per-request stringify. |
| Text terminal-event sentinel | Accepted | tens of millions ops/s, avoids per-frame `JSON.parse`. |
| Zig binary terminal detector | Accepted | faster than decoded JSON parse for binary frames. |
| Single-pass HTTP header object | Rejected | runtime benchmark showed it slower than Bun `Headers`. |
| Native quote-search JSON affinity scanner | Accepted | 64KiB body scan became ~16.6x faster than `JSON.parse`. |

## 9. Immediate next benchmark to add

The next most useful benchmark is a persistent WebSocket throughput test:

1. Start mock upstream.
2. Start cd-proxy.
3. Open one direct mock WS.
4. Open one proxied WS.
5. Send N `response.create`-like frames on each.
6. Measure per-frame latency and throughput.
7. Repeat with terminal-event frames and non-terminal frames.
8. Repeat with debug capture enabled.

This directly reflects Pi `websocket-cached`, where handshake cost is amortized and frame path speed matters most.
