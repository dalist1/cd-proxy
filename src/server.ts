import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dlopen, FFIType, suffix } from "bun:ffi";
import { refreshCodexTokens } from "./codex-auth";

const DEFAULT_CHATGPT_CODEX_BASE = "https://chatgpt.com/backend-api/codex";
const CHATGPT_CODEX_BASE = (process.env.CD_PROXY_UPSTREAM_BASE ?? DEFAULT_CHATGPT_CODEX_BASE).replace(/\/+$/, "");
const LEGACY_LOCAL_PROXY_PORT = "8317"; // NATIVE_ASSERT_ALLOW: refused legacy local proxy port only.
assertNativeUpstreamBase(CHATGPT_CODEX_BASE);
const HOME = process.env.HOME ?? ".";
const AUTH_DIR = expandHome(process.env.CD_PROXY_AUTH_DIR ?? "~/.local/share/cd-proxy/auths");
const API_KEY_FILE = expandHome(process.env.CD_PROXY_API_KEY_FILE ?? "~/.config/cd-proxy/api-key");
const PORT = Number(process.env.CD_PROXY_PORT ?? "8318");
const HOST = process.env.CD_PROXY_HOST ?? "127.0.0.1";
const DEBUG = process.env.CD_PROXY_DEBUG === "1" || process.env.CD_PROXY_DEBUG === "true";
const EXPOSE_ROTATION_HEADERS = process.env.CD_PROXY_EXPOSE_ROTATION_HEADERS === "1" || process.env.CD_PROXY_EXPOSE_ROTATION_HEADERS === "true";
const MAX_RETRY_CREDENTIALS = Number(process.env.CD_PROXY_MAX_RETRY_CREDENTIALS ?? "5");
const COOLDOWN_MS = Number(process.env.CD_PROXY_COOLDOWN_MS ?? "30000");
const REFRESH_SKEW_MS = Number(process.env.CD_PROXY_REFRESH_SKEW_MS ?? String(5 * 60_000));
const MODEL_IDS = (process.env.CD_PROXY_MODELS ?? "gpt-5.3-codex,gpt-5.3-codex-spark,codex-auto-review,gpt-5.5,gpt-5.2")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ZIG_CORE_PATH = expandHome(process.env.CD_PROXY_ZIG_CORE ?? join(process.cwd(), "zig-out", "lib", `libcd_proxy_core.${suffix}`));

interface CodexAuthFile {
  type?: string;
  email?: string;
  account_id?: string;
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expired?: string;
  last_refresh?: string;
  disabled?: boolean;
}

interface AuthEntry {
  path: string;
  label: string;
  data: CodexAuthFile;
  coolingUntil: number;
  refreshInFlight?: Promise<void>;
}

interface WsProxyData {
  upstream: WebSocket;
  upstreamOpen: boolean;
  queue: Array<string | ArrayBuffer | Uint8Array>;
  authLabel: string;
}

let auths: AuthEntry[] = [];
let rr = 0;
let apiKey: string | undefined;
const transportStats = {
  responsesHttpRequests: 0,
  responsesWebSocketUpgrades: 0,
  responsesWebSocketUpstreamOpens: 0,
};
let zigCore: undefined | {
  cdproxy_pick_next_u32(len: number, start: number, unavailableMask: number): number;
  cdproxy_mask_bit_u32(idx: number): number;
};

function expandHome(p: string): string {
  return p === "~" ? HOME : p.startsWith("~/") ? HOME + p.slice(1) : p;
}

function assertNativeUpstreamBase(base: string) {
  const parsed = new URL(base);
  const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (localHosts.has(parsed.hostname) && parsed.port === LEGACY_LOCAL_PROXY_PORT) {
    throw new Error(
      `Refusing CD_PROXY_UPSTREAM_BASE=${base}. cd-proxy is a native Codex/ChatGPT OAuth implementation and must not wrap another local proxy. ` +
      `Unset CD_PROXY_UPSTREAM_BASE to use ${DEFAULT_CHATGPT_CODEX_BASE}, or point it at a non-production mock only for tests.`,
    );
  }
}

function log(...args: unknown[]) {
  if (DEBUG) console.error(new Date().toISOString(), ...args);
}

function redact(s?: string) {
  if (!s) return s;
  return s.length <= 10 ? "REDACTED" : `${s.slice(0, 5)}…${s.slice(-4)}`;
}

