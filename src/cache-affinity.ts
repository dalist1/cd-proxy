import { jsonRootStringFieldValue, payloadBytes } from "./json-root-scan";
import type { AuthEntry, CacheAffinityEntry } from "./types";

interface CacheAffinityOptions {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
  headers: string[];
  bodyFields: string[];
  maxValueBytes: number;
}

export class CacheAffinityStore {
  private readonly bodyFieldSet: Set<string>;
  private readonly entries = new Map<string, CacheAffinityEntry>();
  private authByPath = new Map<string, AuthEntry>();
  private readonly stats = {
    lookups: 0,
    hits: 0,
    misses: 0,
    binds: 0,
    rebinds: 0,
    evictions: 0,
    unavailable: 0,
  };

  constructor(private readonly opts: CacheAffinityOptions) {
    this.bodyFieldSet = new Set(opts.bodyFields);
  }

  updateAuths(auths: AuthEntry[]) {
    this.authByPath = new Map(auths.map((a) => [a.path, a]));
    this.prune(Date.now(), true);
  }

  keyFromRequest(req: Request): string | undefined {
    if (!this.active || this.opts.headers.length === 0) return undefined;
    for (const name of this.opts.headers) {
      const key = this.normalizedKey(req.headers.get(name));
      if (key) return key;
    }
    return undefined;
  }

  keyFromPayload(payload: unknown): string | undefined {
    if (!this.active || this.bodyFieldSet.size === 0) return undefined;
    const bytes = payloadBytes(payload);
    if (!bytes || bytes.byteLength === 0) return undefined;
    return this.normalizedKey(jsonRootStringFieldValue(bytes, this.bodyFieldSet));
  }

  choose(key: string | undefined, exclude?: AuthEntry[]): AuthEntry | undefined {
    if (!key) return undefined;
    this.stats.lookups++;
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      this.stats.evictions++;
      this.stats.misses++;
      return undefined;
    }
    const a = this.authByPath.get(entry.authPath);
    if (!a) {
      this.entries.delete(key);
      this.stats.evictions++;
      this.stats.misses++;
      return undefined;
    }
    if (a.data.disabled || a.coolingUntil > now || this.isExcluded(exclude, a)) {
      this.stats.unavailable++;
      return undefined;
    }
    entry.lastUsed = now;
    entry.expiresAt = now + this.opts.ttlMs;
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.stats.hits++;
    return a;
  }

  bind(key: string | undefined, a: AuthEntry) {
    if (!key || !this.active || a.data.disabled) return;
    const now = Date.now();
    const previous = this.entries.get(key);
    if (previous) this.entries.delete(key);
    if (previous && previous.authPath !== a.path) this.stats.rebinds++;
    else if (!previous) this.stats.binds++;
    this.entries.set(key, { authPath: a.path, expiresAt: now + this.opts.ttlMs, lastUsed: now });
    this.prune(now, false);
  }

  bindByPath(key: string | undefined, authPath: string) {
    const a = this.authByPath.get(authPath);
    if (a) this.bind(key, a);
  }

  info() {
    this.prune(Date.now(), true);
    return {
      enabled: this.active,
      entries: this.entries.size,
      ttl_ms: this.opts.ttlMs,
      max_entries: Math.max(0, Math.floor(this.opts.maxEntries)),
      headers: this.opts.headers,
      body_fields: this.opts.bodyFields,
      max_value_bytes: this.opts.maxValueBytes,
      ...this.stats,
    };
  }

  private get active() {
    return this.opts.enabled && this.opts.ttlMs > 0;
  }

  private isExcluded(exclude: AuthEntry[] | undefined, a: AuthEntry): boolean {
    return !!exclude && exclude.some((entry) => entry === a || entry.path === a.path);
  }

  private normalizedKey(value: string | undefined | null): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    if (trimmed.length <= this.opts.maxValueBytes && Buffer.byteLength(trimmed) <= this.opts.maxValueBytes) return `cache:${trimmed}`;
    const bounded = Buffer.from(trimmed).subarray(0, this.opts.maxValueBytes).toString("utf8").replace(/\uFFFD$/, "");
    return bounded ? `cache:${bounded}` : undefined;
  }

  private evictOldest() {
    const oldestKey = this.entries.keys().next().value as string | undefined;
    if (!oldestKey) return false;
    this.entries.delete(oldestKey);
    this.stats.evictions++;
    return true;
  }

  private prune(now = Date.now(), full = true) {
    const maxEntries = Math.max(0, Math.floor(this.opts.maxEntries));
    if (maxEntries === 0) {
      this.stats.evictions += this.entries.size;
      this.entries.clear();
      return;
    }

    if (full) {
      for (const [key, entry] of this.entries) {
        if (entry.expiresAt <= now || !this.authByPath.has(entry.authPath)) {
          this.entries.delete(key);
          this.stats.evictions++;
        }
      }
    } else {
      while (this.entries.size > 0) {
        const first = this.entries.entries().next().value as [string, CacheAffinityEntry] | undefined;
        if (!first) break;
        const [key, entry] = first;
        if (entry.expiresAt > now && this.authByPath.has(entry.authPath)) break;
        this.entries.delete(key);
        this.stats.evictions++;
      }
    }

    while (this.entries.size > maxEntries) {
      if (!this.evictOldest()) break;
    }
  }
}
