import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ptr } from "bun:ffi";
import { refreshCodexTokens } from "./codex-auth";
import type { AuthEntry, CodexAuthFile } from "./types";
import type { ZigCore } from "./native-core";

interface AuthStoreOptions {
  authDir: string;
  home: string;
  refreshSkewMs: number;
  maxRetryCredentials: number;
  useZigAuthParse: boolean;
  useZigJwtExp: boolean;
  useZigPick: boolean;
  zigCore: () => ZigCore | undefined;
  log: (...args: unknown[]) => void;
}

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
const ZIG_PICK_THRESHOLD = 512;

export class AuthStore {
  auths: AuthEntry[] = [];
  enabledCount = 0;
  private rr = 0;
  private unavailableFlags = new Uint8Array(0);
  private readonly authJsonViewScratch = Buffer.alloc(AUTH_JSON_VIEW_BYTES);

  constructor(private readonly opts: AuthStoreOptions) {}

  get rrIndex() {
    return this.rr % Math.max(1, this.auths.length);
  }

  maxCredentialAttempts(): number {
    if (!Number.isFinite(this.opts.maxRetryCredentials) || this.opts.maxRetryCredentials <= 0) return Math.max(1, this.auths.length);
    return Math.min(Math.floor(this.opts.maxRetryCredentials), Math.max(1, this.auths.length));
  }

  async load() {
    const next: AuthEntry[] = [];
    const names = (await readdir(this.opts.authDir).catch(() => []))
      .filter((name) => name.startsWith("codex-") && name.endsWith(".json"))
      .sort((a, b) => a.localeCompare(b));

    for (const name of names) {
      const path = join(this.opts.authDir, name);
      try {
        const data = this.parseAuthJson(await readFile(path));
        if (data.type && data.type !== "codex") continue;
        if (!data.access_token || !data.refresh_token) continue;
        const old = this.auths.find((a) => a.path === path);
        next.push({
          path,
          label: data.email ?? name.replace(/^codex-/, "").replace(/\.json$/, ""),
          data,
          expiresAtMs: this.computeExpiryMs(data),
          coolingUntil: old?.coolingUntil ?? 0,
          refreshInFlight: old?.refreshInFlight,
        });
      } catch (err) {
        console.error(`failed to load ${path}:`, err);
      }
    }

    this.auths = next;
    this.enabledCount = this.auths.reduce((count, a) => count + (a.data.disabled ? 0 : 1), 0);
    if (this.rr >= this.auths.length) this.rr = 0;
    this.opts.log(`loaded ${this.auths.length} codex auth(s) from ${this.opts.authDir}`);
  }

  choose(exclude?: AuthEntry[]): AuthEntry | undefined {
    const now = Date.now();
    if (this.auths.length === 0) return undefined;

    const zigCore = this.opts.zigCore();
    if (this.opts.useZigPick && zigCore && this.auths.length >= ZIG_PICK_THRESHOLD) {
      if (this.unavailableFlags.length < this.auths.length) this.unavailableFlags = new Uint8Array(this.auths.length);
      for (let i = 0; i < this.auths.length; i++) {
        const a = this.auths[i];
        this.unavailableFlags[i] = this.isExcluded(exclude, a) || a.data.disabled || a.coolingUntil > now ? 1 : 0;
      }
      const flagsPtr = ptr(this.unavailableFlags);
      if (flagsPtr) {
        const idx = zigCore.cdproxy_pick_next_flags(this.auths.length, this.rr % this.auths.length, flagsPtr as any);
        if (idx >= 0) {
          this.rr = idx + 1;
          return this.auths[idx];
        }
        this.rr += this.auths.length;
        return undefined;
      }
    }

    for (let i = 0; i < this.auths.length; i++) {
      const idx = this.rr++ % this.auths.length;
      const a = this.auths[idx];
      if (this.isExcluded(exclude, a) || a.data.disabled || a.coolingUntil > now) continue;
      return a;
    }
    return undefined;
  }

  async ensureFresh(a: AuthEntry) {
    if (this.isTokenExpiring(a)) await this.refresh(a);
  }