function loadZigCore() {
  if (zigCore || !existsSync(ZIG_CORE_PATH)) return;
  try {
    const lib = dlopen(ZIG_CORE_PATH, {
      cdproxy_pick_next_u32: { args: [FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
      cdproxy_mask_bit_u32: { args: [FFIType.u32], returns: FFIType.u32 },
    });
    zigCore = lib.symbols as unknown as typeof zigCore;
    log(`loaded Zig rotation core: ${ZIG_CORE_PATH}`);
  } catch (err) {
    console.error(`warning: failed to load Zig rotation core at ${ZIG_CORE_PATH}; using JS fallback: ${err}`);
  }
}

async function loadApiKey() {
  if (process.env.CD_PROXY_API_KEY) {
    apiKey = process.env.CD_PROXY_API_KEY.trim();
    return;
  }
  try {
    apiKey = (await readFile(API_KEY_FILE, "utf8")).trim();
  } catch {
    apiKey = undefined;
  }
}

async function loadAuths() {
  const next: AuthEntry[] = [];
  const names = (await readdir(AUTH_DIR).catch(() => []))
    .filter((name) => name.startsWith("codex-") && name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const path = join(AUTH_DIR, name);
    try {
      const data = JSON.parse(await readFile(path, "utf8")) as CodexAuthFile;
      if (data.type && data.type !== "codex") continue;
      if (!data.access_token || !data.refresh_token) continue;
      const old = auths.find((a) => a.path === path);
      next.push({
        path,
        label: data.email ?? name.replace(/^codex-/, "").replace(/\.json$/, ""),
        data,
        coolingUntil: old?.coolingUntil ?? 0,
        refreshInFlight: old?.refreshInFlight,
      });
    } catch (err) {
      console.error(`failed to load ${path}:`, err);
    }
  }

  auths = next;
  if (rr >= auths.length) rr = 0;
  log(`loaded ${auths.length} codex auth(s) from ${AUTH_DIR}`);
}

function isTokenExpiring(data: CodexAuthFile): boolean {
  if (data.expired) {
    const t = Date.parse(data.expired);
    if (!Number.isNaN(t)) return Date.now() + REFRESH_SKEW_MS >= t;
  }
  if (data.id_token) {
    const exp = jwtExpMs(data.id_token);
    if (exp) return Date.now() + REFRESH_SKEW_MS >= exp;
  }
  return false;
}

function jwtExpMs(jwt: string): number | undefined {
  try {
    const payload = jwt.split(".")[1];
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof json.exp === "number" ? json.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function decodeJwtClaims(jwt?: string): any | undefined {
  if (!jwt) return undefined;
  try {
    const payload = jwt.split(".")[1];
    return JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

async function persistAuth(a: AuthEntry) {
  await writeFile(a.path, JSON.stringify(a.data) + "\n", { mode: 0o600 });
}

async function refreshAuth(a: AuthEntry): Promise<void> {
  if (a.refreshInFlight) return a.refreshInFlight;
  a.refreshInFlight = (async () => {
    log(`refreshing ${a.label} (${redact(a.data.refresh_token)})`);
    const refreshed = await refreshCodexTokens(a.data.refresh_token);
    a.data.access_token = refreshed.access_token;
    a.data.refresh_token = refreshed.refresh_token;
    if (refreshed.id_token) a.data.id_token = refreshed.id_token;
    if (refreshed.expired) a.data.expired = refreshed.expired;
    a.data.last_refresh = refreshed.last_refresh;
    const claims = decodeJwtClaims(a.data.id_token);
    a.data.email ??= claims?.email ?? claims?.["https://api.openai.com/profile"]?.email;
    a.data.account_id ??= claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    await persistAuth(a);
  })().finally(() => { a.refreshInFlight = undefined; });
  return a.refreshInFlight;
}

function chooseAuth(exclude = new Set<AuthEntry>()): AuthEntry | undefined {
  const now = Date.now();
  if (auths.length === 0) return undefined;

  // Hot-path rotation: let Zig do the wrap/skip scan for the common <=32 credential case.
  // JS still owns credential objects/timers; Zig only receives a compact unavailable bitmask.
  if (zigCore && auths.length <= 32) {
    let unavailableMask = 0;
    for (let i = 0; i < auths.length; i++) {
      const a = auths[i];
      if (exclude.has(a) || a.data.disabled || a.coolingUntil > now) {
        unavailableMask = (unavailableMask | zigCore.cdproxy_mask_bit_u32(i)) >>> 0;
      }
    }
    const idx = zigCore.cdproxy_pick_next_u32(auths.length, rr % auths.length, unavailableMask);
    if (idx >= 0) {
      rr = idx + 1;
      return auths[idx];
    }
    rr += auths.length;
    return undefined;
  }

  for (let i = 0; i < auths.length; i++) {
    const idx = rr++ % auths.length;
    const a = auths[idx];
    if (exclude.has(a) || a.data.disabled || a.coolingUntil > now) continue;
    return a;
  }
  return undefined;
}

async function ensureFresh(a: AuthEntry) {
  if (isTokenExpiring(a.data)) await refreshAuth(a);
}

function unauthorized(req: Request) {
  if (!apiKey) return false;
  const got = req.headers.get("authorization") ?? "";
  return got !== `Bearer ${apiKey}`;
}

function publicAuthInfo(a: AuthEntry) {
  return {
    label: a.label,
    account_id_prefix: a.data.account_id ? a.data.account_id.slice(0, 5) : undefined,
    disabled: !!a.data.disabled,
    cooling_ms: Math.max(0, a.coolingUntil - Date.now()),
    expired: a.data.expired,
    file: a.path.replace(HOME, "~"),
  };
}

function jsonResponse(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value, null, 2), { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
}

function withRotationHeaders(res: Response, a: AuthEntry, attempt: number): Response {
  if (!EXPOSE_ROTATION_HEADERS) return res;
  const headers = new Headers(res.headers);
  headers.set("x-cd-proxy-auth-label", a.label);
  if (a.data.account_id) headers.set("x-cd-proxy-auth-account-prefix", a.data.account_id.slice(0, 5));
  headers.set("x-cd-proxy-auth-file", a.path.replace(HOME, "~"));
  headers.set("x-cd-proxy-attempt", String(attempt));
  headers.set("x-cd-proxy-next-rr-index", String(rr % Math.max(1, auths.length)));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function upstreamPath(url: URL): string | undefined {
  if (url.pathname === "/health" || url.pathname === "/v1/health") return undefined;
  if (url.pathname === "/v1/models" || url.pathname === "/models") return "models";
  if (url.pathname === "/v1/responses" || url.pathname === "/responses" || url.pathname === "/codex/responses" || url.pathname === "/backend-api/codex/responses") return "responses";
  if (url.pathname === "/v1/responses/compact" || url.pathname === "/responses/compact" || url.pathname === "/codex/responses/compact" || url.pathname === "/backend-api/codex/responses/compact") return "responses/compact";
  return undefined;
}

function buildHeaders(req: Request, a: AuthEntry): Headers {
  const h = new Headers(req.headers);
  h.delete("host");
  h.delete("connection");
  h.delete("content-length");
  h.set("authorization", `Bearer ${a.data.access_token}`);
  h.set("content-type", req.headers.get("content-type") ?? "application/json");
  if (a.data.account_id) h.set("ChatGPT-Account-ID", a.data.account_id);
  // Codex CLI normally sends Accept: text/event-stream for /responses; keep caller header if present.
  if (!h.has("accept") && req.method !== "GET") h.set("accept", "text/event-stream");
  return h;
}

function buildWebSocketHeaders(req: Request, a: AuthEntry): Headers {
  const h = new Headers(req.headers);
  for (const name of [
    "host",
    "connection",
    "upgrade",
    "content-length",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "sec-websocket-protocol",
  ]) h.delete(name);
  h.set("authorization", `Bearer ${a.data.access_token}`);
  if (a.data.account_id) h.set("ChatGPT-Account-ID", a.data.account_id);
  return h;
}

function websocketUrlForPath(path: string): string {
  const url = new URL(`${CHATGPT_CODEX_BASE}/${path}`);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  return url.toString();
}

function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket";
}

async function proxyWebSocketUpgrade(req: Request, server: any, path: string): Promise<Response> {
  if (unauthorized(req)) return jsonResponse({ error: { message: "unauthorized" } }, { status: 401 });
  if (auths.length === 0) return jsonResponse({ error: { message: `no codex auth files found in ${AUTH_DIR}` } }, { status: 503 });

  const tried = new Set<AuthEntry>();
  const a = chooseAuth(tried);
  if (!a) return jsonResponse({ error: { message: "all codex credentials failed or are cooling down" } }, { status: 503 });
  tried.add(a);
  await ensureFresh(a);

  const upstreamUrl = websocketUrlForPath(path);
  const upstreamHeaders = Object.fromEntries(buildWebSocketHeaders(req, a).entries());
  const upstream = new WebSocket(upstreamUrl, { headers: upstreamHeaders });
  const queue: WsProxyData["queue"] = [];
  const data: WsProxyData = { upstream, upstreamOpen: false, queue, authLabel: a.label };

  upstream.addEventListener("open", () => {
    transportStats.responsesWebSocketUpstreamOpens++;
    data.upstreamOpen = true;
    log(`WS ${new URL(req.url).pathname} -> ${upstreamUrl} as ${a.label}`);
    for (const msg of data.queue.splice(0)) upstream.send(msg as any);
  });
  upstream.addEventListener("message", async (event: MessageEvent) => {
    const client = (upstream as any).__client;
    if (!client) return;
    const payload = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
    client.send(payload as any);
  });
  upstream.addEventListener("close", (event: CloseEvent) => {
    const client = (upstream as any).__client;
    try { client?.close(event.code || 1000, event.reason || undefined); } catch {}
  });
  upstream.addEventListener("error", () => {
    const client = (upstream as any).__client;
    try { client?.close(1011, "upstream websocket error"); } catch {}
  });

  const ok = server.upgrade(req, {
    data,
    headers: EXPOSE_ROTATION_HEADERS ? {
      "x-cd-proxy-auth-label": a.label,
      ...(a.data.account_id ? { "x-cd-proxy-auth-account-prefix": a.data.account_id.slice(0, 5) } : {}),
      "x-cd-proxy-next-rr-index": String(rr % Math.max(1, auths.length)),
    } : undefined,
  });
  if (!ok) {
    upstream.close();
    return jsonResponse({ error: { message: "websocket upgrade failed" } }, { status: 400 });
  }
  transportStats.responsesWebSocketUpgrades++;
  return undefined as any;
}

async function proxyWithRotation(req: Request, path: string): Promise<Response> {
  if (path === "responses" || path === "responses/compact") transportStats.responsesHttpRequests++;
  const tried = new Set<AuthEntry>();
  let lastStatus = 0;
  let lastText = "";
  const requestBody = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();

  for (let attempt = 0; attempt < Math.min(MAX_RETRY_CREDENTIALS, Math.max(1, auths.length)); attempt++) {
    const a = chooseAuth(tried);
    if (!a) break;
    tried.add(a);
    try {
      await ensureFresh(a);
      const upstream = `${CHATGPT_CODEX_BASE}/${path}`;
      log(`${req.method} ${new URL(req.url).pathname} -> ${upstream} as ${a.label}`);
      const res = await fetch(upstream, {
        method: req.method,
        headers: buildHeaders(req, a),
        body: requestBody,
        // @ts-ignore Bun supports streaming request bodies.
        duplex: "half",
      });

      if (res.status === 401) {
        lastStatus = res.status;
        lastText = await res.text().catch(() => "");
        try {
          await refreshAuth(a);
          const retry = await fetch(upstream, {
            method: req.method,
            headers: buildHeaders(req, a),
            body: requestBody,
            // @ts-ignore
            duplex: "half",
          });
          if (retry.ok || retry.status < 400 || retry.status === 400) return withRotationHeaders(retry, a, attempt);
          lastStatus = retry.status;
          lastText = await retry.text().catch(() => "");
        } catch (err) {
          lastText = String(err);
        }
        a.coolingUntil = Date.now() + COOLDOWN_MS;
        continue;
      }

      if (res.status === 429) {
        lastStatus = res.status;
        lastText = await res.text().catch(() => "");
        a.coolingUntil = Date.now() + COOLDOWN_MS;
        log(`cooling ${a.label} after 429`);
        continue;
      }

      return withRotationHeaders(res, a, attempt);
    } catch (err) {
      lastStatus = 502;
      lastText = String(err);
      a.coolingUntil = Date.now() + Math.min(COOLDOWN_MS, 5000);
    }
  }

  return jsonResponse({ error: { message: "all codex credentials failed or are cooling down", status: lastStatus, detail: lastText.slice(0, 1000) } }, { status: lastStatus || 503 });
}

async function handle(req: Request, server?: any): Promise<Response> {
  const url = new URL(req.url);
  if (isWebSocketUpgrade(req)) {
    const path = upstreamPath(url);
    if (!path || path !== "responses") return jsonResponse({ error: { message: "websocket endpoint not found" } }, { status: 404 });
    return proxyWebSocketUpgrade(req, server, path);
  }
  if (url.pathname === "/health" || url.pathname === "/v1/health") {
    return jsonResponse({ ok: true, native_implementation: true, upstream_base: CHATGPT_CODEX_BASE, auths: auths.filter((a) => !a.data.disabled).length, auth_dir: AUTH_DIR, transport_stats: transportStats, zig_core: !!zigCore });
  }
  if (url.pathname === "/reload" && req.method === "POST") {
    if (unauthorized(req)) return jsonResponse({ error: "unauthorized" }, { status: 401 });
    await loadAuths();
    return jsonResponse({ ok: true, auths: auths.length });
  }
  if (unauthorized(req)) return jsonResponse({ error: { message: "unauthorized" } }, { status: 401 });
  if (url.pathname === "/status" || url.pathname === "/v1/status") {
    return jsonResponse({ ok: true, native_implementation: true, upstream_base: CHATGPT_CODEX_BASE, rr_index: rr % Math.max(1, auths.length), auth_dir: AUTH_DIR, transport_stats: transportStats, zig_core: !!zigCore, zig_core_path: ZIG_CORE_PATH, auths: auths.map(publicAuthInfo) });
  }
  if (url.pathname === "/debug/rotation" || url.pathname === "/v1/debug/rotation") {
    const count = Math.min(100, Math.max(1, Number(url.searchParams.get("count") ?? String(auths.length || 1))));
    const picked = [];
    for (let i = 0; i < count; i++) {
      const a = chooseAuth();
      picked.push(a ? publicAuthInfo(a) : null);
    }
    return jsonResponse({ ok: true, count, picked, next_rr_index: rr % Math.max(1, auths.length) });
  }
  const path = upstreamPath(url);
  if (!path) return jsonResponse({ error: { message: "not found" } }, { status: 404 });
  if (path === "models") {
    return jsonResponse({
      object: "list",
      data: MODEL_IDS.map((id) => ({ id, object: "model", created: 1770307200, owned_by: "openai" })),
    });
  }
  if (auths.length === 0) return jsonResponse({ error: { message: `no codex auth files found in ${AUTH_DIR}` } }, { status: 503 });
  return proxyWithRotation(req, path);
}

loadZigCore();

if (process.argv.includes("--check")) {
  await loadApiKey();
  await loadAuths();
  console.log(JSON.stringify({ ok: auths.length > 0, native_implementation: true, upstream_base: CHATGPT_CODEX_BASE, zig_core: !!zigCore, zig_core_path: ZIG_CORE_PATH, auths: auths.map((a) => ({ label: a.label, disabled: !!a.data.disabled, account_id: a.data.account_id ? redact(a.data.account_id) : undefined })), api_key: !!apiKey, api_key_file: API_KEY_FILE }, null, 2));
  process.exit(auths.length > 0 ? 0 : 1);
}

await loadApiKey();
await loadAuths();
setInterval(loadAuths, 60_000).unref();

Bun.serve({
  host: HOST,
  port: PORT,
  fetch: handle,
  websocket: {
    open(ws: ServerWebSocket<WsProxyData>) {
      (ws.data.upstream as any).__client = ws;
    },
    message(ws: ServerWebSocket<WsProxyData>, message: string | Buffer) {
      if (ws.data.upstreamOpen) ws.data.upstream.send(message as any);
      else ws.data.queue.push(message as any);
    },
    close(ws: ServerWebSocket<WsProxyData>) {
      try { ws.data.upstream.close(); } catch {}
    },
  },
});
console.error(`cd-proxy listening on http://${HOST}:${PORT} using ${auths.length} codex auth(s); upstream=${CHATGPT_CODEX_BASE}`);
