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
  private lastChosenPath: string | undefined;
  private readonly cooldownUntilByPath = new Map<string, number>();
  private readonly refreshInFlightByPath = new Map<string, Promise<void>>();
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
    const previousAuths = this.auths;
    const previousNextPath = previousAuths.length ? previousAuths[this.rr % previousAuths.length]?.path : undefined;
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
        const old = previousAuths.find((a) => a.path === path);
        const coolingUntil = Math.max(old?.coolingUntil ?? 0, this.cooldownUntilByPath.get(path) ?? 0);
        next.push({
          path,
          label: data.email ?? name.replace(/^codex-/, "").replace(/\.json$/, ""),
          data,
          expiresAtMs: this.computeExpiryMs(data),
          coolingUntil,
          refreshInFlight: old?.refreshInFlight ?? this.refreshInFlightByPath.get(path),
        });
      } catch (err) {
        console.error(`failed to load ${path}:`, err);
      }
    }

    this.auths = next;
    this.enabledCount = this.auths.reduce((count, a) => count + (a.data.disabled ? 0 : 1), 0);
    this.realignRoundRobinAfterLoad(previousNextPath);
    this.pruneCooldowns();
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
        this.unavailableFlags[i] = this.isExcluded(exclude, a) || a.data.disabled || this.coolingUntil(a) > now ? 1 : 0;
      }
      const flagsPtr = ptr(this.unavailableFlags);
      if (flagsPtr) {
        const idx = zigCore.cdproxy_pick_next_flags(this.auths.length, this.rr % this.auths.length, flagsPtr as any);
        if (idx >= 0) {
          this.rr = idx + 1;
          return this.markChosen(this.auths[idx]);
        }
        this.rr += this.auths.length;
        return undefined;
      }
    }

    for (let i = 0; i < this.auths.length; i++) {
      const idx = this.rr++ % this.auths.length;
      const a = this.auths[idx];
      if (this.isExcluded(exclude, a) || a.data.disabled || this.coolingUntil(a) > now) continue;
      return this.markChosen(a);
    }
    return undefined;
  }

  async ensureFresh(a: AuthEntry) {
    if (this.isTokenExpiring(a)) await this.refresh(a);
  }

  cooldown(a: AuthEntry, durationMs: number) {
    const now = Date.now();
    const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    const until = now + duration;
    a.coolingUntil = until;
    const current = this.auths.find((entry) => entry.path === a.path);
    if (current) current.coolingUntil = until;
    if (until > now) this.cooldownUntilByPath.set(a.path, until);
    else this.cooldownUntilByPath.delete(a.path);
  }

  async refresh(a: AuthEntry): Promise<void> {
    const existing = a.refreshInFlight ?? this.refreshInFlightByPath.get(a.path);
    if (existing) return existing;

    const path = a.path;
    let refreshPromise!: Promise<void>;
    refreshPromise = (async () => {
      this.opts.log(`refreshing ${a.label} (${this.redact(a.data.refresh_token)})`);
      const refreshed = await refreshCodexTokens(a.data.refresh_token);
      const applyRefreshed = (target: AuthEntry) => {
        target.data.access_token = refreshed.access_token;
        target.data.refresh_token = refreshed.refresh_token;
        if (refreshed.id_token) target.data.id_token = refreshed.id_token;
        if (refreshed.expired) target.data.expired = refreshed.expired;
        target.data.last_refresh = refreshed.last_refresh;
        target.expiresAtMs = this.computeExpiryMs(target.data);
        const claims = this.decodeJwtClaims(target.data.id_token);
        target.data.email ??= claims?.email ?? claims?.["https://api.openai.com/profile"]?.email;
        target.data.account_id ??= claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
      };

      applyRefreshed(a);
      const current = this.auths.find((entry) => entry.path === path);
      if (current && current !== a) applyRefreshed(current);
      await writeFile(path, JSON.stringify(a.data) + "\n", { mode: 0o600 });
    })().finally(() => {
      if (a.refreshInFlight === refreshPromise) a.refreshInFlight = undefined;
      const current = this.auths.find((entry) => entry.path === path);
      if (current && current.refreshInFlight === refreshPromise) current.refreshInFlight = undefined;
      if (this.refreshInFlightByPath.get(path) === refreshPromise) this.refreshInFlightByPath.delete(path);
    });

    a.refreshInFlight = refreshPromise;
    this.refreshInFlightByPath.set(path, refreshPromise);
    const current = this.auths.find((entry) => entry.path === path);
    if (current) current.refreshInFlight = refreshPromise;
    return refreshPromise;
  }

  publicInfo(a: AuthEntry) {
    return {
      label: a.label,
      account_id_prefix: a.data.account_id ? a.data.account_id.slice(0, 5) : undefined,
      disabled: !!a.data.disabled,
      cooling_ms: Math.max(0, this.coolingUntil(a) - Date.now()),
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

  private realignRoundRobinAfterLoad(previousNextPath: string | undefined) {
    // Auth files are sorted on every reload. If a new file sorts before the
    // numeric cursor, preserving only the index can repeat the just-used auth.
    // Anchor the cursor to stable auth file paths instead.
    if (this.auths.length === 0) {
      this.rr = 0;
      this.lastChosenPath = undefined;
      return;
    }

    if (this.lastChosenPath) {
      const lastIdx = this.auths.findIndex((a) => a.path === this.lastChosenPath);
      if (lastIdx >= 0) {
        this.rr = (lastIdx + 1) % this.auths.length;
        return;
      }
      this.lastChosenPath = undefined;
    }

    if (previousNextPath) {
      const nextIdx = this.auths.findIndex((a) => a.path === previousNextPath);
      if (nextIdx >= 0) {
        this.rr = nextIdx;
        return;
      }
    }

    this.rr %= this.auths.length;
  }

  private pruneCooldowns() {
    const now = Date.now();
    const paths = new Set(this.auths.map((a) => a.path));
    for (const [path, until] of this.cooldownUntilByPath) {
      if (until <= now || !paths.has(path)) this.cooldownUntilByPath.delete(path);
    }
    for (const a of this.auths) {
      if (a.coolingUntil > now) this.cooldownUntilByPath.set(a.path, a.coolingUntil);
    }
  }

  private markChosen(a: AuthEntry): AuthEntry {
    this.lastChosenPath = a.path;
    return a;
  }

  private coolingUntil(a: AuthEntry): number {
    const mapped = this.cooldownUntilByPath.get(a.path) ?? 0;
    if (mapped > a.coolingUntil) a.coolingUntil = mapped;
    return a.coolingUntil;
  }

  private isExcluded(exclude: AuthEntry[] | undefined, a: AuthEntry): boolean {
    return !!exclude && exclude.some((entry) => entry === a || entry.path === a.path);
  }

  private redact(s?: string) {
    if (!s) return s;
    return s.length <= 10 ? "REDACTED" : `${s.slice(0, 5)}…${s.slice(-4)}`;
  }
}
