#!/usr/bin/env bun
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const API_KEY = "ws-test-key";
const ACCOUNTS = ["AAAAA-ws-account", "BBBBB-ws-account"];
const EMAILS = ["a-ws@example.test", "b-ws@example.test"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
async function waitFor(url: string, headers: HeadersInit = {}, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try { const r = await fetch(url, { headers }); if (r.ok) return; last = `${r.status} ${await r.text().catch(() => "")}`; }
    catch (e) { last = String(e); }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${url}: ${last}`);
}
async function writeAuth(dir: string, idx: number) {
  await writeFile(join(dir, `codex-${EMAILS[idx]}-plus.json`), JSON.stringify({
    type: "codex", email: EMAILS[idx], account_id: ACCOUNTS[idx],
    access_token: `ws-access-${idx}`, refresh_token: `ws-refresh-${idx}`,
    expired: "2099-01-01T00:00:00Z", last_refresh: "2026-01-01T00:00:00Z", disabled: false,
  }), { mode: 0o600 });
}
async function startMock(tmp: string, port: number, failUpgradeAccounts: string[] = []) {
  const file = join(tmp, `ws-mock-${port}.ts`);
  await writeFile(file, `
const log = [];
const failUpgrade = new Set((process.env.FAIL_UPGRADE_ACCOUNTS ?? '').split(',').filter(Boolean));
Bun.serve({ host: '127.0.0.1', port: Number(process.env.MOCK_PORT),
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === '/__health') return Response.json({ ok: true });
    if (url.pathname === '/__log') return Response.json(log);
    if (url.pathname === '/__clear') { log.length = 0; return Response.json({ ok: true }); }
    if (url.pathname !== '/responses') return new Response('not found', { status: 404 });
    const account = req.headers.get('chatgpt-account-id');
    const auth = req.headers.get('authorization');
    log.push({ account, auth, beta: req.headers.get('openai-beta') });
    if (failUpgrade.has(account ?? '')) return new Response('forced websocket upgrade failure', { status: 429 });
    if (server.upgrade(req, { data: { account } })) return;
    return new Response('upgrade failed', { status: 400 });
  },
  websocket: {
    message(ws, msg) { ws.send(JSON.stringify({ account: ws.data.account, got: String(msg) })); },
  },
});
`);
  const proc = Bun.spawn(["bun", file], { stdout: "pipe", stderr: "pipe", env: { ...process.env, MOCK_PORT: String(port), FAIL_UPGRADE_ACCOUNTS: failUpgradeAccounts.join(",") } });
  await waitFor(`http://127.0.0.1:${port}/__health`);
  return proc;
}
async function startProxy(authDir: string, mockPort: number, proxyPort: number) {
  const proc = Bun.spawn(["bun", "run", "src/server.ts"], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: {
    ...process.env,
    CD_PROXY_HOST: "127.0.0.1", CD_PROXY_PORT: String(proxyPort), CD_PROXY_AUTH_DIR: authDir,
    CD_PROXY_API_KEY: API_KEY, CD_PROXY_UPSTREAM_BASE: `http://127.0.0.1:${mockPort}`,
    CD_PROXY_EXPOSE_ROTATION_HEADERS: "1",
  }});
  await waitFor(`http://127.0.0.1:${proxyPort}/health`, { authorization: `Bearer ${API_KEY}` });
  return proc;
}
function wsRoundTrip(port: number, msg: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`, {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "openai-beta": "responses_websockets=2026-02-06",
        "x-client-request-id": `ws-test-${msg}`,
      },
    });
    const timer = setTimeout(() => reject(new Error("websocket timeout")), 5000);
    ws.addEventListener("open", () => ws.send(msg));
    ws.addEventListener("message", (event) => { clearTimeout(timer); ws.close(); resolve(JSON.parse(String(event.data))); });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("websocket error")); });
  });
}
async function stop(proc: Bun.Subprocess | undefined) { if (!proc) return; proc.kill(); await proc.exited.catch(() => {}); }

const tmp = await mkdtemp(join(tmpdir(), "cd-proxy-ws-"));
const authDir = join(tmp, "auths");
await Bun.$`mkdir -p ${authDir}`.quiet();
await writeAuth(authDir, 0); await writeAuth(authDir, 1);
const mockPort = 20700 + Math.floor(Math.random() * 1000);
const proxyPort = 21700 + Math.floor(Math.random() * 1000);
let mock: Bun.Subprocess | undefined;
let proxy: Bun.Subprocess | undefined;
try {
  mock = await startMock(tmp, mockPort);
  proxy = await startProxy(authDir, mockPort, proxyPort);
  const r0 = await wsRoundTrip(proxyPort, "one");
  const r1 = await wsRoundTrip(proxyPort, "two");
  const r2 = await wsRoundTrip(proxyPort, "three");
  console.log("responses:", [r0.account, r1.account, r2.account].join(" -> "));
  assert(r0.account === ACCOUNTS[0], `first WS account mismatch: ${r0.account}`);
  assert(r1.account === ACCOUNTS[1], `second WS account mismatch: ${r1.account}`);
  assert(r2.account === ACCOUNTS[0], `third WS account mismatch: ${r2.account}`);
  const log = await (await fetch(`http://127.0.0.1:${mockPort}/__log`)).json() as any[];
  console.log("upstream handshakes:", log.map((x) => `${x.account}:${x.beta}`).join(" | "));
  assert(log.every((x) => x.beta === "responses_websockets=2026-02-06"), "OpenAI-Beta websocket header did not flow through");
} finally {
  await stop(proxy); await stop(mock);
}

const failMockPort = 22700 + Math.floor(Math.random() * 1000);
const failProxyPort = 23700 + Math.floor(Math.random() * 1000);
try {
  mock = await startMock(tmp, failMockPort, [ACCOUNTS[1]]);
  proxy = await startProxy(authDir, failMockPort, failProxyPort);
  const r0 = await wsRoundTrip(failProxyPort, "failover-one");
  const r1 = await wsRoundTrip(failProxyPort, "failover-two");
  const log = await (await fetch(`http://127.0.0.1:${failMockPort}/__log`)).json() as any[];
  console.log("failover responses:", [r0.account, r1.account].join(" -> "));
  console.log("failover handshakes:", log.map((x) => x.account).join(" -> "));
  assert(r0.account === ACCOUNTS[0], `first failover WS account mismatch: ${r0.account}`);
  assert(r1.account === ACCOUNTS[0], `failed B handshake should retry A without surfacing an error, got ${r1.account}`);
  assert(log.map((x) => x.account).join(",") === [ACCOUNTS[0], ACCOUNTS[1], ACCOUNTS[0]].join(","), "WS failover handshake sequence mismatch");
} finally {
  await stop(proxy); await stop(mock);
}

console.log("websocket flow test: PASS");
