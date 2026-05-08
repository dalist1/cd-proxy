#!/usr/bin/env bun
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const API_KEY = "cache-affinity-test-key";
const ACCOUNTS = ["AAAAA-cache-account", "BBBBB-cache-account"];
const EMAILS = ["a-cache@example.test", "b-cache@example.test"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function freePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  server.stop(true);
  return port;
}

async function waitFor(url: string, headers: HeadersInit = {}, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { headers });
      if (r.ok) return;
      last = `${r.status} ${await r.text().catch(() => "")}`;
    } catch (e) {
      last = String(e);
    }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${url}: ${last}`);
}

async function writeAuth(dir: string, idx: number) {
  await writeFile(join(dir, `codex-${EMAILS[idx]}-plus.json`), JSON.stringify({
    type: "codex",
    email: EMAILS[idx],
    account_id: ACCOUNTS[idx],
    access_token: `cache-access-${idx}`,
    refresh_token: `cache-refresh-${idx}`,
    expired: "2099-01-01T00:00:00Z",
    disabled: false,
  }) + "\n", { mode: 0o600 });
}

function startMock(port: number) {
  const seen: Array<{ account: string | null; session: string | null }> = [];
  const server = Bun.serve({
    host: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/__seen") return Response.json(seen);
      if (url.pathname !== "/responses") return new Response("not found", { status: 404 });
      seen.push({ account: req.headers.get("chatgpt-account-id"), session: req.headers.get("session_id") });
      return Response.json({ ok: true, account: req.headers.get("chatgpt-account-id") });
    },
  });
  return { server, seen: () => seen.slice() };
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
      CD_PROXY_CACHE_AFFINITY: "1",
      CD_PROXY_CACHE_AFFINITY_TTL_MS: "60000",
      CD_PROXY_CACHE_AFFINITY_HEADERS: "session_id,x-session-affinity",
      CD_PROXY_EXPOSE_ROTATION_HEADERS: "1",
    },
  });
}

async function post(proxyPort: number, session?: string) {
  const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
      ...(session ? { session_id: session } : {}),
    },
    body: JSON.stringify({ model: "gpt-5.3-codex", stream: true, prompt_cache_key: session, input: [{ role: "user", content: "ping" }] }),
  });
  const body = await res.json().catch(() => ({}));
  assert(res.ok, `request failed ${res.status}: ${JSON.stringify(body)}`);
  return { account: body.account as string, affinityHeader: res.headers.get("x-cd-proxy-auth-label") };
}

const temp = await mkdtemp(join(tmpdir(), "cd-proxy-cache-affinity-"));
const authDir = join(temp, "auths");
await mkdir(authDir, { recursive: true, mode: 0o700 });
await writeAuth(authDir, 0);
await writeAuth(authDir, 1);

const mockPort = await freePort();
const proxyPort = await freePort();
const mock = startMock(mockPort);
const proxy = startProxy(authDir, mockPort, proxyPort);

try {
  await waitFor(`http://127.0.0.1:${proxyPort}/health`);
  const first = await post(proxyPort, "cache-session-a");
  const second = await post(proxyPort, "cache-session-a");
  const third = await post(proxyPort, "cache-session-b");

  assert(first.account === ACCOUNTS[0], `first request should use first account, got ${first.account}`);
  assert(second.account === ACCOUNTS[0], `same session should stick to first account, got ${second.account}`);
  assert(third.account === ACCOUNTS[1], `new session should continue round-robin to second account, got ${third.account}`);

  const status = await (await fetch(`http://127.0.0.1:${proxyPort}/status`, { headers: { authorization: `Bearer ${API_KEY}` } })).json() as any;
  assert(status.cache_affinity?.hits >= 1, `expected cache affinity hit in status: ${JSON.stringify(status.cache_affinity)}`);
  assert(status.cache_affinity?.entries >= 2, `expected cache affinity entries: ${JSON.stringify(status.cache_affinity)}`);

  console.log(JSON.stringify({ ok: true, accounts: [first.account, second.account, third.account], cache_affinity: status.cache_affinity, seen: mock.seen() }, null, 2));
} finally {
  proxy.kill();
  mock.server.stop(true);
  await Promise.allSettled([proxy.exited]);
  await rm(temp, { recursive: true, force: true });
}
