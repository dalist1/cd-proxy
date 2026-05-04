import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dlopen, FFIType, ptr, suffix } from "bun:ffi";
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
const USE_ZIG_AUTH_PARSE = process.env.CD_PROXY_ZIG_AUTH_PARSE === "1" || process.env.CD_PROXY_ZIG_AUTH_PARSE === "true";
const USE_ZIG_JWT_EXP = process.env.CD_PROXY_ZIG_JWT_EXP === "1" || process.env.CD_PROXY_ZIG_JWT_EXP === "true";
const USE_ZIG_PICK = process.env.CD_PROXY_ZIG_PICK === "1" || process.env.CD_PROXY_ZIG_PICK === "true";
const MAX_RETRY_CREDENTIALS = Number(process.env.CD_PROXY_MAX_RETRY_CREDENTIALS ?? "0");
const COOLDOWN_MS = Number(process.env.CD_PROXY_COOLDOWN_MS ?? "30000");
const REFRESH_SKEW_MS = Number(process.env.CD_PROXY_REFRESH_SKEW_MS ?? String(5 * 60_000));
const WS_CONNECT_TIMEOUT_MS = Number(process.env.CD_PROXY_WS_CONNECT_TIMEOUT_MS ?? "10000");
const RETRYABLE_HTTP_STATUSES = parseRetryableHttpStatuses(process.env.CD_PROXY_RETRYABLE_HTTP_STATUSES);
const MODEL_IDS = (process.env.CD_PROXY_MODELS ?? "gpt-5.3-codex,gpt-5.3-codex-spark,codex-auto-review,gpt-5.5,gpt-5.2")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MODELS_RESPONSE_BODY = JSON.stringify({
  object: "list",
  data: MODEL_IDS.map((id) => ({ id, object: "model", created: 1770307200, owned_by: "openai" })),
}, null, 2);
const CHATGPT_CODEX_WS_BASE = CHATGPT_CODEX_BASE.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
const UPSTREAM_RESPONSES_URL = `${CHATGPT_CODEX_BASE}/responses`;
const UPSTREAM_RESPONSES_COMPACT_URL = `${CHATGPT_CODEX_BASE}/responses/compact`;
const UPSTREAM_RESPONSES_WS_URL = `${CHATGPT_CODEX_WS_BASE}/responses`;
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
  expiresAtMs?: number;
  coolingUntil: number;
  refreshInFlight?: Promise<void>;
}

interface WsProxyData {
  upstream: WebSocket;
  upstreamOpen: boolean;
  queue: Array<string | ArrayBuffer | Uint8Array>;
  downstreamQueue: Array<string | ArrayBuffer | Uint8Array>;
  authLabel: string;
}

let auths: AuthEntry[] = [];
let enabledAuthCount = 0;
let rr = 0;
let apiKey: string | undefined;
let apiKeyAuthorization: string | undefined;
const transportStats = {
  responsesHttpRequests: 0,
  responsesWebSocketUpgrades: 0,
  responsesWebSocketUpstreamOpens: 0,
  responsesWebSocketTerminalEvents: 0,
};
let zigCore: undefined | {
  cdproxy_pick_next_u32(len: number, start: number, unavailableMask: number): number;
  cdproxy_mask_bit_u32(idx: number): number;
  cdproxy_pick_next_flags(len: number, start: number, unavailableFlags: number): number;
  cdproxy_parse_auth_json(data: number, len: number, out: number): boolean;
  cdproxy_is_terminal_response_event(data: number, len: number): boolean;
  cdproxy_jwt_exp_ms(data: number, len: number): number;
};
let unavailableFlags = new Uint8Array(0);
const ZIG_PICK_THRESHOLD = 512;

const AUTH_JSON_VIEW_BYTES = 136;
const AUTH_TYPE_OFFSET = 0;
const AUTH_EMAIL_OFFSET = 16;
const AUTH_ACCOUNT_ID_OFFSET = 32;
const AUTH_ACCESS_TOKEN_OFFSET = 48;
const AUTH_REFRESH_TOKEN_OFFSET = 64;
const AUTH_ID_TOKEN_OFFSET = 80;
const AUTH_EXPIRED_OFFSET = 96;
const AUTH_LAST_REFRESH_OFFSET = 112;
const AUTH_DISABLED_OFFSET = 128;
const authJsonViewScratch = Buffer.alloc(AUTH_JSON_VIEW_BYTES);
const JSON_HEADERS = { "content-type": "application/json" } as const;
const UNAUTHORIZED_BODY = JSON.stringify({ error: { message: "unauthorized" } }, null, 2);
const NOT_FOUND_BODY = JSON.stringify({ error: { message: "not found" } }, null, 2);
const WS_ENDPOINT_NOT_FOUND_BODY = JSON.stringify({ error: { message: "websocket endpoint not found" } }, null, 2);
const WS_UPGRADE_FAILED_BODY = JSON.stringify({ error: { message: "websocket upgrade failed" } }, null, 2);

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

