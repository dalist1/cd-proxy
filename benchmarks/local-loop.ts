#!/usr/bin/env bun
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const FAST = process.env.CD_PROXY_BENCH_FAST !== "0";
const MODELS_ITERS = Number(process.env.CD_PROXY_BENCH_MODELS_ITERS ?? (FAST ? "250" : "1000"));
const POST_ITERS = Number(process.env.CD_PROXY_BENCH_POST_ITERS ?? (FAST ? "250" : "1000"));
const WS_ITERS = Number(process.env.CD_PROXY_BENCH_WS_OPEN_ITERS ?? (FAST ? "60" : "250"));
const API_KEY = "macro-bench-key";

type BenchResult = { name: string; hz: number; ms: number; avgMs: number; last: unknown };
let sink: unknown;

function fakeJwt(payload: Record<string, unknown>) {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.`;
}

async function freePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  server.stop(true);
  return port;
}

function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function drain(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return "";
  try { return await new Response(stream).text(); } catch { return ""; }
}

async function waitFor(url: string, headers: HeadersInit = {}, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers });
      const text = await res.text().catch(() => "");
      if (res.ok) return text;
      last = `${res.status} ${text}`;
    } catch (err) {
      last = String(err);
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${url}: ${last}`);
}

async function benchAsync(name: string, iterations: number, fn: () => Promise<unknown>): Promise<BenchResult> {
  const warmup = Math.min(25, Math.max(3, Math.floor(iterations / 20)));
  for (let i = 0; i < warmup; i++) sink = await fn();

  const started = performance.now();
  let last: unknown;
  for (let i = 0; i < iterations; i++) last = await fn();
  const ms = performance.now() - started;
  sink = last;
  return { name, hz: iterations / (ms / 1000), ms, avgMs: ms / iterations, last };
}

function printResult(result: BenchResult) {
  console.log(`${result.name.padEnd(34)} ${result.hz.toFixed(1).padStart(9)} ops/s  avg=${result.avgMs.toFixed(3).padStart(8)} ms  total=${result.ms.toFixed(1)} ms`);
}

function printPair(label: string, direct: BenchResult, proxied: BenchResult) {
  const overhead = proxied.avgMs - direct.avgMs;
  const ratio = proxied.avgMs / direct.avgMs;
  console.log(`\n${label}`);
  printResult(direct);
  printResult(proxied);
  console.log(`proxy overhead: ${overhead.toFixed(3)} ms/request (${ratio.toFixed(2)}x direct latency)`);
}

async function startMockUpstream(port: number) {
  let httpPosts = 0;
  let wsConnections = 0;
  const server = Bun.serve({
    host: "127.0.0.1",
    port,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/__health") return Response.json({ ok: true, httpPosts, wsConnections });
      if (url.pathname === "/responses" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const account = req.headers.get("chatgpt-account-id") ?? "none";
        if (server.upgrade(req, { data: { account } })) {
          wsConnections++;
          return;
        }
        return new Response("upgrade failed", { status: 400 });
      }
      if ((url.pathname === "/responses" || url.pathname === "/responses/compact") && req.method === "POST") {
        httpPosts++;
        return Response.json({ ok: true, path: url.pathname, account: req.headers.get("chatgpt-account-id") });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws, message) {
        ws.send(JSON.stringify({ type: "response.completed", account: ws.data.account, got: String(message) }));
      },
    },
  });
  await waitFor(`http://127.0.0.1:${port}/__health`);
  return server;
}

async function writeBenchAuth(authDir: string) {
  await writeFile(join(authDir, "codex-bench@example.test-plus.json"), JSON.stringify({
    type: "codex",
    email: "bench@example.test",
    account_id: "bench-account",
    access_token: "bench-access-token",
    refresh_token: "bench-refresh-token",
    id_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, email: "bench@example.test" }),
    expired: "2099-01-01T00:00:00Z",
    last_refresh: "2026-01-01T00:00:00Z",
    disabled: false,
  }) + "\n", { mode: 0o600 });
}

