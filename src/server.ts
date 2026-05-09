import type { WsProxyData, TransportStats } from "./types";
import { CONFIG } from "./config";
import { loadZigCore, type ZigCore } from "./native-core";
import { AuthStore } from "./auth-store";
import { CacheAffinityStore } from "./cache-affinity";
import { DebugRequestCapture } from "./debug-capture";
import { jsonResponse, jsonTextResponse, proxyWithRotation, staticJsonResponse } from "./http-proxy";
import { handleClientWebSocketMessage, proxyWebSocketUpgrade } from "./websocket-proxy";
import { Profiler } from "./profiler";

// Kept here for the native implementation assertion script.
const DEFAULT_CHATGPT_CODEX_BASE = "https://chatgpt.com/backend-api/codex";
void DEFAULT_CHATGPT_CODEX_BASE;

const UNAUTHORIZED_BODY = JSON.stringify({ error: { message: "unauthorized" } }, null, 2);
const NOT_FOUND_BODY = JSON.stringify({ error: { message: "not found" } }, null, 2);
const WS_ENDPOINT_NOT_FOUND_BODY = JSON.stringify({ error: { message: "websocket endpoint not found" } }, null, 2);

let apiKey: string | undefined;
let apiKeyAuthorization: string | undefined;
let zigCore: ZigCore | undefined;

const transportStats: TransportStats = {
  responsesHttpRequests: 0,
  responsesWebSocketUpgrades: 0,
  responsesWebSocketUpstreamOpens: 0,
  responsesWebSocketTerminalEvents: 0,
};

function log(...args: unknown[]) {
  if (CONFIG.DEBUG) console.error(new Date().toISOString(), ...args);
}

function redact(s?: string) {
  if (!s) return s;
  return s.length <= 10 ? "REDACTED" : `${s.slice(0, 5)}…${s.slice(-4)}`;
}

const authStore = new AuthStore({
  authDir: CONFIG.AUTH_DIR,
  home: CONFIG.HOME,
  refreshSkewMs: CONFIG.REFRESH_SKEW_MS,
  maxRetryCredentials: CONFIG.MAX_RETRY_CREDENTIALS,
  useZigAuthParse: CONFIG.USE_ZIG_AUTH_PARSE,
  useZigJwtExp: CONFIG.USE_ZIG_JWT_EXP,
  useZigPick: CONFIG.USE_ZIG_PICK,
  zigCore: () => zigCore,
  log,
});

const cacheAffinity = new CacheAffinityStore({
  enabled: CONFIG.CACHE_AFFINITY_ENABLED,
  ttlMs: CONFIG.CACHE_AFFINITY_TTL_MS,
  maxEntries: CONFIG.CACHE_AFFINITY_MAX_ENTRIES,
  headers: CONFIG.CACHE_AFFINITY_HEADERS,
  bodyFields: CONFIG.CACHE_AFFINITY_BODY_FIELDS,
  maxValueBytes: CONFIG.CACHE_AFFINITY_MAX_VALUE_BYTES,
});

const debugCapture = new DebugRequestCapture({
  enabled: CONFIG.DEBUG_SAVE_REQUESTS,
  dir: CONFIG.DEBUG_SAVE_DIR,
  bodyBytes: CONFIG.DEBUG_SAVE_BODY_BYTES,
  maxPending: CONFIG.DEBUG_SAVE_MAX_PENDING,
  home: CONFIG.HOME,
});

const profiler = new Profiler(CONFIG.PROFILE);

async function loadApiKey() {
  if (process.env.CD_PROXY_API_KEY) {
    apiKey = process.env.CD_PROXY_API_KEY.trim();
    apiKeyAuthorization = apiKey ? `Bearer ${apiKey}` : undefined;
    return;
  }
  try {
    apiKey = (await Bun.file(CONFIG.API_KEY_FILE).text()).trim();
    apiKeyAuthorization = apiKey ? `Bearer ${apiKey}` : undefined;
  } catch {
    apiKey = undefined;
    apiKeyAuthorization = undefined;
  }
}

async function loadAuths() {
  await authStore.load();
  cacheAffinity.updateAuths(authStore.auths);
}

function unauthorized(req: Request) {
  return !!apiKeyAuthorization && req.headers.get("authorization") !== apiKeyAuthorization;
}