function parseRetryableHttpStatuses(raw: string | undefined): Set<number> {
  const defaults = [401, 403, 408, 409, 425, 429, 500, 502, 503, 504];
  const values = (raw ?? defaults.join(","))
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 400 && n <= 599);
  return new Set(values.length ? values : defaults);
}

function maxCredentialAttempts(): number {
  if (!Number.isFinite(MAX_RETRY_CREDENTIALS) || MAX_RETRY_CREDENTIALS <= 0) return Math.max(1, auths.length);
  return Math.min(Math.floor(MAX_RETRY_CREDENTIALS), Math.max(1, auths.length));
}

function isRetryableHttpStatus(status: number): boolean {
  return status >= 400 && RETRYABLE_HTTP_STATUSES.has(status);
}

function cooldownMsForFailure(status: number): number {
  if (status === 401 || status === 403 || status === 429) return COOLDOWN_MS;
  return Math.min(COOLDOWN_MS, 5000);
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
      cdproxy_pick_next_flags: { args: [FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
      cdproxy_parse_auth_json: { args: [FFIType.ptr, FFIType.usize, FFIType.ptr], returns: FFIType.bool },
      cdproxy_is_terminal_response_event: { args: [FFIType.ptr, FFIType.usize], returns: FFIType.bool },
      cdproxy_jwt_exp_ms: { args: [FFIType.ptr, FFIType.usize], returns: FFIType.f64 },
    });
    zigCore = lib.symbols as unknown as typeof zigCore;
    log(`loaded Zig core: ${ZIG_CORE_PATH}`);
  } catch (err) {
    console.error(`warning: failed to load Zig core at ${ZIG_CORE_PATH}; using JS fallback: ${err}`);
  }
}

async function loadApiKey() {
  if (process.env.CD_PROXY_API_KEY) {
    apiKey = process.env.CD_PROXY_API_KEY.trim();
    apiKeyAuthorization = apiKey ? `Bearer ${apiKey}` : undefined;
    return;
  }
  try {
    apiKey = (await readFile(API_KEY_FILE, "utf8")).trim();
    apiKeyAuthorization = apiKey ? `Bearer ${apiKey}` : undefined;
  } catch {
    apiKey = undefined;
    apiKeyAuthorization = undefined;
  }
}

function authJsonViewString(raw: Buffer, out: Buffer, offset: number): string | undefined {
  const start = Number(out.readBigUInt64LE(offset));
  const len = Number(out.readBigUInt64LE(offset + 8));
  if (start === 0 && len === 0) return undefined;
  return raw.toString("utf8", start, start + len);
}

function parseCodexAuthJson(raw: Buffer): CodexAuthFile {
  // Bun's JSON.parse is faster on the current small auth files. Keep the Zig
  // parser as an opt-in for benchmarking or unusually large auth records.
  if (USE_ZIG_AUTH_PARSE && zigCore?.cdproxy_parse_auth_json) {
    const out = authJsonViewScratch;
    const rawPtr = ptr(raw);
    const outPtr = ptr(out);
    if (rawPtr && outPtr && zigCore.cdproxy_parse_auth_json(rawPtr as any, raw.byteLength, outPtr as any)) {
      return {
        type: authJsonViewString(raw, out, AUTH_TYPE_OFFSET),
        email: authJsonViewString(raw, out, AUTH_EMAIL_OFFSET),
        account_id: authJsonViewString(raw, out, AUTH_ACCOUNT_ID_OFFSET),
        access_token: authJsonViewString(raw, out, AUTH_ACCESS_TOKEN_OFFSET) ?? "",
        refresh_token: authJsonViewString(raw, out, AUTH_REFRESH_TOKEN_OFFSET) ?? "",
        id_token: authJsonViewString(raw, out, AUTH_ID_TOKEN_OFFSET),
        expired: authJsonViewString(raw, out, AUTH_EXPIRED_OFFSET),
        last_refresh: authJsonViewString(raw, out, AUTH_LAST_REFRESH_OFFSET),
        disabled: out[AUTH_DISABLED_OFFSET] === 1,
      };
    }
  }
  return JSON.parse(raw.toString("utf8")) as CodexAuthFile;
}

