#!/usr/bin/env bun
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const API_KEY = "granular-test-key";
const ACCOUNTS = ["AAAAA-account", "BBBBB-account", "CCCCC-account"];
const EMAILS = ["a@example.test", "b@example.test", "c@example.test"];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url: string, headers: HeadersInit = {}, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return;
      last = `${res.status} ${await res.text().catch(() => "")}`;
    } catch (e) {
      last = String(e);
    }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${url}: ${last}`);
}

async function writeAuth(dir: string, idx: number, disabled = false) {
  const data = {
    type: "codex",
    email: EMAILS[idx],
    account_id: ACCOUNTS[idx],
    access_token: `access-token-${idx}`,
    refresh_token: `refresh-token-${idx}`,
    id_token: undefined,
    expired: "2099-01-01T00:00:00Z",
    last_refresh: "2026-01-01T00:00:00Z",
    disabled,
  };
  await writeFile(join(dir, `codex-${EMAILS[idx]}-plus.json`), JSON.stringify(data), { mode: 0o600 });
}

async function seedAuths(dir: string) {
  for (let i = 0; i < 3; i++) await writeAuth(dir, i, false);
}

async function request(proxyPort: number) {
  const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ input: "round-robin-test" }),
  });
  const body = await res.json() as any;
  return {
    status: res.status,
    body,
    label: res.headers.get("x-cd-proxy-auth-label"),
    prefix: res.headers.get("x-cd-proxy-auth-account-prefix"),
    attempt: res.headers.get("x-cd-proxy-attempt"),
    next: res.headers.get("x-cd-proxy-next-rr-index"),
  };
}

async function getLog(mockPort: number) {
  return await (await fetch(`http://127.0.0.1:${mockPort}/__log`)).json() as any[];
}
async function clearLog(mockPort: number) {
  await fetch(`http://127.0.0.1:${mockPort}/__clear`, { method: "POST" });
}

async function startMock(tmp: string, mockPort: number, failStatuses: Record<string, number> = {}) {
  const file = join(tmp, `mock-${mockPort}.ts`);
  await writeFile(file, `
const log = [];
const failStatuses = new Map((process.env.FAIL_STATUSES ?? '').split(',').filter(Boolean).map((item) => {
  const [account, status] = item.split('=');
  return [account, Number(status)];
}));
Bun.serve({ host: '127.0.0.1', port: Number(process.env.MOCK_PORT), fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === '/__health') return Response.json({ ok: true });
  if (url.pathname === '/__log') return Response.json(log);
  if (url.pathname === '/__clear') { log.length = 0; return Response.json({ ok: true }); }
  const account = req.headers.get('chatgpt-account-id');
  const item = { path: url.pathname, account, auth: req.headers.get('authorization') };
  log.push(item);
  const forced = failStatuses.get(account ?? '');
  if (forced) return Response.json({ error: 'forced ' + forced, account }, { status: forced });
  return Response.json({ ok: true, ...item });
}});
`);
  const proc = Bun.spawn(["bun", file], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MOCK_PORT: String(mockPort), FAIL_STATUSES: Object.entries(failStatuses).map(([account, status]) => `${account}=${status}`).join(",") },
  });
  await waitFor(`http://127.0.0.1:${mockPort}/__health`);
  return proc;
}

async function startProxy(authDir: string, mockPort: number, proxyPort: number) {
  const proc = Bun.spawn(["bun", "run", "src/server.ts"], {
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
      CD_PROXY_EXPOSE_ROTATION_HEADERS: "1",
      CD_PROXY_MAX_RETRY_CREDENTIALS: "3",
      CD_PROXY_COOLDOWN_MS: "60000",
    },
  });
  await waitFor(`http://127.0.0.1:${proxyPort}/health`, { authorization: `Bearer ${API_KEY}` });
  return proc;
}