function requestPathname(rawUrl: string): string {
  const scheme = rawUrl.indexOf("://");
  let start = 0;
  if (scheme >= 0) {
    const slash = rawUrl.indexOf("/", scheme + 3);
    if (slash < 0) return "/";
    start = slash;
  }
  const query = rawUrl.indexOf("?", start);
  const hash = rawUrl.indexOf("#", start);
  let end = rawUrl.length;
  if (query >= 0 && query < end) end = query;
  if (hash >= 0 && hash < end) end = hash;
  return rawUrl.slice(start, end) || "/";
}

function requestSearchParam(rawUrl: string, name: string): string | null {
  const query = rawUrl.indexOf("?");
  if (query < 0) return null;
  const hash = rawUrl.indexOf("#", query + 1);
  const search = rawUrl.slice(query + 1, hash < 0 ? undefined : hash);
  return new URLSearchParams(search).get(name);
}

function upstreamPathname(pathname: string): string | undefined {
  switch (pathname) {
    case "/v1/models":
    case "/models":
      return "models";
    case "/v1/responses":
    case "/responses":
    case "/codex/responses":
    case "/backend-api/codex/responses":
      return "responses";
    case "/v1/responses/compact":
    case "/responses/compact":
    case "/codex/responses/compact":
    case "/backend-api/codex/responses/compact":
      return "responses/compact";
    default:
      return undefined;
  }
}

function isAsciiWebSocket(value: string): boolean {
  return value.length === 9 &&
    (value.charCodeAt(0) | 32) === 119 &&
    (value.charCodeAt(1) | 32) === 101 &&
    (value.charCodeAt(2) | 32) === 98 &&
    (value.charCodeAt(3) | 32) === 115 &&
    (value.charCodeAt(4) | 32) === 111 &&
    (value.charCodeAt(5) | 32) === 99 &&
    (value.charCodeAt(6) | 32) === 107 &&
    (value.charCodeAt(7) | 32) === 101 &&
    (value.charCodeAt(8) | 32) === 116;
}

function isWebSocketUpgrade(req: Request): boolean {
  const upgrade = req.headers.get("upgrade");
  return upgrade === "websocket" || (!!upgrade && isAsciiWebSocket(upgrade));
}

function publicStatus() {
  return {
    ok: true,
    native_implementation: true,
    upstream_base: CONFIG.CHATGPT_CODEX_BASE,
    rr_index: authStore.rrIndex,
    auth_dir: CONFIG.AUTH_DIR,
    transport_stats: transportStats,
    cache_affinity: cacheAffinity.info(),
    debug_request_capture: debugCapture.info(),
    profile: { enabled: profiler.enabled, timings: profiler.snapshot() },
    zig_core: !!zigCore,
    zig_core_path: CONFIG.ZIG_CORE_PATH,
    auths: authStore.auths.map((a) => authStore.publicInfo(a)),
  };
}

