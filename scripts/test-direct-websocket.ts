#!/usr/bin/env bun
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE ?? "https://auth.openai.com/oauth/token";
const HOME = process.env.HOME ?? ".";
const AUTH_DIR = expandHome(process.env.CD_PROXY_AUTH_DIR ?? "~/.local/share/cd-proxy/auths");
const UPSTREAM_BASE = (process.env.CD_PROXY_UPSTREAM_BASE ?? "https://chatgpt.com/backend-api/codex").replace(/\/+$/, "");
const WS_URL = websocketUrl(`${UPSTREAM_BASE}/responses`);
const REFRESH_SKEW_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = Number(process.env.CD_PROXY_DIRECT_WS_TIMEOUT_MS ?? "10000");
const TEST_ALL = process.argv.includes("--all");

type AuthFile = {
  type?: string;
  email?: string;
  account_id?: string;
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expired?: string;
  last_refresh?: string;
  disabled?: boolean;
};
type AuthEntry = { path: string; label: string; data: AuthFile };

function expandHome(p: string) { return p === "~" ? HOME : p.startsWith("~/") ? HOME + p.slice(1) : p; }
function redact(s?: string) { return s ? `${s.slice(0, 5)}…${s.slice(-4)}` : "none"; }
function websocketUrl(httpUrl: string) {
  const url = new URL(httpUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  return url.toString();
}
function jwtExpMs(jwt?: string): number | undefined {
  if (!jwt) return undefined;
  try {
    const payload = jwt.split(".")[1];
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof json.exp === "number" ? json.exp * 1000 : undefined;
  } catch { return undefined; }
}
function isExpiring(data: AuthFile) {
  if (data.expired) {
    const t = Date.parse(data.expired);
    if (!Number.isNaN(t)) return Date.now() + REFRESH_SKEW_MS >= t;
  }
  const exp = jwtExpMs(data.id_token);
  return !!exp && Date.now() + REFRESH_SKEW_MS >= exp;
}
async function loadAuths(): Promise<AuthEntry[]> {
  const names = (await readdir(AUTH_DIR))
    .filter((name) => name.startsWith("codex-") && name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));
  const out: AuthEntry[] = [];
  for (const name of names) {
    const path = join(AUTH_DIR, name);
    const data = JSON.parse(await readFile(path, "utf8")) as AuthFile;
    if (data.disabled || (data.type && data.type !== "codex") || !data.access_token || !data.refresh_token) continue;
    out.push({ path, label: data.email ?? name, data });
  }
  return out;
}
async function refreshIfNeeded(a: AuthEntry) {
  if (!isExpiring(a.data)) return false;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: a.data.refresh_token }),
  });
  if (!res.ok) throw new Error(`refresh failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  const json = await res.json() as { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number };
  if (json.access_token) a.data.access_token = json.access_token;
  if (json.refresh_token) a.data.refresh_token = json.refresh_token;
  if (json.id_token) a.data.id_token = json.id_token;
  const exp = jwtExpMs(json.id_token);
  if (exp) a.data.expired = new Date(exp).toISOString();
  else if (json.expires_in) a.data.expired = new Date(Date.now() + json.expires_in * 1000).toISOString();
  a.data.last_refresh = new Date().toISOString();
  await writeFile(a.path, JSON.stringify(a.data), { mode: 0o600 });
  return true;
}
async function installationId() {
  try { return (await readFile(expandHome("~/.codex/installation_id"), "utf8")).trim(); }
  catch { return randomUUID(); }
}
async function testOne(a: AuthEntry, index: number) {
  const refreshed = await refreshIfNeeded(a);
  const session = randomUUID();
  const install = await installationId();
  const headers: Record<string, string> = {
    authorization: `Bearer ${a.data.access_token}`,
    "openai-beta": "responses_websockets=2026-02-06",
    "x-client-request-id": session,
    session_id: session,
    "x-codex-window-id": randomUUID(),
    "x-codex-installation-id": install,
  };
  if (a.data.account_id) headers["chatgpt-account-id"] = a.data.account_id;

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers });
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("direct websocket connect timeout"));
    }, CONNECT_TIMEOUT_MS);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      console.log(`${index}: direct WS open ok account=${redact(a.data.account_id)} refreshed=${refreshed}`);
      ws.close(1000, "direct connectivity test complete");
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`direct websocket error for account=${redact(a.data.account_id)}`));
    });
  });
}

const auths = await loadAuths();
if (!auths.length) throw new Error(`no usable codex auths found in ${AUTH_DIR}`);
console.log(`direct upstream: ${WS_URL}`);
const selected = TEST_ALL ? auths : [auths[0]];
for (let i = 0; i < selected.length; i++) await testOne(selected[i], i);
console.log(`direct websocket test: PASS (${selected.length}/${auths.length} account${selected.length === 1 ? "" : "s"} tested)`);