async function loadAuths() {
  const next: AuthEntry[] = [];
  const names = (await readdir(AUTH_DIR).catch(() => []))
    .filter((name) => name.startsWith("codex-") && name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const path = join(AUTH_DIR, name);
    try {
      const data = parseCodexAuthJson(await readFile(path));
      if (data.type && data.type !== "codex") continue;
      if (!data.access_token || !data.refresh_token) continue;
      const old = auths.find((a) => a.path === path);
      next.push({
        path,
        label: data.email ?? name.replace(/^codex-/, "").replace(/\.json$/, ""),
        data,
        expiresAtMs: computeExpiryMs(data),
        coolingUntil: old?.coolingUntil ?? 0,
        refreshInFlight: old?.refreshInFlight,
      });
    } catch (err) {
      console.error(`failed to load ${path}:`, err);
    }
  }

  auths = next;
  enabledAuthCount = auths.reduce((count, a) => count + (a.data.disabled ? 0 : 1), 0);
  if (rr >= auths.length) rr = 0;
  log(`loaded ${auths.length} codex auth(s) from ${AUTH_DIR}`);
}

function computeExpiryMs(data: CodexAuthFile): number | undefined {
  if (data.expired) {
    const t = Date.parse(data.expired);
    if (!Number.isNaN(t)) return t;
  }
  if (data.id_token) return jwtExpMs(data.id_token);
  return undefined;
}

function isTokenExpiring(a: AuthEntry): boolean {
  return a.expiresAtMs !== undefined && Date.now() + REFRESH_SKEW_MS >= a.expiresAtMs;
}

function jwtExpMs(jwt: string): number | undefined {
  if (USE_ZIG_JWT_EXP && zigCore?.cdproxy_jwt_exp_ms) {
    const bytes = Buffer.from(jwt);
    const p = ptr(bytes);
    if (p) {
      const exp = zigCore.cdproxy_jwt_exp_ms(p as any, bytes.byteLength);
      if (Number.isFinite(exp) && exp > 0) return exp;
    }
  }

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
    a.expiresAtMs = computeExpiryMs(a.data);
    const claims = decodeJwtClaims(a.data.id_token);
    a.data.email ??= claims?.email ?? claims?.["https://api.openai.com/profile"]?.email;
    a.data.account_id ??= claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    await persistAuth(a);
  })().finally(() => { a.refreshInFlight = undefined; });
  return a.refreshInFlight;
}

function isExcluded(exclude: AuthEntry[] | undefined, a: AuthEntry): boolean {
  return !!exclude && exclude.includes(a);
}

function chooseAuth(exclude?: AuthEntry[]): AuthEntry | undefined {
  const now = Date.now();
  if (auths.length === 0) return undefined;

  // Bun's JIT beats an FFI call for normal credential pools. Keep the Zig
  // picker opt-in only; benchmarks decide if a deployment's auth pool benefits.
  if (USE_ZIG_PICK && zigCore && auths.length >= ZIG_PICK_THRESHOLD) {
    if (unavailableFlags.length < auths.length) unavailableFlags = new Uint8Array(auths.length);
    for (let i = 0; i < auths.length; i++) {
      const a = auths[i];
      unavailableFlags[i] = isExcluded(exclude, a) || a.data.disabled || a.coolingUntil > now ? 1 : 0;
    }
    const flagsPtr = ptr(unavailableFlags);
    if (flagsPtr) {
      const idx = zigCore.cdproxy_pick_next_flags(auths.length, rr % auths.length, flagsPtr as any);
      if (idx >= 0) {
        rr = idx + 1;
        return auths[idx];
      }
      rr += auths.length;
      return undefined;
    }
  }

  for (let i = 0; i < auths.length; i++) {
    const idx = rr++ % auths.length;
    const a = auths[idx];
    if (isExcluded(exclude, a) || a.data.disabled || a.coolingUntil > now) continue;
    return a;
  }
  return undefined;
}

async function ensureFresh(a: AuthEntry) {
  if (isTokenExpiring(a)) await refreshAuth(a);
}

function unauthorized(req: Request) {
  return !!apiKeyAuthorization && req.headers.get("authorization") !== apiKeyAuthorization;
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
  return jsonTextResponse(JSON.stringify(value, null, 2), init);
}