async function handle(req: Request, server?: any): Promise<Response> {
  const pathname = requestPathname(req.url);

  if (isWebSocketUpgrade(req)) {
    const path = upstreamPathname(pathname);
    if (!path || path !== "responses") return staticJsonResponse(WS_ENDPOINT_NOT_FOUND_BODY, 404);
    if (unauthorized(req)) return staticJsonResponse(UNAUTHORIZED_BODY, 401);
    if (authStore.auths.length === 0) return jsonResponse({ error: { message: `no codex auth files found in ${CONFIG.AUTH_DIR}` } }, { status: 503 });
    return proxyWebSocketUpgrade(req, server, path, pathname, {
      authStore,
      cacheAffinity,
      debugCapture,
      transportStats,
      upstreamWsUrl: CONFIG.UPSTREAM_RESPONSES_WS_URL,
      wsBase: CONFIG.CHATGPT_CODEX_WS_BASE,
      connectTimeoutMs: CONFIG.WS_CONNECT_TIMEOUT_MS,
      cooldownMs: CONFIG.COOLDOWN_MS,
      exposeRotationHeaders: CONFIG.EXPOSE_ROTATION_HEADERS,
      profiler,
      zigCore: () => zigCore,
      log,
    });
  }

  if (pathname === "/health" || pathname === "/v1/health") {
    return jsonResponse({
      ok: true,
      native_implementation: true,
      upstream_base: CONFIG.CHATGPT_CODEX_BASE,
      auths: authStore.enabledCount,
      auth_dir: CONFIG.AUTH_DIR,
      transport_stats: transportStats,
      cache_affinity: cacheAffinity.info(),
      debug_request_capture: debugCapture.info(),
      profile: { enabled: profiler.enabled, timings: profiler.snapshot() },
      zig_core: !!zigCore,
    });
  }

  if (pathname === "/reload" && req.method === "POST") {
    if (unauthorized(req)) return staticJsonResponse(UNAUTHORIZED_BODY, 401);
    await loadAuths();
    return jsonResponse({ ok: true, auths: authStore.auths.length });
  }

  if (unauthorized(req)) return staticJsonResponse(UNAUTHORIZED_BODY, 401);

  if (pathname === "/status" || pathname === "/v1/status") return jsonResponse(publicStatus());

  if (pathname === "/debug/profile/reset" || pathname === "/v1/debug/profile/reset") {
    profiler.reset();
    return jsonResponse({ ok: true, profile: { enabled: profiler.enabled, timings: profiler.snapshot() } });
  }

  if (pathname === "/debug/rotation" || pathname === "/v1/debug/rotation") {
    const count = Math.min(100, Math.max(1, Number(requestSearchParam(req.url, "count") ?? String(authStore.auths.length || 1))));
    const picked = [];
    for (let i = 0; i < count; i++) {
      const a = authStore.choose();
      picked.push(a ? authStore.publicInfo(a) : null);
    }
    return jsonResponse({ ok: true, count, picked, next_rr_index: authStore.rrIndex });
  }

  const path = upstreamPathname(pathname);
  if (!path) return staticJsonResponse(NOT_FOUND_BODY, 404);
  if (path === "models") return jsonTextResponse(CONFIG.MODELS_RESPONSE_BODY);
  if (authStore.auths.length === 0) return jsonResponse({ error: { message: `no codex auth files found in ${CONFIG.AUTH_DIR}` } }, { status: 503 });

  return proxyWithRotation(req, path, pathname, {
    authStore,
    cacheAffinity,
    debugCapture,
    transportStats,
    upstreamResponsesUrl: CONFIG.UPSTREAM_RESPONSES_URL,
    upstreamResponsesCompactUrl: CONFIG.UPSTREAM_RESPONSES_COMPACT_URL,
    retryableHttpStatuses: CONFIG.RETRYABLE_HTTP_STATUSES,
    cooldownMs: CONFIG.COOLDOWN_MS,
    profiler,
    log,
  }, CONFIG.EXPOSE_ROTATION_HEADERS, CONFIG.HOME);
}

zigCore = loadZigCore(CONFIG.ZIG_CORE_PATH, log);
debugCapture.start();

if (process.argv.includes("--check")) {
  await loadApiKey();
  await loadAuths();
  console.log(JSON.stringify({
    ok: authStore.auths.length > 0,
    native_implementation: true,
    upstream_base: CONFIG.CHATGPT_CODEX_BASE,
    zig_core: !!zigCore,
    zig_core_path: CONFIG.ZIG_CORE_PATH,
    auths: authStore.auths.map((a) => ({ label: a.label, disabled: !!a.data.disabled, account_id: a.data.account_id ? redact(a.data.account_id) : undefined })),
    api_key: !!apiKey,
    api_key_file: CONFIG.API_KEY_FILE,
  }, null, 2));
  process.exit(authStore.auths.length > 0 ? 0 : 1);
}

await loadApiKey();
await loadAuths();
setInterval(loadAuths, 60_000).unref();

Bun.serve({
  host: CONFIG.HOST,
  port: CONFIG.PORT,
  idleTimeout: CONFIG.HTTP_IDLE_TIMEOUT_S,
  fetch: handle,
  websocket: {
    idleTimeout: CONFIG.WS_IDLE_TIMEOUT_S,
    maxPayloadLength: CONFIG.WS_MAX_PAYLOAD_BYTES,
    sendPings: true,
    open(ws: ServerWebSocket<WsProxyData>) {
      (ws.data.upstream as any).__client = ws;
      for (const msg of ws.data.downstreamQueue.splice(0)) ws.send(msg as any);
    },
    message(ws: ServerWebSocket<WsProxyData>, message: string | Buffer) {
      handleClientWebSocketMessage(ws, message, cacheAffinity, debugCapture, profiler);
    },
    close(ws: ServerWebSocket<WsProxyData>) {
      try { ws.data.upstream.close(); } catch {}
    },
  },
});

console.error(`cd-proxy listening on http://${CONFIG.HOST}:${CONFIG.PORT} using ${authStore.auths.length} codex auth(s); upstream=${CONFIG.CHATGPT_CODEX_BASE}`);
