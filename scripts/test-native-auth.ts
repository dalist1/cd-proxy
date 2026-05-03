#!/usr/bin/env bun
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCodexAuthUrl,
  credentialFileName,
  exchangeCodexCodeForTokens,
  generatePKCECodes,
  generateState,
  hashAccountIdPrefix,
  refreshCodexTokens,
  saveCodexAuthRecord,
} from "../src/codex-auth";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function jwt(claims: any) {
  const b64 = (obj: any) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.`;
}

const pkce = generatePKCECodes();
assert(pkce.codeVerifier.length === 128, "PKCE verifier must match CLIProxyAPI 96-byte base64url generation");
assert(/^[A-Za-z0-9_-]+$/.test(pkce.codeVerifier), "PKCE verifier must be URL-safe");
assert(/^[A-Za-z0-9_-]+$/.test(pkce.codeChallenge), "PKCE challenge must be URL-safe");

const state = generateState();
const redirectUri = "http://localhost:1455/auth/callback";
const authUrl = new URL(buildCodexAuthUrl(state, pkce, redirectUri));
assert(authUrl.origin + authUrl.pathname === "https://auth.openai.com/oauth/authorize", "auth URL endpoint mismatch");
assert(authUrl.searchParams.get("client_id") === "app_EMoamEEZ73f0CkXaXp7hrann", "client_id mismatch");
assert(authUrl.searchParams.get("scope") === "openid email profile offline_access", "scope mismatch");
assert(authUrl.searchParams.get("prompt") === "login", "prompt mismatch");
assert(authUrl.searchParams.get("id_token_add_organizations") === "true", "organizations flag mismatch");
assert(authUrl.searchParams.get("codex_cli_simplified_flow") === "true", "simplified flow flag mismatch");

const idToken = jwt({
  email: "test@example.com",
  exp: Math.floor(Date.now() / 1000) + 3600,
  "https://api.openai.com/auth": {
    chatgpt_account_id: "account-123",
    chatgpt_plan_type: "plus",
  },
});

const seen: Array<{ method: string; contentType: string | null; accept: string | null; body: string }> = [];
const server = Bun.serve({
  host: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = await req.text();
    seen.push({ method: req.method, contentType: req.headers.get("content-type"), accept: req.headers.get("accept"), body });
    return Response.json({ access_token: "access", refresh_token: "refresh-next", id_token: idToken, token_type: "Bearer", expires_in: 3600 });
  },
});
try {
  const tokenUrl = `http://${server.hostname}:${server.port}/oauth/token`;
  const record = await exchangeCodexCodeForTokens("auth-code", pkce, redirectUri, tokenUrl);
  assert(record.fileName === "codex-test@example.com-plus.json", `unexpected filename ${record.fileName}`);
  assert(record.auth.type === "codex", "auth type mismatch");
  assert(record.auth.account_id === "account-123", "account id mismatch");
  assert(record.auth.email === "test@example.com", "email mismatch");
  assert(seen[0].method === "POST", "exchange must POST");
  assert(seen[0].contentType?.startsWith("application/x-www-form-urlencoded"), "exchange must use form encoding");
  assert(seen[0].accept === "application/json", "exchange must accept json");
  const exchangeBody = new URLSearchParams(seen[0].body);
  assert(exchangeBody.get("grant_type") === "authorization_code", "exchange grant mismatch");
  assert(exchangeBody.get("code_verifier") === pkce.codeVerifier, "exchange verifier mismatch");

  await refreshCodexTokens("refresh-old", tokenUrl);
  const refreshBody = new URLSearchParams(seen[1].body);
  assert(refreshBody.get("grant_type") === "refresh_token", "refresh grant mismatch");
  assert(refreshBody.get("refresh_token") === "refresh-old", "refresh token mismatch");
  assert(refreshBody.get("scope") === "openid profile email", "refresh scope mismatch");

  const dir = await mkdtemp(join(tmpdir(), "cd-proxy-auth-"));
  try {
    const dest = await saveCodexAuthRecord(record, dir);
    const saved = await readFile(dest, "utf8");
    assert(saved.endsWith("\n"), "saved auth must match CLIProxyAPI json.Encoder newline");
    assert(JSON.parse(saved).type === "codex", "saved auth parse mismatch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  assert(credentialFileName("a@b", "team", "account-123", true) === `codex-${hashAccountIdPrefix("account-123")}-a@b-team.json`, "team filename mismatch");
} finally {
  server.stop(true);
}

console.log("native auth tests: PASS");
