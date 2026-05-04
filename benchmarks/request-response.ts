#!/usr/bin/env bun
import { dlopen, FFIType, ptr, suffix } from "bun:ffi";

const lib = dlopen(`zig-out/lib/libcd_proxy_core.${suffix}`, {
  cdproxy_is_terminal_response_event: { args: [FFIType.ptr, FFIType.usize], returns: FFIType.bool },
});
const zig = lib.symbols;

const FAST = process.env.CD_PROXY_BENCH_FAST !== "0";
const PATH_ITERS = Number(process.env.CD_PROXY_BENCH_PATH_ITERS ?? (FAST ? "500000" : "2000000"));
const ROUTE_ITERS = Number(process.env.CD_PROXY_BENCH_ROUTE_ITERS ?? (FAST ? "500000" : "2000000"));
const RESPONSE_ITERS = Number(process.env.CD_PROXY_BENCH_RESPONSE_ITERS ?? (FAST ? "200000" : "1000000"));
const UPGRADE_ITERS = Number(process.env.CD_PROXY_BENCH_UPGRADE_ITERS ?? (FAST ? "1000000" : "5000000"));
const HEADER_ITERS = Number(process.env.CD_PROXY_BENCH_HEADER_ITERS ?? (FAST ? "300000" : "1000000"));
const WS_ITERS = Number(process.env.CD_PROXY_BENCH_WS_ITERS ?? (FAST ? "500000" : "2000000"));

type BenchResult = { name: string; hz: number; ms: number; last: unknown };
let sink: unknown;

function bench(name: string, iterations: number, fn: () => unknown): BenchResult {
  const warmup = Math.min(10_000, Math.max(1_000, Math.floor(iterations / 20)));
  for (let i = 0; i < warmup; i++) sink = fn();

  const started = performance.now();
  let last: unknown;
  for (let i = 0; i < iterations; i++) last = fn();
  const ms = performance.now() - started;
  sink = last;
  return { name, hz: iterations / (ms / 1000), ms, last };
}

function printPair(label: string, baseline: BenchResult, optimized: BenchResult, optimizedLabel: string) {
  const ratio = optimized.hz / baseline.hz;
  const faster = ratio >= 1 ? `${ratio.toFixed(2)}x faster` : `${(1 / ratio).toFixed(2)}x slower`;
  console.log(`\n${label}`);
  console.log(`  baseline: ${baseline.hz.toFixed(0).padStart(10)} ops/s (${baseline.ms.toFixed(1)} ms)`);
  console.log(`  ${optimizedLabel.padEnd(9)}${optimized.hz.toFixed(0).padStart(10)} ops/s (${optimized.ms.toFixed(1)} ms)  => ${faster}`);
}

function fastPathname(rawUrl: string): string {
  const scheme = rawUrl.indexOf("://");
  let start = 0;
  if (scheme >= 0) {
    const slash = rawUrl.indexOf("/", scheme + 3);
    if (slash < 0) return "/";
    start = slash;
  }
  const query = rawUrl.indexOf("?", start);
  const hash = rawUrl.indexOf("#", start);
  let end = rawUrl.length;
  if (query >= 0 && query < end) end = query;
  if (hash >= 0 && hash < end) end = hash;
  return rawUrl.slice(start, end) || "/";
}

function baselineRoute(rawUrl: string): string | undefined {
  const pathname = new URL(rawUrl).pathname;
  if (pathname === "/v1/models" || pathname === "/models") return "models";
  if (pathname === "/v1/responses" || pathname === "/responses" || pathname === "/codex/responses" || pathname === "/backend-api/codex/responses") return "responses";
  if (pathname === "/v1/responses/compact" || pathname === "/responses/compact" || pathname === "/codex/responses/compact" || pathname === "/backend-api/codex/responses/compact") return "responses/compact";
  return undefined;
}

function optimizedRoute(rawUrl: string): string | undefined {
  switch (fastPathname(rawUrl)) {
    case "/v1/models":
    case "/models":
      return "models";
    case "/v1/responses":
    case "/responses":
    case "/codex/responses":
    case "/backend-api/codex/responses":
      return "responses";
    case "/v1/responses/compact":
    case "/responses/compact":
    case "/codex/responses/compact":
    case "/backend-api/codex/responses/compact":
      return "responses/compact";
    default:
      return undefined;
  }
}

const models = ["gpt-5.3-codex", "gpt-5.3-codex-spark", "codex-auto-review", "gpt-5.5", "gpt-5.2"];
const cachedModelsBody = JSON.stringify({
  object: "list",
  data: models.map((id) => ({ id, object: "model", created: 1770307200, owned_by: "openai" })),
}, null, 2);

function baselineModelsBody(): string {
  return JSON.stringify({
    object: "list",
    data: models.map((id) => ({ id, object: "model", created: 1770307200, owned_by: "openai" })),
  }, null, 2);
}

const requestUrl = "http://127.0.0.1:8318/v1/responses?stream=true";
const modelsUrl = "http://127.0.0.1:8318/v1/models";
const terminalText = JSON.stringify({
  type: "response.completed",
  response: { output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] },
});
const wsReq = new Request("http://127.0.0.1:8318/v1/responses", {
  headers: {
    authorization: "Bearer local-key",
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-key": "client-key",
    "sec-websocket-version": "13",
    "openai-beta": "responses_websockets=2026-02-06",
    "x-client-request-id": "bench-request",
    session_id: "bench-session",
  },
});
const upstreamAuth = { data: { access_token: "upstream-access-token", account_id: "acct-bench" } };

