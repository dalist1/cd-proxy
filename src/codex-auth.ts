import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_AUTH_URL = "https://auth.openai.com/oauth/authorize";
export const CODEX_TOKEN_URL = process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE ?? process.env.CD_PROXY_AUTH_TOKEN_URL ?? "https://auth.openai.com/oauth/token";
export const CODEX_REDIRECT_URI = process.env.CD_PROXY_OAUTH_REDIRECT_URI ?? "http://localhost:1455/auth/callback";
export const CODEX_DEVICE_USER_CODE_URL = process.env.CD_PROXY_DEVICE_USER_CODE_URL ?? "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const CODEX_DEVICE_TOKEN_URL = process.env.CD_PROXY_DEVICE_TOKEN_URL ?? "https://auth.openai.com/api/accounts/deviceauth/token";
export const CODEX_DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";
export const CODEX_DEVICE_TOKEN_EXCHANGE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";

export interface PKCECodes {
  codeVerifier: string;
  codeChallenge: string;
}

export interface CodexTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface CodexAuthFile {
  access_token: string;
  account_id?: string;
  disabled: boolean;
  email?: string;
  expired?: string;
  id_token?: string;
  last_refresh: string;
  refresh_token: string;
  type: "codex";
}

export interface CodexAuthRecord {
  auth: CodexAuthFile;
  planType: string;
  fileName: string;
}

export function generatePKCECodes(): PKCECodes {
  // CLIProxyAPI generates 96 random bytes, encoded as unpadded URL-safe base64.
  const codeVerifier = base64Url(randomBytes(96));
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

export function generateState(): string {
  return base64Url(randomBytes(32));
}

export function buildCodexAuthUrl(state: string, pkce: PKCECodes, redirectUri = CODEX_REDIRECT_URI): string {
  const params = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "openid email profile offline_access",
    state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
    prompt: "login",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  });
  return `${CODEX_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodexCodeForTokens(code: string, pkce: PKCECodes, redirectUri = CODEX_REDIRECT_URI, tokenUrl = CODEX_TOKEN_URL): Promise<CodexAuthRecord> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CODEX_CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: pkce.codeVerifier,
  });
  const json = await postTokenForm(tokenUrl, body, "token exchange");
  return authRecordFromTokenResponse(json);
}

export async function refreshCodexTokens(refreshToken: string, tokenUrl = CODEX_TOKEN_URL): Promise<CodexAuthFile> {
  const body = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: "openid profile email",
  });
  const json = await postTokenForm(tokenUrl, body, "token refresh");
  return authRecordFromTokenResponse(json).auth;
}

export async function requestCodexDeviceUserCode(): Promise<{ deviceAuthId: string; userCode: string; intervalMs: number }> {
  const res = await fetch(CODEX_DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`codex device code request failed with status ${res.status}: ${text || "empty response body"}`);
  const json = JSON.parse(text) as { device_auth_id?: string; user_code?: string; usercode?: string; interval?: string | number };
  const deviceAuthId = String(json.device_auth_id ?? "").trim();
  const userCode = String(json.user_code ?? json.usercode ?? "").trim();
  if (!deviceAuthId || !userCode) throw new Error("codex device flow did not return required fields");
  const rawInterval = typeof json.interval === "string" ? Number(json.interval.trim()) : json.interval;
  const seconds = typeof rawInterval === "number" && rawInterval > 0 ? rawInterval : 5;
  return { deviceAuthId, userCode, intervalMs: seconds * 1000 };
}

export async function pollCodexDeviceToken(deviceAuthId: string, userCode: string, timeoutMs = 15 * 60_000, intervalMs = 5000): Promise<CodexAuthRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(CODEX_DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    });
    const text = await res.text();
    if (res.ok) {
      const json = JSON.parse(text) as { authorization_code?: string; code_verifier?: string; code_challenge?: string };
      const code = String(json.authorization_code ?? "").trim();
      const codeVerifier = String(json.code_verifier ?? "").trim();
      const codeChallenge = String(json.code_challenge ?? "").trim();
      if (!code || !codeVerifier || !codeChallenge) throw new Error("codex device flow token response missing required fields");
      return exchangeCodexCodeForTokens(code, { codeVerifier, codeChallenge }, CODEX_DEVICE_TOKEN_EXCHANGE_REDIRECT_URI);
    }
    if (res.status !== 403 && res.status !== 404) {
      throw new Error(`codex device token polling failed with status ${res.status}: ${text || "empty response body"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("codex device authentication timed out after 15 minutes");
}

export async function saveCodexAuthRecord(record: CodexAuthRecord, authDir: string): Promise<string> {
  await mkdir(authDir, { recursive: true, mode: 0o700 });
  const dest = join(authDir, record.fileName);
  // CLIProxyAPI uses json.Encoder, which writes one JSON object plus a trailing newline.
  await writeFile(dest, JSON.stringify(record.auth) + "\n", { mode: 0o600 });
  await chmod(dest, 0o600).catch(() => {});
  return dest;
}

export function authRecordFromTokenResponse(json: CodexTokenResponse): CodexAuthRecord {
  if (!json.access_token || !json.refresh_token) {
    const detail = json.error_description || json.error || "missing access_token/refresh_token";
    throw new Error(`invalid codex token response: ${detail}`);
  }
  const claims = jwtClaims(json.id_token) ?? jwtClaims(json.access_token) ?? {};
  const authClaims = claims["https://api.openai.com/auth"] ?? {};
  const email = String(claims.email ?? claims["https://api.openai.com/profile"]?.email ?? "").trim();
  const accountId = String(authClaims.chatgpt_account_id ?? "").trim();
  const planType = String(authClaims.chatgpt_plan_type ?? "").trim();
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : undefined;
  const auth: CodexAuthFile = {
    access_token: json.access_token,
    account_id: accountId || undefined,
    disabled: false,
    email: email || undefined,
    expired: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
    id_token: json.id_token,
    last_refresh: new Date().toISOString(),
    refresh_token: json.refresh_token,
    type: "codex",
  };
  return { auth, planType, fileName: credentialFileName(email || "unknown", planType, accountId, true) };
}

export function jwtClaims(jwt?: string): any | undefined {
  if (!jwt) return undefined;
  try {
    const payload = jwt.split(".")[1];
    return JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function credentialFileName(email: string, planType: string, accountId: string, includeProviderPrefix: boolean): string {
  const plan = normalizePlanTypeForFilename(planType);
  const prefix = includeProviderPrefix ? "codex" : "";
  if (!plan) return `${prefix}-${email}.json`;
  if (plan === "team") return `${prefix}-${hashAccountIdPrefix(accountId)}-${email}-${plan}.json`;
  return `${prefix}-${email}-${plan}.json`;
}

export function normalizePlanTypeForFilename(planType: string): string {
  const parts = planType.trim().split(/[^A-Za-z0-9]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  return parts.join("-");
}

export function hashAccountIdPrefix(accountId: string): string {
  if (!accountId.trim()) return "";
  return createHash("sha256").update(accountId.trim()).digest("hex").slice(0, 8);
}

async function postTokenForm(tokenUrl: string, body: URLSearchParams, operation: string): Promise<CodexTokenResponse> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`codex ${operation} failed with status ${res.status}: ${text.slice(0, 1000)}`);
  return JSON.parse(text) as CodexTokenResponse;
}

function base64Url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}
