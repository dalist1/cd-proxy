#!/usr/bin/env bun
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { basename, join } from "node:path";

const HOME = process.env.HOME ?? ".";
function expandHome(p: string) { return p === "~" ? HOME : p.startsWith("~/") ? HOME + p.slice(1) : p; }
function usage(): never {
  console.error(`usage: bun run scripts/import-codex-auth.ts [auth.json]

Imports a Codex CLI ChatGPT login from CODEX_HOME/auth.json format into cd-proxy/cliproxy codex-*.json format.

Env/options:
  CODEX_HOME                  source home if auth.json path omitted (default ~/.codex)
  CD_PROXY_AUTH_DIR           destination auth dir (default ~/.local/share/cd-proxy/auths)
`);
  process.exit(2);
}
function jwtClaims(jwt?: string): any | undefined {
  if (!jwt) return undefined;
  try {
    const payload = jwt.split(".")[1];
    return JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch { return undefined; }
}
function safeName(s: string) { return s.replace(/[^A-Za-z0-9_.@+-]+/g, "_"); }

const source = expandHome(process.argv[2] ?? join(process.env.CODEX_HOME ? expandHome(process.env.CODEX_HOME) : join(HOME, ".codex"), "auth.json"));
if (process.argv.includes("-h") || process.argv.includes("--help")) usage();
const destDir = expandHome(process.env.CD_PROXY_AUTH_DIR ?? "~/.local/share/cd-proxy/auths");

const raw = JSON.parse(await readFile(source, "utf8"));
if (raw.auth_mode && raw.auth_mode !== "chatgpt") {
  console.error(`refusing to import ${source}: auth_mode=${raw.auth_mode}; cd-proxy Codex backend requires ChatGPT/Codex OAuth tokens, not API-key auth`);
  process.exit(1);
}
const tokens = raw.tokens;
if (!tokens?.access_token || !tokens?.refresh_token) {
  console.error(`refusing to import ${source}: no ChatGPT OAuth access_token/refresh_token found`);
  process.exit(1);
}
const claims = jwtClaims(tokens.id_token) ?? jwtClaims(tokens.access_token) ?? {};
const authClaims = claims["https://api.openai.com/auth"] ?? {};
const profileClaims = claims["https://api.openai.com/profile"] ?? {};
const email = claims.email ?? profileClaims.email ?? `codex-${basename(source)}`;
const plan = authClaims.chatgpt_plan_type ?? "chatgpt";
const expMs = typeof claims.exp === "number" ? claims.exp * 1000 : undefined;
const out = {
  access_token: tokens.access_token,
  account_id: tokens.account_id ?? authClaims.chatgpt_account_id,
  disabled: false,
  email,
  expired: expMs ? new Date(expMs).toISOString() : undefined,
  id_token: tokens.id_token,
  last_refresh: raw.last_refresh ?? new Date().toISOString(),
  refresh_token: tokens.refresh_token,
  type: "codex",
};
await mkdir(destDir, { recursive: true, mode: 0o700 });
const dest = join(destDir, `codex-${safeName(email)}-${safeName(String(plan))}.json`);
await writeFile(dest, JSON.stringify(out), { mode: 0o600 });
await chmod(dest, 0o600).catch(() => {});
console.log(JSON.stringify({ ok: true, source, dest, email, plan, account_id_prefix: out.account_id ? String(out.account_id).slice(0, 5) : undefined }, null, 2));