const COMPACT_ROOT_TYPE_PREFIX = '{\"type\":\"';
function compactTerminalTypeText(text: string): boolean | undefined {
  if (text.startsWith('{\"type\":\"response.completed\"') ||
    text.startsWith('{\"type\":\"response.done\"') ||
    text.startsWith('{\"type\":\"response.incomplete\"')) return true;
  if (text.startsWith(COMPACT_ROOT_TYPE_PREFIX)) return false;
  return undefined;
}
function maybeContainsTerminalTypeText(text: string): boolean {
  return text.includes("response.completed") || text.includes("response.done") || text.includes("response.incomplete");
}
function optimizedTerminalText(text: string): boolean {
  const compact = compactTerminalTypeText(text);
  if (compact !== undefined) return compact;
  if (!maybeContainsTerminalTypeText(text)) return false;
  const parsed = JSON.parse(text);
  return parsed.type === "response.completed" || parsed.type === "response.done" || parsed.type === "response.incomplete";
}

function baselineUpgrade(req: Request): boolean {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket";
}
function isAsciiWebSocket(value: string): boolean {
  return value.length === 9 &&
    (value.charCodeAt(0) | 32) === 119 &&
    (value.charCodeAt(1) | 32) === 101 &&
    (value.charCodeAt(2) | 32) === 98 &&
    (value.charCodeAt(3) | 32) === 115 &&
    (value.charCodeAt(4) | 32) === 111 &&
    (value.charCodeAt(5) | 32) === 99 &&
    (value.charCodeAt(6) | 32) === 107 &&
    (value.charCodeAt(7) | 32) === 101 &&
    (value.charCodeAt(8) | 32) === 116;
}
function optimizedUpgrade(req: Request): boolean {
  const upgrade = req.headers.get("upgrade");
  return upgrade === "websocket" || (!!upgrade && isAsciiWebSocket(upgrade));
}

function baselineWebSocketHeaders(req: Request, a: typeof upstreamAuth): Record<string, string> {
  const h = new Headers(req.headers);
  for (const name of ["host", "connection", "upgrade", "content-length", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"]) h.delete(name);
  h.set("authorization", `Bearer ${a.data.access_token}`);
  if (a.data.account_id) h.set("ChatGPT-Account-ID", a.data.account_id);
  return Object.fromEntries(h.entries());
}
function optimizedWebSocketHeaders(req: Request, a: typeof upstreamAuth): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [name, value] of req.headers) {
    switch (name) {
      case "host":
      case "connection":
      case "upgrade":
      case "content-length":
      case "sec-websocket-key":
      case "sec-websocket-version":
      case "sec-websocket-extensions":
      case "sec-websocket-protocol":
        continue;
      default:
        h[name] = value;
    }
  }
  h.authorization = `Bearer ${a.data.access_token}`;
  if (a.data.account_id) h["ChatGPT-Account-ID"] = a.data.account_id;
  return h;
}

console.log(`cd-proxy request/response benchmark (${FAST ? "fast" : "full"} feedback loop)`);
console.log(`iterations: path=${PATH_ITERS}, route=${ROUTE_ITERS}, response=${RESPONSE_ITERS}, upgrade=${UPGRADE_ITERS}, headers=${HEADER_ITERS}, ws=${WS_ITERS}`);

printPair(
  "request pathname extraction",
  bench("new URL().pathname", PATH_ITERS, () => new URL(requestUrl).pathname),
  bench("fastPathname", PATH_ITERS, () => fastPathname(requestUrl)),
  "fast JS",
);

printPair(
  "request route resolution",
  bench("new URL + if chain", ROUTE_ITERS, () => baselineRoute(modelsUrl)),
  bench("fast path + switch", ROUTE_ITERS, () => optimizedRoute(modelsUrl)),
  "fast JS",
);

printPair(
  "models response body generation",
  bench("JSON.stringify per response", RESPONSE_ITERS, () => baselineModelsBody().length),
  bench("cached response body", RESPONSE_ITERS, () => cachedModelsBody.length),
  "cached",
);

printPair(
  "WebSocket upgrade header check",
  bench("toLowerCase check", UPGRADE_ITERS, () => baselineUpgrade(wsReq)),
  bench("direct common-case check", UPGRADE_ITERS, () => optimizedUpgrade(wsReq)),
  "fast JS",
);

printPair(
  "WebSocket upstream header forwarding",
  bench("Headers clone + Object.fromEntries", HEADER_ITERS, () => Object.keys(baselineWebSocketHeaders(wsReq, upstreamAuth)).length),
  bench("single-pass object build", HEADER_ITERS, () => Object.keys(optimizedWebSocketHeaders(wsReq, upstreamAuth)).length),
  "fast JS",
);

printPair(
  "Responses WebSocket terminal-event detection",
  bench("JSON.parse frame", WS_ITERS, () => {
    const parsed = JSON.parse(terminalText);
    return parsed.type === "response.completed" || parsed.type === "response.done" || parsed.type === "response.incomplete";
  }),
  bench("compact type sentinel", WS_ITERS, () => optimizedTerminalText(terminalText)),
  "fast JS",
);

printPair(
  "Responses WebSocket terminal-event detection for binary frames",
  bench("JSON.parse decoded frame", WS_ITERS, () => {
    const parsed = JSON.parse(terminalText);
    return parsed.type === "response.completed" || parsed.type === "response.done" || parsed.type === "response.incomplete";
  }),
  bench("Zig binary frame detector", WS_ITERS, () => {
    const raw = Buffer.from(terminalText);
    return zig.cdproxy_is_terminal_response_event(ptr(raw), raw.byteLength);
  }),
  "Zig/RF",
);

console.log(`\nblackhole=${String(sink).slice(0, 16)}`);