function jsonTextResponse(body: string, init?: ResponseInit) {
  if (!init) return new Response(body, { headers: JSON_HEADERS });
  return new Response(body, { ...init, headers: { ...JSON_HEADERS, ...(init.headers ?? {}) } });
}

function staticJsonResponse(body: string, status: number) {
  return new Response(body, { status, headers: JSON_HEADERS });
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

function buildWebSocketHeaders(req: Request, a: AuthEntry): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [name, value] of req.headers) {
    switch (name) {
      case "host":
      case "connection":
      case "upgrade":
      case "content-length":
      case "sec-websocket-key":
      case "sec-websocket-version":
      case "sec-websocket-extensions":
      case "sec-websocket-protocol":
        continue;
      default:
        h[name] = value;
    }
  }
  h.authorization = `Bearer ${a.data.access_token}`;
  if (a.data.account_id) h["ChatGPT-Account-ID"] = a.data.account_id;
  return h;
}

function upstreamHttpUrlForPath(path: string): string {
  return path === "responses/compact" ? UPSTREAM_RESPONSES_COMPACT_URL : UPSTREAM_RESPONSES_URL;
}

function websocketUrlForPath(path: string): string {
  return path === "responses" ? UPSTREAM_RESPONSES_WS_URL : `${CHATGPT_CODEX_WS_BASE}/${path}`;
}

function isAsciiWebSocket(value: string): boolean {
  return value.length === 9 &&
    (value.charCodeAt(0) | 32) === 119 && // w
    (value.charCodeAt(1) | 32) === 101 && // e
    (value.charCodeAt(2) | 32) === 98 &&  // b
    (value.charCodeAt(3) | 32) === 115 && // s
    (value.charCodeAt(4) | 32) === 111 && // o
    (value.charCodeAt(5) | 32) === 99 &&  // c
    (value.charCodeAt(6) | 32) === 107 && // k
    (value.charCodeAt(7) | 32) === 101 && // e
    (value.charCodeAt(8) | 32) === 116;   // t
}

function isWebSocketUpgrade(req: Request): boolean {
  const upgrade = req.headers.get("upgrade");
  return upgrade === "websocket" || (!!upgrade && isAsciiWebSocket(upgrade));
}

function payloadBytes(payload: unknown): Buffer | Uint8Array | undefined {
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  return undefined;
}

const COMPACT_ROOT_TYPE_PREFIX = '{"type":"';

function compactTerminalTypeText(text: string): boolean | undefined {
  // In OpenAI/Codex frames the root `type` field is first: {"type":"..."}.
  // Only take the sentinel fast path there; otherwise fall back for correctness.
  if (text.startsWith('{"type":"response.completed"') ||
    text.startsWith('{"type":"response.done"') ||
    text.startsWith('{"type":"response.incomplete"')) return true;
  if (text.startsWith(COMPACT_ROOT_TYPE_PREFIX)) return false;
  return undefined;
}

function maybeContainsTerminalTypeText(text: string): boolean {
  return text.includes("response.completed") ||
    text.includes("response.done") ||
    text.includes("response.incomplete");
}

function isTerminalResponseEventText(text: string): boolean {
  // OpenAI/Codex Responses WebSocket frames are compact JSON in practice.
  // Avoid Buffer allocation + FFI + JSON.parse for the common string path.
  const compact = compactTerminalTypeText(text);
  if (compact !== undefined) return compact;
  if (!maybeContainsTerminalTypeText(text)) return false;

  try {
    const parsed = JSON.parse(text);
    return parsed?.type === "response.completed" || parsed?.type === "response.done" || parsed?.type === "response.incomplete";
  } catch {
    return false;
  }
}

function isTerminalResponseEventPayload(payload: unknown): boolean {
  if (typeof payload === "string") return isTerminalResponseEventText(payload);

  if (zigCore?.cdproxy_is_terminal_response_event) {
    const bytes = payloadBytes(payload);
    if (bytes) {
      const p = ptr(bytes);
      if (p) return !!zigCore.cdproxy_is_terminal_response_event(p as any, bytes.byteLength);
    }
  }

  let text: string | undefined;
  if (payload instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(payload));
  else if (ArrayBuffer.isView(payload)) text = new TextDecoder().decode(payload as Uint8Array);
  if (!text) return false;
  return isTerminalResponseEventText(text);
}

