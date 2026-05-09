#!/usr/bin/env bun
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const FAST = process.env.CD_PROXY_BENCH_FAST !== "0";
const FRAMES = Number(process.env.CD_PROXY_BENCH_WS_FRAMES ?? (FAST ? "750" : "5000"));
const API_KEY = "ws-throughput-key";

type Result = { name: string; frames: number; ms: number; hz: number; avgMs: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function startMock(port: number) {
  return Bun.serve<{ terminal: boolean }>({
    host: "127.0.0.1",
    port,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/__health") return Response.json({ ok: true });
      if (url.pathname === "/responses" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const terminal = url.searchParams.get("terminal") !== "0";
        return server.upgrade(req, { data: { terminal } }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws, message) {
        const text = String(message);
        if (ws.data.terminal) {
          ws.send(JSON.stringify({ type: "response.completed", response: { id: "resp_ws_bench" }, n: text.length }));
        } else {
          ws.send(JSON.stringify({ type: "response.output_text.delta", delta: "ok", n: text.length }));
        }
      },
    },
  });
}

async function writeAuth(authDir: string) {
  await writeFile(join(authDir, "codex-ws-bench@example.test-plus.json"), JSON.stringify({
    type: "codex",
    email: "ws-bench@example.test",
    account_id: "ws-bench-account",
    access_token: "ws-bench-access-token",
    refresh_token: "ws-bench-refresh-token",
    id_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, email: "ws-bench@example.test" }),
    expired: "2099-01-01T00:00:00Z",
    disabled: false,
  }) + "\n", { mode: 0o600 });
}

function startProxy(authDir: string, mockPort: number, proxyPort: number) {
  return Bun.spawn(["bun", "run", "src/server.ts"], {
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
}

async function drain(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return "";
  try { return await new Response(stream).text(); } catch { return ""; }
}

function frameLoop(name: string, url: string, frames: number, headers?: Record<string, string>): Promise<Result> {
  return new Promise((resolve, reject) => {
    let received = 0;
    let started = 0;
    const ws = new WebSocket(url, headers ? { headers } : undefined);
    const timer = setTimeout(() => reject(new Error(`${name} timeout after ${received}/${frames}`)), 20_000);
    const send = () => ws.send(JSON.stringify({ type: "response.create", prompt_cache_key: "ws-throughput", input: `ping-${received}` }));
    ws.addEventListener("open", () => { started = performance.now(); send(); });
    ws.addEventListener("message", () => {
      received++;
      if (received >= frames) {
        clearTimeout(timer);
        const ms = performance.now() - started;
        ws.close();
        resolve({ name, frames, ms, hz: frames / (ms / 1000), avgMs: ms / frames });
      } else {
        send();
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`${name} websocket error`));
    });
  });
}

function print(result: Result) {
  console.log(`${result.name.padEnd(34)} ${result.hz.toFixed(1).padStart(9)} frames/s  avg=${result.avgMs.toFixed(4).padStart(8)} ms  total=${result.ms.toFixed(1)} ms`);
}

function printPair(label: string, direct: Result, proxy: Result) {
  console.log(`\n${label}`);
  print(direct);
  print(proxy);
  console.log(`proxy overhead: ${(proxy.avgMs - direct.avgMs).toFixed(4)} ms/frame (${(proxy.avgMs / direct.avgMs).toFixed(2)}x direct latency)`);
}

const tmp = await mkdtemp(join(tmpdir(), "cd-proxy-ws-throughput-"));
const authDir = join(tmp, "auths");
await mkdir(authDir, { recursive: true, mode: 0o700 });
await writeAuth(authDir);
const mockPort = await freePort();
const proxyPort = await freePort();
const mock = startMock(mockPort);
await waitFor(`http://127.0.0.1:${mockPort}/__health`);
const proxy = startProxy(authDir, mockPort, proxyPort);
const proxyStdout = drain(proxy.stdout);
const proxyStderr = drain(proxy.stderr);

try {
  await waitFor(`http://127.0.0.1:${proxyPort}/health`);
  console.log(`cd-proxy persistent WebSocket throughput (${FAST ? "fast" : "full"}, frames=${FRAMES})`);
  const headers = { authorization: `Bearer ${API_KEY}`, "openai-beta": "responses_websockets=2026-02-06", session_id: "ws-throughput" };

  const directTerminal = await frameLoop("direct terminal frames", `ws://127.0.0.1:${mockPort}/responses?terminal=1`, FRAMES);
  const proxyTerminal = await frameLoop("proxy terminal frames", `ws://127.0.0.1:${proxyPort}/v1/responses?terminal=1`, FRAMES, headers);
  printPair("Terminal response frames", directTerminal, proxyTerminal);

  const directNonTerminal = await frameLoop("direct non-terminal frames", `ws://127.0.0.1:${mockPort}/responses?terminal=0`, FRAMES);
  const proxyNonTerminal = await frameLoop("proxy non-terminal frames", `ws://127.0.0.1:${proxyPort}/v1/responses?terminal=0`, FRAMES, headers);
  printPair("Non-terminal response frames", directNonTerminal, proxyNonTerminal);
} finally {
  proxy.kill();
  await Promise.allSettled([proxy.exited, proxyStdout, proxyStderr]);
  mock.stop(true);
  await rm(tmp, { recursive: true, force: true });
}
