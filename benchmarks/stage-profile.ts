#!/usr/bin/env bun
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const FAST = process.env.CD_PROXY_BENCH_FAST !== "0";
const HTTP_ITERS = Number(process.env.CD_PROXY_STAGE_HTTP_ITERS ?? (FAST ? "120" : "500"));
const WS_OPEN_ITERS = Number(process.env.CD_PROXY_STAGE_WS_OPEN_ITERS ?? (FAST ? "40" : "160"));
const WS_FRAMES = Number(process.env.CD_PROXY_STAGE_WS_FRAMES ?? (FAST ? "500" : "2500"));
const API_KEY = "stage-profile-key";

type Timing = { count: number; total_ms: number; avg_ms: number; min_ms: number; max_ms: number };
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
  const server = Bun.serve<{ account: string }>({
    host: "127.0.0.1",
    port,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/__health") return Response.json({ ok: true });
      if (url.pathname === "/responses" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const account = req.headers.get("chatgpt-account-id") ?? "none";
        return server.upgrade(req, { data: { account } }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/responses" && req.method === "POST") {
        await req.arrayBuffer();
        return Response.json({ ok: true, account: req.headers.get("chatgpt-account-id") });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws, message) {
        ws.send(JSON.stringify({ type: "response.completed", response: { id: "resp_stage" }, account: ws.data.account, got: String(message).length }));
      },
    },
  });
  return server;
}

async function writeAuth(authDir: string) {
  await writeFile(join(authDir, "codex-stage@example.test-plus.json"), JSON.stringify({
    type: "codex",
    email: "stage@example.test",
    account_id: "stage-account",
    access_token: "stage-access-token",
    refresh_token: "stage-refresh-token",
    id_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, email: "stage@example.test" }),
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
      CD_PROXY_PROFILE: "1",
      CD_PROXY_DEBUG: "0",
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return "";
  try { return await new Response(stream).text(); } catch { return ""; }
}

async function resetProfile(proxyPort: number) {
  await fetch(`http://127.0.0.1:${proxyPort}/debug/profile/reset`, { headers: { authorization: `Bearer ${API_KEY}` } });
}

async function readProfile(proxyPort: number): Promise<Record<string, Timing>> {
  const status = await (await fetch(`http://127.0.0.1:${proxyPort}/status`, { headers: { authorization: `Bearer ${API_KEY}` } })).json() as any;
  return status.profile?.timings ?? {};
}

function printProfile(title: string, timings: Record<string, Timing>, prefix: string) {
  console.log(`\n${title}`);
  const rows = Object.entries(timings)
    .filter(([name]) => name.startsWith(prefix))
    .sort((a, b) => b[1].total_ms - a[1].total_ms);
  for (const [name, t] of rows) {
    console.log(`${name.padEnd(36)} count=${String(t.count).padStart(5)} avg=${t.avg_ms.toFixed(4).padStart(9)} ms total=${t.total_ms.toFixed(2).padStart(9)} ms max=${t.max_ms.toFixed(4).padStart(9)} ms`);
  }
}

async function post(proxyPort: number, withHeader: boolean) {
  const session = withHeader ? "stage-header" : "stage-body";
  const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
      ...(withHeader ? { session_id: session } : {}),
    },
    body: JSON.stringify({ model: "gpt-5.3-codex", prompt_cache_key: session, input: [{ role: "user", content: "x".repeat(4096) }] }),
  });
  if (!res.ok) throw new Error(`post failed ${res.status}: ${await res.text()}`);
  await res.text();
}

function wsRoundTrip(proxyPort: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/v1/responses`, {
      headers: { authorization: `Bearer ${API_KEY}`, "openai-beta": "responses_websockets=2026-02-06", session_id: "stage-ws-open" },
    });
    const timer = setTimeout(() => reject(new Error("ws timeout")), 5000);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "response.create", prompt_cache_key: "stage-ws-open", input: "ping" })));
    ws.addEventListener("message", () => { clearTimeout(timer); ws.close(); resolve(); });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("ws error")); });
  });
}

function persistentWs(proxyPort: number, frames: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let received = 0;
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/v1/responses`, {
      headers: { authorization: `Bearer ${API_KEY}`, "openai-beta": "responses_websockets=2026-02-06", session_id: "stage-ws-persist" },
    });
    const timer = setTimeout(() => reject(new Error("persistent ws timeout")), 15_000);
    const send = () => ws.send(JSON.stringify({ type: "response.create", prompt_cache_key: "stage-ws-persist", input: `ping-${received}` }));
    ws.addEventListener("open", send);
    ws.addEventListener("message", () => {
      received++;
      if (received >= frames) {
        clearTimeout(timer);
        ws.close();
        resolve();
      } else send();
    });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("persistent ws error")); });
  });
}

const tmp = await mkdtemp(join(tmpdir(), "cd-proxy-stage-profile-"));
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
  console.log(`cd-proxy stage profile (${FAST ? "fast" : "full"})`);
  console.log(`iterations: http=${HTTP_ITERS}, ws-open=${WS_OPEN_ITERS}, ws-frames=${WS_FRAMES}`);

  await post(proxyPort, true);
  await resetProfile(proxyPort);
  for (let i = 0; i < HTTP_ITERS; i++) await post(proxyPort, true);
  printProfile("HTTP with session_id header affinity", await readProfile(proxyPort), "http.");

  await resetProfile(proxyPort);
  for (let i = 0; i < HTTP_ITERS; i++) await post(proxyPort, false);
  printProfile("HTTP with body prompt_cache_key affinity", await readProfile(proxyPort), "http.");

  await resetProfile(proxyPort);
  for (let i = 0; i < WS_OPEN_ITERS; i++) await wsRoundTrip(proxyPort);
  printProfile("WebSocket open + one frame", await readProfile(proxyPort), "ws.");

  await resetProfile(proxyPort);
  await persistentWs(proxyPort, WS_FRAMES);
  printProfile("Persistent WebSocket frame loop", await readProfile(proxyPort), "ws.");
} finally {
  proxy.kill();
  await Promise.allSettled([proxy.exited, proxyStdout, proxyStderr]);
  mock.stop(true);
  await rm(tmp, { recursive: true, force: true });
}