async function connectUpstreamWebSocket(req: Request, a: AuthEntry, path: string, pathname: string): Promise<{ ok: true; data: WsProxyData } | { ok: false; status: number; detail: string }> {
  const upstreamUrl = websocketUrlForPath(path);
  const upstreamHeaders = buildWebSocketHeaders(req, a);
  let upstream: WebSocket;
  try {
    upstream = new WebSocket(upstreamUrl, { headers: upstreamHeaders });
  } catch (err) {
    return { ok: false, status: 502, detail: String(err) };
  }

  const data: WsProxyData = { upstream, upstreamOpen: false, queue: [], downstreamQueue: [], authLabel: a.label };
  const opened = await new Promise<{ ok: true } | { ok: false; status: number; detail: string }>((resolve) => {
    let settled = false;
    const finish = (result: { ok: true } | { ok: false; status: number; detail: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { upstream.close(); } catch {}
      finish({ ok: false, status: 504, detail: `upstream websocket did not open within ${WS_CONNECT_TIMEOUT_MS}ms` });
    }, Math.max(1, WS_CONNECT_TIMEOUT_MS));

    upstream.addEventListener("open", () => {
      transportStats.responsesWebSocketUpstreamOpens++;
      data.upstreamOpen = true;
      log(`WS ${pathname} -> ${upstreamUrl} as ${a.label}`);
      for (const msg of data.queue.splice(0)) upstream.send(msg as any);
      finish({ ok: true });
    });
    upstream.addEventListener("message", async (event: MessageEvent) => {
      const payload = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
      const client = (upstream as any).__client;
      if (client) client.send(payload as any);
      else data.downstreamQueue.push(payload as any);
      if (isTerminalResponseEventPayload(payload)) transportStats.responsesWebSocketTerminalEvents++;
    });
    upstream.addEventListener("close", (event: CloseEvent) => {
      if (!data.upstreamOpen) {
        finish({ ok: false, status: 502, detail: `upstream websocket closed before open: ${event.code || 1006} ${event.reason || ""}`.trim() });
        return;
      }
      const client = (upstream as any).__client;
      try { client?.close(event.code || 1000, event.reason || undefined); } catch {}
    });
    upstream.addEventListener("error", () => {
      if (!data.upstreamOpen) {
        finish({ ok: false, status: 502, detail: "upstream websocket error before open" });
        return;
      }
      const client = (upstream as any).__client;
      try { client?.close(1011, "upstream websocket error"); } catch {}
    });
  });

  if (!opened.ok) {
    try { upstream.close(); } catch {}
    return opened;
  }
  return { ok: true, data };
}

async function proxyWebSocketUpgrade(req: Request, server: any, path: string, pathname: string): Promise<Response> {
  if (unauthorized(req)) return staticJsonResponse(UNAUTHORIZED_BODY, 401);
  if (auths.length === 0) return jsonResponse({ error: { message: `no codex auth files found in ${AUTH_DIR}` } }, { status: 503 });

  const tried: AuthEntry[] = [];
  let lastStatus = 0;
  let lastText = "";
  for (let attempt = 0; attempt < maxCredentialAttempts(); attempt++) {
    const a = chooseAuth(tried);
    if (!a) break;
    tried.push(a);

    try {
      await ensureFresh(a);
    } catch (err) {
      lastStatus = 401;
      lastText = String(err);
      a.coolingUntil = Date.now() + COOLDOWN_MS;
      log(`cooling ${a.label} after websocket refresh failure: ${lastText}`);
      continue;
    }

    const connected = await connectUpstreamWebSocket(req, a, path, pathname);
    if (!connected.ok) {
      lastStatus = connected.status;
      lastText = connected.detail;
      a.coolingUntil = Date.now() + cooldownMsForFailure(connected.status);
      log(`cooling ${a.label} after websocket connect failure: ${connected.detail}`);
      continue;
    }

    const ok = server.upgrade(req, {
      data: connected.data,
      headers: EXPOSE_ROTATION_HEADERS ? {
        "x-cd-proxy-auth-label": a.label,
        ...(a.data.account_id ? { "x-cd-proxy-auth-account-prefix": a.data.account_id.slice(0, 5) } : {}),
        "x-cd-proxy-attempt": String(attempt),
        "x-cd-proxy-next-rr-index": String(rr % Math.max(1, auths.length)),
      } : undefined,
    });
    if (!ok) {
      try { connected.data.upstream.close(); } catch {}
      return staticJsonResponse(WS_UPGRADE_FAILED_BODY, 400);
    }
    transportStats.responsesWebSocketUpgrades++;
    return undefined as any;
  }

  return jsonResponse({ error: { message: "all codex websocket credentials failed or are cooling down", status: lastStatus, detail: lastText.slice(0, 1000) } }, { status: lastStatus || 503 });
}

