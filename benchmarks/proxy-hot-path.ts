#!/usr/bin/env bun
import { tmpdir } from "node:os";
import { buildHeaders } from "../src/http-proxy";
import { CacheAffinityStore } from "../src/cache-affinity";
import { DebugRequestCapture } from "../src/debug-capture";
import { AuthStore } from "../src/auth-store";
import { jsonRootStringFieldValue } from "../src/json-root-scan";
import type { AuthEntry } from "../src/types";

const FAST = process.env.CD_PROXY_BENCH_FAST !== "0";
const REPEATS = Number(process.env.CD_PROXY_BENCH_REPEATS ?? (FAST ? "5" : "9"));
const ITERS = Number(process.env.CD_PROXY_BENCH_HOT_ITERS ?? (FAST ? "250000" : "1000000"));
const BODY_ITERS = Number(process.env.CD_PROXY_BENCH_BODY_ITERS ?? (FAST ? "25000" : "100000"));
let sink: unknown;

type Bench = { name: string; hz: number; ms: number; last: unknown };

function benchOnce(name: string, iterations: number, fn: () => unknown): Bench {
  const warmup = Math.min(10_000, Math.max(1_000, Math.floor(iterations / 20)));
  for (let i = 0; i < warmup; i++) sink = fn();
  const start = performance.now();
  let last: unknown;
  for (let i = 0; i < iterations; i++) last = fn();
  const ms = performance.now() - start;
  sink = last;
  return { name, hz: iterations / (ms / 1000), ms, last };
}

function median(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function bench(name: string, iterations: number, fn: () => unknown) {
  const runs: Bench[] = [];
  for (let i = 0; i < REPEATS; i++) runs.push(benchOnce(name, iterations, fn));
  const hz = median(runs.map((r) => r.hz));
  const ms = median(runs.map((r) => r.ms));
  return { name, hz, ms, last: runs[runs.length - 1].last };
}

function print(result: Bench | ReturnType<typeof bench>) {
  console.log(`${result.name.padEnd(42)} ${result.hz.toFixed(0).padStart(12)} ops/s  median=${result.ms.toFixed(2).padStart(8)} ms`);
}

function printPair(label: string, baseline: ReturnType<typeof bench>, optimized: ReturnType<typeof bench>) {
  const ratio = optimized.hz / baseline.hz;
  const faster = ratio >= 1 ? `${ratio.toFixed(2)}x faster` : `${(1 / ratio).toFixed(2)}x slower`;
  console.log(`\n${label}`);
  print(baseline);
  print(optimized);
  console.log(`gain: ${faster}`);
}

const auth: AuthEntry = {
  path: "/tmp/codex-bench.json",
  label: "bench@example.test",
  data: {
    type: "codex",
    email: "bench@example.test",
    account_id: "bench-account",
    access_token: "bench-access-token",
    refresh_token: "bench-refresh-token",
    expired: "2099-01-01T00:00:00Z",
  },
  expiresAtMs: Date.now() + 3600_000,
  coolingUntil: 0,
};

const req = new Request("http://127.0.0.1:8318/v1/responses", {
  method: "POST",
  headers: {
    authorization: "Bearer local-key",
    "content-type": "application/json",
    accept: "text/event-stream",
    session_id: "bench-session",
    "x-client-request-id": "bench-request",
    "chatgpt-account-id": "client-account-should-not-forward",
  },
  body: JSON.stringify({ input: "bench" }),
});

function singlePassHttpHeaders(req: Request, a: AuthEntry): Record<string, string> {
  const h: Record<string, string> = {};
  let hasAccept = false;
  let hasContentType = false;
  for (const [name, value] of req.headers) {
    switch (name) {
      case "host":
      case "connection":
      case "content-length":
      case "authorization":
      case "chatgpt-account-id":
        continue;
      case "accept":
        hasAccept = true;
        h.accept = value;
        continue;
      case "content-type":
        hasContentType = true;
        h["content-type"] = value;
        continue;
      default:
        h[name] = value;
    }
  }
  h.authorization = `Bearer ${a.data.access_token}`;
  if (!hasContentType) h["content-type"] = "application/json";
  if (!hasAccept && req.method !== "GET") h.accept = "text/event-stream";
  if (a.data.account_id) h["ChatGPT-Account-ID"] = a.data.account_id;
  return h;
}

const fields = new Set(["prompt_cache_key", "session_id"]);
const smallBody = Buffer.from(JSON.stringify({ model: "gpt-5.3-codex", prompt_cache_key: "bench-session", input: [{ role: "user", content: "hello" }] }));
const largeBody = Buffer.from(JSON.stringify({
  model: "gpt-5.3-codex",
  input: [{ role: "user", content: "x".repeat(64 * 1024) }],
  prompt_cache_key: "bench-session",
}));

const affinity = new CacheAffinityStore({
  enabled: true,
  ttlMs: 30 * 60_000,
  maxEntries: 10000,
  headers: ["session_id", "x-session-affinity"],
  bodyFields: ["prompt_cache_key", "session_id"],
  maxValueBytes: 512,
});
affinity.updateAuths([auth]);
affinity.bind("cache:bench-session", auth);

const disabledCapture = new DebugRequestCapture({
  enabled: false,
  dir: `${tmpdir()}/cd-proxy-disabled-debug-capture`,
  bodyBytes: 1024 * 1024,
  maxPending: 1024,
  home: process.env.HOME ?? ".",
});

const authStore = new AuthStore({
  authDir: "/tmp/unused",
  home: process.env.HOME ?? ".",
  refreshSkewMs: 300_000,
  maxRetryCredentials: 0,
  useZigAuthParse: false,
  useZigJwtExp: false,
  useZigPick: false,
  zigCore: () => undefined,
  log: () => {},
});
authStore.auths = [auth];
authStore.enabledCount = 1;

console.log(`cd-proxy proxy-hot-path benchmark (${FAST ? "fast" : "full"}, repeats=${REPEATS})`);
console.log(`iterations: hot=${ITERS}, body=${BODY_ITERS}\n`);

printPair(
  "HTTP upstream header construction candidate",
  bench("runtime Headers clone/delete", ITERS, () => buildHeaders(req, auth).get("authorization")),
  bench("candidate single-pass object", ITERS, () => singlePassHttpHeaders(req, auth).authorization),
);

printPair(
  "JSON cache-key extraction, small body",
  bench("JSON.parse prompt_cache_key", BODY_ITERS, () => JSON.parse(smallBody.toString("utf8")).prompt_cache_key),
  bench("byte root-field scanner", BODY_ITERS, () => jsonRootStringFieldValue(smallBody, fields)),
);

printPair(
  "JSON cache-key extraction, 64KiB input before key",
  bench("JSON.parse prompt_cache_key large", Math.max(1000, Math.floor(BODY_ITERS / 10)), () => JSON.parse(largeBody.toString("utf8")).prompt_cache_key),
  bench("byte root-field scanner large", Math.max(1000, Math.floor(BODY_ITERS / 10)), () => jsonRootStringFieldValue(largeBody, fields)),
);

console.log("\nCurrent hot-path helpers");
print(bench("cache affinity key from header", ITERS, () => affinity.keyFromRequest(req)));
print(bench("cache affinity lookup hit", ITERS, () => affinity.choose("cache:bench-session")?.label));
print(bench("auth round-robin choose one", ITERS, () => authStore.choose()?.label));
print(bench("debug capture disabled call", ITERS, () => disabledCapture.saveHttpRequest(req, "/v1/responses", "responses", "cache:bench-session", undefined)));

console.log(`\nblackhole=${String(sink).slice(0, 16)}`);
