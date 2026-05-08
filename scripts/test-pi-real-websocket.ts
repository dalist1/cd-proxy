#!/usr/bin/env bun
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const HOME = process.env.HOME ?? ".";
const AUTH_DIR = expandHome(process.env.CD_PROXY_AUTH_DIR ?? "~/.local/share/cd-proxy/auths");
const MODEL = process.env.CD_PROXY_REAL_WS_MODEL ?? "gpt-5.3-codex";
const EXPECTED = `cd-proxy-real-ws-ok-${Date.now().toString(36)}`;
const API_KEY = fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "pi-local-proxy-auth" } });

function expandHome(p: string) { return p === "~" ? HOME : p.startsWith("~/") ? HOME + p.slice(1) : p; }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
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
async function drain(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return "";
  try { return await new Response(stream).text(); } catch { return ""; }
}
async function collect(stream: ReadableStream<Uint8Array> | null, onChunk?: (text: string) => void) {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      out += text;
      onChunk?.(text);
    }
    const tail = decoder.decode();
    out += tail;
    if (tail) onChunk?.(tail);
  } catch {}
  return out;
}
function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function timeoutAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(value), ms);
    timer.unref?.();
  });
}
async function waitFor(url: string, headers?: Record<string, string>) {
  const deadline = Date.now() + 20_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers });
      const text = await res.text().catch(() => "");
      if (res.ok) return text;
      last = `${res.status} ${text}`;
    } catch (err) { last = String(err); }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting for ${url}: ${last}`);
}
async function waitForTerminalWebSocketStats(port: number, apiKey: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: `Bearer ${apiKey}` } });
      const text = await res.text();
      if (res.ok) {
        const status = JSON.parse(text);
        const stats = status.transport_stats ?? {};
        if ((stats.responsesWebSocketTerminalEvents ?? 0) >= 1) return status;
        last = JSON.stringify(stats);
      } else {
        last = `${res.status} ${text}`;
      }
    } catch (err) { last = String(err); }
    await sleep(150);
  }
  throw new Error(`timeout waiting for terminal WebSocket response event: ${last}`);
}

const authFiles = (await readdir(AUTH_DIR).catch(() => []))
  .filter((name) => name.startsWith("codex-") && name.endsWith(".json"));
if (authFiles.length === 0) {
  console.error(`No real Codex auth files found in ${AUTH_DIR}. Run ./scripts/codex-login-to-cd-proxy.sh first.`);
  process.exit(1);
}

const temp = await mkdtemp(join(tmpdir(), "cd-proxy-real-pi-ws-"));
const piDir = join(temp, "pi");
const proxyPort = await freePort();
const proxyCommand = ["bun", "run", "src/server.ts"];
const proxy = Bun.spawn(proxyCommand, {
  cwd: ROOT,
  stdout: "pipe",
  stderr: "pipe",
  env: {
    ...process.env,
    CD_PROXY_HOST: "127.0.0.1",
    CD_PROXY_PORT: String(proxyPort),
    CD_PROXY_AUTH_DIR: AUTH_DIR,
    CD_PROXY_API_KEY: API_KEY,
    CD_PROXY_DEBUG: "1",
  },
});
let proxyStdoutText = "";
let proxyStderrText = "";
const proxyStdout = collect(proxy.stdout, (text) => { proxyStdoutText += text; });
const proxyStderr = collect(proxy.stderr, (text) => { proxyStderrText += text; });

try {
  await Bun.write(join(piDir, ".keep"), "");
  await writeFile(join(piDir, "models.json"), JSON.stringify({
    providers: {
      openai: {
        baseUrl: `http://127.0.0.1:${proxyPort}`,
        apiKey: API_KEY,
        api: "openai-codex-responses",
        models: [{
          id: MODEL,
          name: `cd-proxy Real Pi WebSocket (${MODEL})`,
          reasoning: true,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  }, null, 2));
  await writeFile(join(piDir, "settings.json"), JSON.stringify({
    transport: "websocket",
    defaultProvider: "openai",
    defaultModel: MODEL,
    retry: { enabled: false, provider: { maxRetries: 0 } },
  }, null, 2));

  await waitFor(`http://127.0.0.1:${proxyPort}/health`);

  const pi = Bun.spawn([
    `${HOME}/.bun/bin/pi`,
    "--provider", "openai",
    "--model", MODEL,
    "--thinking", "off",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "-p",
    `Reply exactly with this token and no extra words: ${EXPECTED}`,
  ], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: piDir,
      PI_PACKAGE_DIR: `${HOME}/.bun/install/global/node_modules/@earendil-works/pi-coding-agent`,
      PI_SKIP_VERSION_CHECK: "1",
      PI_NO_PROXY_AUTO_START: "1",
      OPENAI_API_KEY: "",
    },
  });
  let stdout = "";
  let stderr = "";
  const stdoutDone = collect(pi.stdout, (text) => { stdout += text; });
  const stderrDone = collect(pi.stderr, (text) => { stderr += text; });
  const exitPromise = pi.exited.catch(() => -1);
  const timeoutMs = Number(process.env.CD_PROXY_REAL_WS_TIMEOUT_MS ?? "20000");
  let timedOut = false;
  const statusResult = await Promise.race([
    waitForTerminalWebSocketStats(proxyPort, API_KEY, timeoutMs).then((status) => ({ kind: "terminal" as const, status })),
    exitPromise.then((exitCode) => ({ kind: "exit" as const, exitCode })),
    timeoutAfter(timeoutMs, { kind: "timeout" as const }),
  ]);
  if (statusResult.kind !== "terminal") {
    timedOut = statusResult.kind === "timeout";
    pi.kill("SIGTERM");
    setTimeout(() => pi.kill("SIGKILL"), 1000).unref();
    const exitCode = statusResult.kind === "exit" ? statusResult.exitCode : await exitPromise;
    await Promise.allSettled([stdoutDone, stderrDone]);
    throw new Error(`pi ${timedOut ? "timed out" : `exited ${exitCode}`} before cd-proxy saw a terminal WebSocket event\nstdout:\n${stdout}\nstderr:\n${stderr}\nproxy stdout:\n${proxyStdoutText}\nproxy stderr:\n${proxyStderrText}`);
  }

  const status = statusResult.status;
  const stats = status.transport_stats ?? {};
  assert(stats.responsesWebSocketUpgrades >= 1, `cd-proxy did not record a WebSocket upgrade: ${JSON.stringify(stats)}`);
  assert(stats.responsesWebSocketUpstreamOpens >= 1, `cd-proxy did not open upstream WebSocket: ${JSON.stringify(stats)}`);
  assert(stats.responsesHttpRequests === 0, `SSE fallback/HTTP Responses path was used: ${JSON.stringify(stats)}`);

  let piCleanupKilled = false;
  const exitedAfterMarker = await Promise.race([exitPromise.then(() => true), sleep(1000).then(() => false)]);
  if (!exitedAfterMarker) {
    // Pi currently leaves a cached Codex WebSocket idle timer alive in one-shot
    // mode after response.completed. We have already proven the real WebSocket
    // path worked, so clean up instead of making the smoke test wait for that
    // unrelated idle timer.
    piCleanupKilled = true;
    pi.kill("SIGTERM");
    setTimeout(() => pi.kill("SIGKILL"), 1000).unref();
  }
  const exitCode = await exitPromise;
  await Promise.allSettled([stdoutDone, stderrDone]);
  if (exitCode !== 0 && !piCleanupKilled && !timedOut) {
    throw new Error(`pi exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}\nproxy stdout:\n${proxyStdoutText}\nproxy stderr:\n${proxyStderrText}`);
  }
  assert(stdout.includes(EXPECTED), `Pi output did not include expected marker after cleanup. stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);

  console.log(JSON.stringify({
    ok: true,
    real_credentials: true,
    auth_dir: AUTH_DIR.replace(HOME, "~"),
    auth_file_count: authFiles.length,
    model: MODEL,
    output: stdout.trim(),
    transport_stats: stats,
    sse_fallback_used: false,
    pi_cleanup_killed: piCleanupKilled,
  }, null, 2));
} finally {
  proxy.kill();
  await Promise.allSettled([proxy.exited, proxyStdout, proxyStderr]);
  await rm(temp, { recursive: true, force: true });
}
