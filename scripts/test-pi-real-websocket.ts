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

const authFiles = (await readdir(AUTH_DIR).catch(() => []))
  .filter((name) => name.startsWith("codex-") && name.endsWith(".json"));
if (authFiles.length === 0) {
  console.error(`No real Codex auth files found in ${AUTH_DIR}. Run ./scripts/codex-login-to-cd-proxy.sh first.`);
  process.exit(1);
}

const temp = await mkdtemp(join(tmpdir(), "cd-proxy-real-pi-ws-"));
const piDir = join(temp, "pi");
const proxyPort = await freePort();
const proxy = Bun.spawn(["bun", "run", "src/server.ts"], {
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
const proxyStdout = drain(proxy.stdout);
const proxyStderr = drain(proxy.stderr);

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
      PI_PACKAGE_DIR: `${HOME}/.bun/install/global/node_modules/@mariozechner/pi-coding-agent`,
      PI_SKIP_VERSION_CHECK: "1",
      PI_NO_PROXY_AUTO_START: "1",
      OPENAI_API_KEY: "",
    },
  });
  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    pi.kill("SIGTERM");
    setTimeout(() => pi.kill("SIGKILL"), 1000).unref();
  }, Number(process.env.CD_PROXY_REAL_WS_TIMEOUT_MS ?? "120000"));
  const [exitCode, stdout, stderr] = await Promise.all([pi.exited, drain(pi.stdout), drain(pi.stderr)]);
  clearTimeout(killTimer);
  if (exitCode !== 0 && !(timedOut && stdout.includes(EXPECTED))) {
    throw new Error(`pi exited ${exitCode}${timedOut ? " after timeout" : ""}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  const status = JSON.parse(await waitFor(`http://127.0.0.1:${proxyPort}/status`, { authorization: `Bearer ${API_KEY}` }));
  const stats = status.transport_stats ?? {};
  assert(stats.responsesWebSocketUpgrades >= 1, `cd-proxy did not record a WebSocket upgrade: ${JSON.stringify(stats)}`);
  assert(stats.responsesWebSocketUpstreamOpens >= 1, `cd-proxy did not open upstream WebSocket: ${JSON.stringify(stats)}`);
  assert(stats.responsesHttpRequests === 0, `SSE fallback/HTTP Responses path was used: ${JSON.stringify(stats)}`);
  assert(stdout.includes(EXPECTED), `Pi output did not include expected marker. stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);

  console.log(JSON.stringify({
    ok: true,
    real_credentials: true,
    auth_dir: AUTH_DIR.replace(HOME, "~"),
    auth_file_count: authFiles.length,
    model: MODEL,
    output: stdout.trim(),
    transport_stats: stats,
    sse_fallback_used: false,
  }, null, 2));
} finally {
  proxy.kill();
  await Promise.allSettled([proxy.exited, proxyStdout, proxyStderr]);
  await rm(temp, { recursive: true, force: true });
}