  async refresh(a: AuthEntry): Promise<void> {
    if (a.refreshInFlight) return a.refreshInFlight;
    a.refreshInFlight = (async () => {
      this.opts.log(`refreshing ${a.label} (${this.redact(a.data.refresh_token)})`);
      const refreshed = await refreshCodexTokens(a.data.refresh_token);
      a.data.access_token = refreshed.access_token;
      a.data.refresh_token = refreshed.refresh_token;
      if (refreshed.id_token) a.data.id_token = refreshed.id_token;
      if (refreshed.expired) a.data.expired = refreshed.expired;
      a.data.last_refresh = refreshed.last_refresh;
      a.expiresAtMs = this.computeExpiryMs(a.data);
      const claims = this.decodeJwtClaims(a.data.id_token);
      a.data.email ??= claims?.email ?? claims?.["https://api.openai.com/profile"]?.email;
      a.data.account_id ??= claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
      await writeFile(a.path, JSON.stringify(a.data) + "\n", { mode: 0o600 });
    })().finally(() => { a.refreshInFlight = undefined; });
    return a.refreshInFlight;
  }

  publicInfo(a: AuthEntry) {
    return {
      label: a.label,
      account_id_prefix: a.data.account_id ? a.data.account_id.slice(0, 5) : undefined,
      disabled: !!a.data.disabled,
      cooling_ms: Math.max(0, a.coolingUntil - Date.now()),
      expired: a.data.expired,
      file: a.path.replace(this.opts.home, "~"),
    };
  }

  private parseAuthJson(raw: Buffer): CodexAuthFile {
    const zigCore = this.opts.zigCore();
    if (this.opts.useZigAuthParse && zigCore?.cdproxy_parse_auth_json) {
      const out = this.authJsonViewScratch;
      const rawPtr = ptr(raw);
      const outPtr = ptr(out);
      if (rawPtr && outPtr && zigCore.cdproxy_parse_auth_json(rawPtr as any, raw.byteLength, outPtr as any)) {
        return {
          type: this.authJsonViewString(raw, out, AUTH_TYPE_OFFSET),
          email: this.authJsonViewString(raw, out, AUTH_EMAIL_OFFSET),
          account_id: this.authJsonViewString(raw, out, AUTH_ACCOUNT_ID_OFFSET),
          access_token: this.authJsonViewString(raw, out, AUTH_ACCESS_TOKEN_OFFSET) ?? "",
          refresh_token: this.authJsonViewString(raw, out, AUTH_REFRESH_TOKEN_OFFSET) ?? "",
          id_token: this.authJsonViewString(raw, out, AUTH_ID_TOKEN_OFFSET),
          expired: this.authJsonViewString(raw, out, AUTH_EXPIRED_OFFSET),
          last_refresh: this.authJsonViewString(raw, out, AUTH_LAST_REFRESH_OFFSET),
          disabled: out[AUTH_DISABLED_OFFSET] === 1,
        };
      }
    }
    return JSON.parse(raw.toString("utf8")) as CodexAuthFile;
  }

  private authJsonViewString(raw: Buffer, out: Buffer, offset: number): string | undefined {
    const start = Number(out.readBigUInt64LE(offset));
    const len = Number(out.readBigUInt64LE(offset + 8));
    if (start === 0 && len === 0) return undefined;
    return raw.toString("utf8", start, start + len);
  }

  private computeExpiryMs(data: CodexAuthFile): number | undefined {
    if (data.expired) {
      const t = Date.parse(data.expired);
      if (!Number.isNaN(t)) return t;
    }
    if (data.id_token) return this.jwtExpMs(data.id_token);
    return undefined;
  }

  private jwtExpMs(jwt: string): number | undefined {
    const zigCore = this.opts.zigCore();
    if (this.opts.useZigJwtExp && zigCore?.cdproxy_jwt_exp_ms) {
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

  private decodeJwtClaims(jwt?: string): any | undefined {
    if (!jwt) return undefined;
    try {
      const payload = jwt.split(".")[1];
      return JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    } catch {
      return undefined;
    }
  }

  private isTokenExpiring(a: AuthEntry): boolean {
    return a.expiresAtMs !== undefined && Date.now() + this.opts.refreshSkewMs >= a.expiresAtMs;
  }

  private isExcluded(exclude: AuthEntry[] | undefined, a: AuthEntry): boolean {
    return !!exclude && exclude.includes(a);
  }

  private redact(s?: string) {
    if (!s) return s;
    return s.length <= 10 ? "REDACTED" : `${s.slice(0, 5)}…${s.slice(-4)}`;
  }
}