function wsRoundTrip(url: string, headers?: Record<string, string>): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, headers ? { headers } : undefined);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`websocket timeout: ${url}`));
    }, 5000);
    ws.addEventListener("open", () => ws.send("ping"));
    ws.addEventListener("message", (event) => {
      clearTimeout(timer);
      const text = String(event.data);
      try { ws.close(); } catch {}
      resolve(text.includes("response.completed"));
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`websocket error: ${url}`));
    });
  });
}

const tmp = await mkdtemp(join(tmpdir(), "cd-proxy-local-loop-bench-"));
const authDir = join(tmp, "auths");
await Bun.$`mkdir -p ${authDir}`.quiet();
await writeBenchAuth(authDir);

const mockPort = await freePort();
const proxyPort = await freePort();
const mock = await startMockUpstream(mockPort);
const proxyCommand = ["bun", "run", "src/server.ts"];
const proxy = Bun.spawn(proxyCommand, {
  cwd: ROOT,
  stdout: "pipe",
  stderr: "pipe",
  env: {
    ...process.env,
    CD_PROXY_HOST: "127.0.0.1",
    CD_PROXY_PORT: String(proxyPort),
    CD_PROXY_AUTH_DIR: authDir,
    CD_PROXY_API_KEY: API_KEY,
    CD_PROXY_UPSTREAM_BASE: `http://127.0.0.1:${mockPort}`,
    CD_PROXY_DEBUG: "0",
  },
});
const proxyStdout = drain(proxy.stdout);
const proxyStderr = drain(proxy.stderr);

try {
  await waitFor(`http://127.0.0.1:${proxyPort}/health`);
  const authHeaders = { authorization: `Bearer ${API_KEY}` };
  const postHeaders = { ...authHeaders, "content-type": "application/json" };
  const body = JSON.stringify({ input: "bench" });

  console.log(`cd-proxy local-loop macro benchmark (${FAST ? "fast" : "full"} feedback loop, impl=bun)`);
  console.log(`iterations: models=${MODELS_ITERS}, post=${POST_ITERS}, ws-open=${WS_ITERS}`);
  console.log(`proxy=http://127.0.0.1:${proxyPort} mock=http://127.0.0.1:${mockPort}\n`);

  printResult(await benchAsync("proxy GET /v1/models", MODELS_ITERS, async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, { headers: authHeaders });
    if (!res.ok) throw new Error(`models ${res.status}: ${await res.text()}`);
    return (await res.text()).length;
  }));

  const directPost = await benchAsync("direct mock POST /responses", POST_ITERS, async () => {
    const res = await fetch(`http://127.0.0.1:${mockPort}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body });
    if (!res.ok) throw new Error(`direct post ${res.status}: ${await res.text()}`);
    return (await res.text()).length;
  });
  const proxyPost = await benchAsync("proxy POST /v1/responses", POST_ITERS, async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, { method: "POST", headers: postHeaders, body });
    if (!res.ok) throw new Error(`proxy post ${res.status}: ${await res.text()}`);
    return (await res.text()).length;
  });
  printPair("HTTP Responses POST local loop", directPost, proxyPost);

  const directWs = await benchAsync("direct mock WS open+roundtrip", WS_ITERS, async () => wsRoundTrip(`ws://127.0.0.1:${mockPort}/responses`));
  const proxyWs = await benchAsync("proxy WS open+roundtrip", WS_ITERS, async () => wsRoundTrip(`ws://127.0.0.1:${proxyPort}/v1/responses`, {
    ...authHeaders,
    "openai-beta": "responses_websockets=2026-02-06",
    "x-client-request-id": "bench-local-loop",
    session_id: "bench-local-loop",
  }));
  printPair("WebSocket open + one frame local loop", directWs, proxyWs);

  console.log(`\nblackhole=${String(sink).slice(0, 16)}`);
} finally {
  proxy.kill();
  await Promise.allSettled([proxy.exited, proxyStdout, proxyStderr]);
  mock.stop(true);
  await rm(tmp, { recursive: true, force: true });
}