async function proxyWithRotation(req: Request, path: string, pathname: string): Promise<Response> {
  if (path === "responses" || path === "responses/compact") transportStats.responsesHttpRequests++;
  const tried: AuthEntry[] = [];
  let lastStatus = 0;
  let lastText = "";
  const requestBody = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const upstream = upstreamHttpUrlForPath(path);

  for (let attempt = 0; attempt < maxCredentialAttempts(); attempt++) {
    const a = chooseAuth(tried);
    if (!a) break;
    tried.push(a);
    try {
      await ensureFresh(a);
      log(`${req.method} ${pathname} -> ${upstream} as ${a.label}`);
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
          if (!isRetryableHttpStatus(retry.status)) return withRotationHeaders(retry, a, attempt);
          lastStatus = retry.status;
          lastText = await retry.text().catch(() => "");
        } catch (err) {
          lastText = String(err);
        }
        a.coolingUntil = Date.now() + COOLDOWN_MS;
        log(`cooling ${a.label} after 401/refresh retry failure: ${lastStatus} ${lastText.slice(0, 160)}`);
        continue;
      }

      if (isRetryableHttpStatus(res.status)) {
        lastStatus = res.status;
        lastText = await res.text().catch(() => "");
        a.coolingUntil = Date.now() + cooldownMsForFailure(res.status);
        log(`cooling ${a.label} after retryable upstream status ${res.status}: ${lastText.slice(0, 160)}`);
        continue;
      }

      return withRotationHeaders(res, a, attempt);
    } catch (err) {
      lastStatus = 502;
      lastText = String(err);
      a.coolingUntil = Date.now() + cooldownMsForFailure(502);
      log(`cooling ${a.label} after upstream fetch failure: ${lastText.slice(0, 160)}`);
    }
  }

  return jsonResponse({ error: { message: "all codex credentials failed or are cooling down", status: lastStatus, detail: lastText.slice(0, 1000) } }, { status: lastStatus || 503 });
}

async function handle(req: Request, server?: any): Promise<Response> {
  const pathname = requestPathname(req.url);
  if (isWebSocketUpgrade(req)) {
    const path = upstreamPathname(pathname);
    if (!path || path !== "responses") return staticJsonResponse(WS_ENDPOINT_NOT_FOUND_BODY, 404);
    return proxyWebSocketUpgrade(req, server, path, pathname);
  }
  if (pathname === "/health" || pathname === "/v1/health") {
    return jsonResponse({ ok: true, native_implementation: true, upstream_base: CHATGPT_CODEX_BASE, auths: enabledAuthCount, auth_dir: AUTH_DIR, transport_stats: transportStats, zig_core: !!zigCore });
  }
  if (pathname === "/reload" && req.method === "POST") {
    if (unauthorized(req)) return staticJsonResponse(UNAUTHORIZED_BODY, 401);
    await loadAuths();
    return jsonResponse({ ok: true, auths: auths.length });
  }
  if (unauthorized(req)) return staticJsonResponse(UNAUTHORIZED_BODY, 401);
  if (pathname === "/status" || pathname === "/v1/status") {
    return jsonResponse({ ok: true, native_implementation: true, upstream_base: CHATGPT_CODEX_BASE, rr_index: rr % Math.max(1, auths.length), auth_dir: AUTH_DIR, transport_stats: transportStats, zig_core: !!zigCore, zig_core_path: ZIG_CORE_PATH, auths: auths.map(publicAuthInfo) });
  }
  if (pathname === "/debug/rotation" || pathname === "/v1/debug/rotation") {
    const count = Math.min(100, Math.max(1, Number(requestSearchParam(req.url, "count") ?? String(auths.length || 1))));
    const picked = [];
    for (let i = 0; i < count; i++) {
      const a = chooseAuth();
      picked.push(a ? publicAuthInfo(a) : null);
    }
    return jsonResponse({ ok: true, count, picked, next_rr_index: rr % Math.max(1, auths.length) });
  }
  const path = upstreamPathname(pathname);
  if (!path) return staticJsonResponse(NOT_FOUND_BODY, 404);
  if (path === "models") return jsonTextResponse(MODELS_RESPONSE_BODY);
  if (auths.length === 0) return jsonResponse({ error: { message: `no codex auth files found in ${AUTH_DIR}` } }, { status: 503 });
  return proxyWithRotation(req, path, pathname);
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
      for (const msg of ws.data.downstreamQueue.splice(0)) ws.send(msg as any);
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