async function stop(proc: Bun.Subprocess | undefined) {
  if (!proc) return;
  proc.kill();
  await proc.exited.catch(() => {});
}

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), "cd-proxy-granular-"));
  const authDir = join(tmp, "auths");
  await Bun.$`mkdir -p ${authDir}`.quiet();
  await seedAuths(authDir);

  const mockPort1 = 18510 + Math.floor(Math.random() * 1000);
  const proxyPort1 = 8350 + Math.floor(Math.random() * 1000);
  let mock = await startMock(tmp, mockPort1);
  let proxy = await startProxy(authDir, mockPort1, proxyPort1);
  try {
    console.log("scenario 1: exact per-request header/account sequence");
    const seq = [] as string[];
    for (let i = 0; i < 6; i++) {
      const r = await request(proxyPort1);
      assert(r.status === 200, `request ${i} status ${r.status}`);
      assert(r.body.account === ACCOUNTS[i % 3], `request ${i} upstream account expected ${ACCOUNTS[i % 3]} got ${r.body.account}`);
      assert(r.prefix === ACCOUNTS[i % 3].slice(0, 5), `request ${i} debug header prefix mismatch`);
      seq.push(r.body.account);
    }
    console.log(seq.map((a, i) => `${i}:${a}`).join(" "));
    assert(seq.join(",") === [...ACCOUNTS, ...ACCOUNTS].join(","), "basic round-robin sequence mismatch");

    console.log("scenario 2: disabled credential is skipped after reload");
    await writeAuth(authDir, 1, true); // disable B
    const reload = await fetch(`http://127.0.0.1:${proxyPort1}/reload`, { method: "POST", headers: { authorization: `Bearer ${API_KEY}` } });
    assert(reload.ok, `reload failed ${reload.status}`);
    await clearLog(mockPort1);
    const skipSeq = [] as string[];
    for (let i = 0; i < 4; i++) skipSeq.push((await request(proxyPort1)).body.account);
    console.log(skipSeq.map((a, i) => `${i}:${a}`).join(" "));
    assert(skipSeq.join(",") === [ACCOUNTS[0], ACCOUNTS[2], ACCOUNTS[0], ACCOUNTS[2]].join(","), "disabled skip sequence mismatch");
  } finally {
    await stop(proxy);
    await stop(mock);
  }

  const authDirInserted = join(tmp, "auths-insert-before-cursor");
  await Bun.$`mkdir -p ${authDirInserted}`.quiet();
  await writeAuth(authDirInserted, 1, false);
  await writeAuth(authDirInserted, 2, false);
  const mockPortInserted = 21510 + Math.floor(Math.random() * 1000);
  const proxyPortInserted = 11350 + Math.floor(Math.random() * 1000);
  mock = await startMock(tmp, mockPortInserted);
  proxy = await startProxy(authDirInserted, mockPortInserted, proxyPortInserted);
  try {
    console.log("scenario 2b: reload with a new earlier-sorting auth preserves the next account");
    const first = await request(proxyPortInserted);
    assert(first.body.account === ACCOUNTS[1], `initial two-account sequence should start at B, got ${first.body.account}`);
    await writeAuth(authDirInserted, 0, false); // A sorts before the current B/C cursor.
    const reload = await fetch(`http://127.0.0.1:${proxyPortInserted}/reload`, { method: "POST", headers: { authorization: `Bearer ${API_KEY}` } });
    assert(reload.ok, `reload after inserted auth failed ${reload.status}`);
    const second = await request(proxyPortInserted);
    const third = await request(proxyPortInserted);
    const insertedSeq = [first.body.account, second.body.account, third.body.account];
    console.log(insertedSeq.map((a, i) => `${i}:${a}`).join(" "));
    assert(insertedSeq.join(",") === [ACCOUNTS[1], ACCOUNTS[2], ACCOUNTS[0]].join(","), "reload inserted-auth sequence should not repeat the just-used account");
  } finally {
    await stop(proxy);
    await stop(mock);
  }

  // Re-enable B and test that a 429 causes same external request to rotate to C, while the mock log proves B was tried.
  await writeAuth(authDir, 1, false);
  const mockPort2 = 19510 + Math.floor(Math.random() * 1000);
  const proxyPort2 = 9350 + Math.floor(Math.random() * 1000);
  mock = await startMock(tmp, mockPort2, { [ACCOUNTS[1]]: 429 });
  proxy = await startProxy(authDir, mockPort2, proxyPort2);
  try {
    console.log("scenario 3: 429 cools failing credential and retries next credential");
    const r0 = await request(proxyPort2);
    const r1 = await request(proxyPort2);
    const r2 = await request(proxyPort2);
    const r3 = await request(proxyPort2);
    const returned = [r0.body.account, r1.body.account, r2.body.account, r3.body.account];
    const log = await getLog(mockPort2);
    const tried = log.map((x) => x.account);
    console.log("returned:", returned.join(" -> "));
    console.log("upstream tried:", tried.join(" -> "));
    assert(returned.join(",") === [ACCOUNTS[0], ACCOUNTS[2], ACCOUNTS[0], ACCOUNTS[2]].join(","), "429 returned sequence mismatch");
    assert(tried.slice(0, 5).join(",") === [ACCOUNTS[0], ACCOUNTS[1], ACCOUNTS[2], ACCOUNTS[0], ACCOUNTS[2]].join(","), "429 upstream tried sequence mismatch");
    assert(r1.attempt === "1", `429 retry response should expose attempt=1, got ${r1.attempt}`);
  } finally {
    await stop(proxy);
    await stop(mock);
  }

  const mockPort3 = 20510 + Math.floor(Math.random() * 1000);
  const proxyPort3 = 10350 + Math.floor(Math.random() * 1000);
  mock = await startMock(tmp, mockPort3, { [ACCOUNTS[1]]: 500 });
  proxy = await startProxy(authDir, mockPort3, proxyPort3);
  try {
    console.log("scenario 4: 5xx upstream failure retries next credential without surfacing 5xx");
    const r0 = await request(proxyPort3);
    const r1 = await request(proxyPort3);
    const returned = [r0.body.account, r1.body.account];
    const log = await getLog(mockPort3);
    const tried = log.map((x) => x.account);
    console.log("returned:", returned.join(" -> "));
    console.log("upstream tried:", tried.join(" -> "));
    assert(r0.status === 200 && r1.status === 200, `5xx retry should return successes, got ${r0.status}/${r1.status}`);
    assert(returned.join(",") === [ACCOUNTS[0], ACCOUNTS[2]].join(","), "5xx returned sequence mismatch");
    assert(tried.slice(0, 3).join(",") === [ACCOUNTS[0], ACCOUNTS[1], ACCOUNTS[2]].join(","), "5xx upstream tried sequence mismatch");
    assert(r1.attempt === "1", `5xx retry response should expose attempt=1, got ${r1.attempt}`);
  } finally {
    await stop(proxy);
    await stop(mock);
  }

  console.log("granular round-robin tests: PASS");
}

await main();
