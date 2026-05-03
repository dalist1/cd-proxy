#!/usr/bin/env bun
import { spawn } from "bun";
import {
  buildCodexAuthUrl,
  CODEX_DEVICE_VERIFICATION_URL,
  CODEX_REDIRECT_URI,
  exchangeCodexCodeForTokens,
  generatePKCECodes,
  generateState,
  pollCodexDeviceToken,
  requestCodexDeviceUserCode,
  saveCodexAuthRecord,
} from "../src/codex-auth";

const HOME = process.env.HOME ?? ".";
function expandHome(p: string) { return p === "~" ? HOME : p.startsWith("~/") ? HOME + p.slice(1) : p; }

const args = process.argv.slice(2);
let deviceAuth = false;
let noBrowser = false;
let timeoutMs = 5 * 60_000;
let authDir = expandHome(process.env.CD_PROXY_AUTH_DIR ?? "~/.local/share/cd-proxy/auths");
let redirectUri = CODEX_REDIRECT_URI;

function usage(): never {
  console.error(`usage: bun run scripts/codex-oauth-login.ts [--device-auth] [--no-browser] [--timeout-seconds N] [--auth-dir DIR]

Native Codex OAuth login compatible with CLIProxyAPI/cliproxy credential files.
This does not invoke codex, cliproxy, or CLIProxyAPI.

Options:
  --device-auth          Use Codex device-code flow
  --no-browser          Print the URL instead of trying to open a browser
  --timeout-seconds N   Browser callback wait timeout (default 300)
  --auth-dir DIR        Destination auth dir (default CD_PROXY_AUTH_DIR or ~/.local/share/cd-proxy/auths)

Test-only env overrides:
  CD_PROXY_AUTH_TOKEN_URL, CD_PROXY_OAUTH_REDIRECT_URI,
  CD_PROXY_DEVICE_USER_CODE_URL, CD_PROXY_DEVICE_TOKEN_URL
`);
  process.exit(2);
}

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "-h" || arg === "--help") usage();
  if (arg === "--device-auth") { deviceAuth = true; continue; }
  if (arg === "--no-browser") { noBrowser = true; continue; }
  if (arg === "--timeout-seconds") { timeoutMs = Number(args[++i] ?? "") * 1000; continue; }
  if (arg === "--auth-dir") { authDir = expandHome(args[++i] ?? ""); continue; }
  if (arg === "--redirect-uri") { redirectUri = args[++i] ?? ""; continue; }
  if (arg === "--with-api-key") {
    console.error("cd-proxy Codex backend uses ChatGPT/Codex OAuth, not API-key auth. Use browser login or --device-auth.");
    process.exit(2);
  }
  console.error(`unknown argument: ${arg}`);
  usage();
}

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) usage();
if (!authDir) usage();

if (deviceAuth) await runDeviceAuth();
else await runBrowserAuth();

async function runBrowserAuth() {
  const callbackUrl = new URL(redirectUri);
  if (callbackUrl.hostname !== "localhost" && callbackUrl.hostname !== "127.0.0.1") {
    throw new Error(`refusing non-local redirect URI: ${redirectUri}`);
  }
  const port = Number(callbackUrl.port || (callbackUrl.protocol === "https:" ? "443" : "80"));
  const callbackPath = callbackUrl.pathname || "/auth/callback";

  const pkce = generatePKCECodes();
  const state = generateState();
  const authUrl = buildCodexAuthUrl(state, pkce, redirectUri);

  let resolveCallback!: (value: URL) => void;
  let rejectCallback!: (reason: Error) => void;
  const callbackPromise = new Promise<URL>((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });

  const server = Bun.serve({
    host: callbackUrl.hostname,
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === callbackPath) {
        if (url.searchParams.get("error")) {
          rejectCallback(new Error(`OAuth error: ${url.searchParams.get("error")}${url.searchParams.get("error_description") ? ` - ${url.searchParams.get("error_description")}` : ""}`));
          return new Response("OAuth error; return to your terminal.\n", { status: 400 });
        }
        resolveCallback(url);
        return Response.redirect(new URL("/success", url), 302);
      }
      if (url.pathname === "/success") {
        return new Response(successHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("not found\n", { status: 404 });
    },
  });

  try {
    console.log("Opening browser for Codex authentication");
    if (!noBrowser) await openBrowser(authUrl).catch((err) => console.warn(`Failed to open browser automatically: ${err}`));
    console.log(`Visit the following URL to continue authentication:\n${authUrl}`);
    console.log("Waiting for Codex authentication callback...");

    const url = await withTimeout(callbackPromise, timeoutMs, "timeout waiting for OAuth callback");
    const code = url.searchParams.get("code") ?? "";
    const gotState = url.searchParams.get("state") ?? "";
    if (!code) throw new Error("no authorization code received");
    if (gotState !== state) throw new Error("state mismatch");

    const record = await exchangeCodexCodeForTokens(code, pkce, redirectUri);
    const dest = await saveCodexAuthRecord(record, authDir);
    console.log(`Codex authentication successful`);
    console.log(`Authentication saved to ${dest}`);
  } finally {
    server.stop(true);
  }
}

async function runDeviceAuth() {
  const code = await requestCodexDeviceUserCode();
  console.log("Starting Codex device authentication...");
  console.log(`Codex device URL: ${CODEX_DEVICE_VERIFICATION_URL}`);
  console.log(`Codex device code: ${code.userCode}`);
  if (!noBrowser) await openBrowser(CODEX_DEVICE_VERIFICATION_URL).catch((err) => console.warn(`Failed to open browser automatically: ${err}`));
  const record = await pollCodexDeviceToken(code.deviceAuthId, code.userCode, 15 * 60_000, code.intervalMs);
  const dest = await saveCodexAuthRecord(record, authDir);
  console.log(`Codex device authentication successful`);
  console.log(`Authentication saved to ${dest}`);
}

async function openBrowser(url: string) {
  const candidates = process.platform === "darwin" ? [["open", url]]
    : process.platform === "win32" ? [["cmd", "/c", "start", "", url]]
    : [["xdg-open", url], ["sensible-browser", url]];
  let lastErr: unknown;
  for (const cmd of candidates) {
    try {
      const proc = spawn(cmd, { stdout: "ignore", stderr: "ignore" });
      const code = await proc.exited;
      if (code === 0) return;
      lastErr = new Error(`${cmd[0]} exited ${code}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("no browser opener available");
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: Timer | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function successHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Codex authentication successful</title></head><body><h1>Authentication successful</h1><p>You can close this window and return to your terminal.</p></body></html>`;
}
