import { join } from "node:path";
import { suffix } from "bun:ffi";

const DEFAULT_CHATGPT_CODEX_BASE = "https://chatgpt.com/backend-api/codex";
const BLOCKED_LOCAL_PROXY_PORT = "8317"; // NATIVE_ASSERT_ALLOW: refused retired local proxy port only.

export function expandHome(p: string): string {
  const home = process.env.HOME ?? ".";
  return p === "~" ? home : p.startsWith("~/") ? home + p.slice(1) : p;
}

export function envFlag(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  switch (raw.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return defaultValue;
  }
}

export function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? String(fallback));
  return Number.isFinite(n) ? n : fallback;
}

function assertNativeUpstreamBase(base: string) {
  const parsed = new URL(base);
  const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (localHosts.has(parsed.hostname) && parsed.port === BLOCKED_LOCAL_PROXY_PORT) {
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

const CHATGPT_CODEX_BASE = (process.env.CD_PROXY_UPSTREAM_BASE ?? DEFAULT_CHATGPT_CODEX_BASE).replace(/\/+$/, "");
assertNativeUpstreamBase(CHATGPT_CODEX_BASE);

const MODEL_IDS = (process.env.CD_PROXY_MODELS ?? "gpt-5.3-codex,gpt-5.3-codex-spark,codex-auto-review,gpt-5.5,gpt-5.2")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const CHATGPT_CODEX_WS_BASE = CHATGPT_CODEX_BASE.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");

export const CONFIG = {
  DEFAULT_CHATGPT_CODEX_BASE,
  CHATGPT_CODEX_BASE,
  CHATGPT_CODEX_WS_BASE,
  UPSTREAM_RESPONSES_URL: `${CHATGPT_CODEX_BASE}/responses`,
  UPSTREAM_RESPONSES_COMPACT_URL: `${CHATGPT_CODEX_BASE}/responses/compact`,
  UPSTREAM_RESPONSES_WS_URL: `${CHATGPT_CODEX_WS_BASE}/responses`,
  HOME: process.env.HOME ?? ".",
  AUTH_DIR: expandHome(process.env.CD_PROXY_AUTH_DIR ?? "~/.local/share/cd-proxy/auths"),
  API_KEY_FILE: expandHome(process.env.CD_PROXY_API_KEY_FILE ?? "~/.config/cd-proxy/api-key"),
  PORT: Number(process.env.CD_PROXY_PORT ?? "8318"),
  HOST: process.env.CD_PROXY_HOST ?? "127.0.0.1",
  DEBUG: envFlag("CD_PROXY_DEBUG"),
  DEBUG_SAVE_REQUESTS: envFlag("CD_PROXY_DEBUG_SAVE_REQUESTS"),
  DEBUG_SAVE_DIR: expandHome(process.env.CD_PROXY_DEBUG_SAVE_DIR ?? "~/.local/share/cd-proxy/debug-requests"),
  DEBUG_SAVE_BODY_BYTES: Math.max(0, Math.floor(envNumber("CD_PROXY_DEBUG_SAVE_BODY_BYTES", 1024 * 1024))),
  DEBUG_SAVE_MAX_PENDING: Math.max(0, Math.floor(envNumber("CD_PROXY_DEBUG_SAVE_MAX_PENDING", 1024))),
  EXPOSE_ROTATION_HEADERS: envFlag("CD_PROXY_EXPOSE_ROTATION_HEADERS"),
  USE_ZIG_AUTH_PARSE: envFlag("CD_PROXY_ZIG_AUTH_PARSE"),
  USE_ZIG_JWT_EXP: envFlag("CD_PROXY_ZIG_JWT_EXP"),
  USE_ZIG_PICK: envFlag("CD_PROXY_ZIG_PICK"),
  CACHE_AFFINITY_ENABLED: envFlag("CD_PROXY_CACHE_AFFINITY", true),
  CACHE_AFFINITY_TTL_MS: envNumber("CD_PROXY_CACHE_AFFINITY_TTL_MS", 30 * 60_000),
  CACHE_AFFINITY_MAX_ENTRIES: envNumber("CD_PROXY_CACHE_AFFINITY_MAX_ENTRIES", 10000),
  CACHE_AFFINITY_HEADERS: (process.env.CD_PROXY_CACHE_AFFINITY_HEADERS ?? "session_id,x-session-affinity")
    .split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean),
  CACHE_AFFINITY_BODY_FIELDS: (process.env.CD_PROXY_CACHE_AFFINITY_BODY_FIELDS ?? "prompt_cache_key,session_id")
    .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
  CACHE_AFFINITY_MAX_VALUE_BYTES: Math.max(1, Math.floor(envNumber("CD_PROXY_CACHE_AFFINITY_MAX_VALUE_BYTES", 512))),
  MAX_RETRY_CREDENTIALS: Number(process.env.CD_PROXY_MAX_RETRY_CREDENTIALS ?? "0"),
  COOLDOWN_MS: Number(process.env.CD_PROXY_COOLDOWN_MS ?? "30000"),
  REFRESH_SKEW_MS: Number(process.env.CD_PROXY_REFRESH_SKEW_MS ?? String(5 * 60_000)),
  WS_CONNECT_TIMEOUT_MS: Number(process.env.CD_PROXY_WS_CONNECT_TIMEOUT_MS ?? "30000"),
  HTTP_IDLE_TIMEOUT_S: Math.max(0, Math.min(255, Number(process.env.CD_PROXY_HTTP_IDLE_TIMEOUT_S ?? "240"))),
  WS_IDLE_TIMEOUT_S: Math.max(0, Math.min(960, Number(process.env.CD_PROXY_WS_IDLE_TIMEOUT_S ?? "600"))),
  WS_MAX_PAYLOAD_BYTES: Number(process.env.CD_PROXY_WS_MAX_PAYLOAD_BYTES ?? String(64 * 1024 * 1024)),
  RETRYABLE_HTTP_STATUSES: parseRetryableHttpStatuses(process.env.CD_PROXY_RETRYABLE_HTTP_STATUSES),
  MODEL_IDS,
  MODELS_RESPONSE_BODY: JSON.stringify({
    object: "list",
    data: MODEL_IDS.map((id) => ({ id, object: "model", created: 1770307200, owned_by: "openai" })),
  }, null, 2),
  ZIG_CORE_PATH: expandHome(process.env.CD_PROXY_ZIG_CORE ?? join(process.cwd(), "zig-out", "lib", `libcd_proxy_core.${suffix}`)),
} as const;
