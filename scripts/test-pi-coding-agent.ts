#!/usr/bin/env bun
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const API_KEY = fakeJwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "pi-local-account" },
});
const MODEL = "gpt-5.3-codex";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

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

async function waitFor(url: string, headers?: Record<string, string>) {
  const deadline = Date.now() + 10_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return;
      last = `${res.status} ${await res.text().catch(() => "")}`;
    } catch (err) {
      last = String(err);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${url}: ${last}`);
}

function startMockUpstream(port: number) {
  let wsConnections = 0;
  let httpPosts = 0;
  let lastWsHeaders: Record<string, string> = {};
  let lastWsRequest: any;

  const server = Bun.serve<{ openedAt: number }>({
    host: "127.0.0.1",
    port,
    fetch(req, server) {
      const url = new URL(req.url);
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        lastWsHeaders = Object.fromEntries(req.headers.entries());
        const ok = server.upgrade(req, { data: { openedAt: Date.now() } });
        return ok ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/responses" && req.method === "POST") {
        httpPosts++;
        return new Response("SSE fallback is disabled in this test", { status: 599 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open() { wsConnections++; },
      async message(ws, message) {
        lastWsRequest = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
        const text = "pi-cd-proxy-ok";
        for (const event of [
          { type: "response.created", response: { id: "resp_pi_1" } },
          { type: "response.output_item.added", item: { id: "msg_pi_1", type: "message", role: "assistant", content: [] } },
          { type: "response.content_part.added", part: { type: "output_text", text: "", annotations: [] } },
          { type: "response.output_text.delta", delta: text },
          { type: "response.output_item.done", item: { id: "msg_pi_1", type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } },
          { type: "response.completed", response: { id: "resp_pi_1", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } },
        ]) {
          ws.send(JSON.stringify(event));
        }
        ws.close(1000, "test complete");
      },
    },
  });

  return {
    server,
    stats: () => ({ wsConnections, httpPosts, lastWsHeaders, lastWsRequest }),
  };
}

function startCdProxy(port: number, mockPort: number, authDir: string) {
  return Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CD_PROXY_HOST: "127.0.0.1",
      CD_PROXY_PORT: String(port),
      CD_PROXY_AUTH_DIR: authDir,
      CD_PROXY_API_KEY: API_KEY,
      CD_PROXY_UPSTREAM_BASE: `http://127.0.0.1:${mockPort}`,
      CD_PROXY_EXPOSE_ROTATION_HEADERS: "1",
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return "";
  try { return await new Response(stream).text(); } catch { return ""; }
}

const temp = await mkdtemp(join(tmpdir(), "cd-proxy-pi-"));
const authDir = join(temp, "auths");
const piDir = join(temp, "pi");
await mkdir(authDir, { recursive: true, mode: 0o700 });
await mkdir(piDir, { recursive: true, mode: 0o700 });

const mockPort = await freePort();
const proxyPort = await freePort();
const mock = startMockUpstream(mockPort);
const proxy = startCdProxy(proxyPort, mockPort, authDir);

try {
  await writeFile(join(authDir, "codex-pi-test-plus.json"), JSON.stringify({
    type: "codex",
    email: "pi-test@example.invalid",
    access_token: "fake-upstream-token",
    refresh_token: "fake-refresh-token",
    account_id: "upstream-account-id",
    expired: new Date(Date.now() + 60 * 60_000).toISOString(),
    disabled: false,
  }) + "\n", { mode: 0o600 });

  await writeFile(join(piDir, "models.json"), JSON.stringify({
    providers: {
      openai: {
        baseUrl: `http://127.0.0.1:${proxyPort}`,
        apiKey: API_KEY,
        api: "openai-codex-responses",
        models: [{
          id: MODEL,
          name: "cd-proxy Pi WebSocket Test",
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
    `${process.env.HOME ?? ""}/.bun/bin/pi`,
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
    "Reply exactly: pi-cd-proxy-ok",
  ], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: piDir,
      PI_PACKAGE_DIR: `${process.env.HOME ?? ""}/.bun/install/global/node_modules/@earendil-works/pi-coding-agent`,
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
  }, 30_000);
  const stdoutPromise = drain(pi.stdout);
  const stderrPromise = drain(pi.stderr);
  const exitCode = await pi.exited.catch(() => -1);
  clearTimeout(killTimer);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (exitCode !== 0 && !(timedOut && stdout.includes("pi-cd-proxy-ok"))) {
    throw new Error(`pi exited ${exitCode}${timedOut ? " after timeout" : ""}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  const stats = mock.stats();
  assert(stdout.includes("pi-cd-proxy-ok"), `pi output did not include expected response. stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
  assert(stats.wsConnections > 0, "pi did not reach cd-proxy/upstream over WebSocket");
  assert(stats.httpPosts === 0, `SSE fallback was used (${stats.httpPosts} HTTP POSTs)`);
  assert(stats.lastWsHeaders["openai-beta"]?.includes("responses_websockets"), "pi WebSocket beta header was not preserved");
  assert(stats.lastWsRequest?.type === "response.create", "pi did not send Codex response.create WebSocket frame");

  console.log(JSON.stringify({ ok: true, output: stdout.trim(), wsConnections: stats.wsConnections, httpPosts: stats.httpPosts, transport: "websocket" }, null, 2));
} finally {
  proxy.kill();
  mock.server.stop(true);
  await Promise.allSettled([proxy.exited]);
  await rm(temp, { recursive: true, force: true });
}
