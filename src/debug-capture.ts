import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { payloadBytes } from "./json-root-scan";

interface DebugSaveItem {
  file: string;
  record: Record<string, unknown>;
  payload?: unknown;
  payloadField?: string;
}

interface DebugCaptureOptions {
  enabled: boolean;
  dir: string;
  bodyBytes: number;
  maxPending: number;
  home: string;
}

interface WsDebugData {
  pathname: string;
  upstreamUrl: string;
  cacheAffinityKey?: string;
  authLabel: string;
  authPath: string;
}

const utf8Decoder = new TextDecoder();

export class DebugRequestCapture {
  private readonly queue: DebugSaveItem[] = [];
  private drainScheduled = false;
  private seq = 0;
  private dirReady: Promise<void> | undefined;
  private readonly stats: { queued: number; saved: number; dropped: number; errors: number; pending: number; last_error?: string } = {
    queued: 0,
    saved: 0,
    dropped: 0,
    errors: 0,
    pending: 0,
  };

  constructor(private readonly opts: DebugCaptureOptions) {}

  start() {
    if (!this.opts.enabled) return;
    this.dirReady = mkdir(this.opts.dir, { recursive: true, mode: 0o700 })
      .then(() => undefined)
      .catch((err) => {
        this.stats.errors++;
        this.stats.last_error = String(err).slice(0, 500);
      });
  }

  info() {
    return {
      enabled: this.opts.enabled,
      dir: this.opts.enabled ? this.opts.dir : undefined,
      body_bytes: this.opts.bodyBytes,
      max_pending: this.opts.maxPending,
      ...this.stats,
      pending: this.queue.length,
    };
  }

  saveHttpRequest(req: Request, pathname: string, upstreamPath: string, affinityKey: string | undefined, body: ArrayBuffer | undefined) {
    if (!this.opts.enabled) return;
    this.enqueue("http-request", {
      type: "http_request",
      method: req.method,
      url: req.url,
      pathname,
      upstream_path: upstreamPath,
      cache_affinity_key: affinityKey,
      headers: this.debugHeaders(req.headers),
    }, body);
  }

  saveWebSocketHandshake(req: Request, pathname: string, upstreamUrl: string, affinityKey: string | undefined, authLabel: string, authPath: string, attempt: number) {
    if (!this.opts.enabled) return;
    this.enqueue("ws-handshake", {
      type: "websocket_handshake",
      url: req.url,
      pathname,
      upstream_url: upstreamUrl,
      cache_affinity_key: affinityKey,
      selected_auth_label: authLabel,
      selected_auth_file: authPath.replace(this.opts.home, "~"),
      attempt,
      headers: this.debugHeaders(req.headers),
    });
  }

  saveWebSocketClientMessage(data: WsDebugData, message: string | Buffer, affinityKey: string | undefined) {
    if (!this.opts.enabled) return;
    this.enqueue("ws-client-message", {
      type: "websocket_client_message",
      pathname: data.pathname,
      upstream_url: data.upstreamUrl,
      cache_affinity_key: affinityKey ?? data.cacheAffinityKey,
      selected_auth_label: data.authLabel,
      selected_auth_file: data.authPath.replace(this.opts.home, "~"),
    }, message);
  }

  private enqueue(kind: string, record: Record<string, unknown>, payload?: unknown, payloadField = "body") {
    if (this.opts.maxPending <= 0 || this.queue.length >= this.opts.maxPending) {
      this.stats.dropped++;
      return;
    }
    const now = new Date();
    const seq = (++this.seq).toString().padStart(8, "0");
    const file = `${now.toISOString().replace(/[:.]/g, "-")}-${seq}-${this.safePathPart(kind)}.json`;
    this.queue.push({ file, record: { saved_at: now.toISOString(), seq: this.seq, ...record }, payload, payloadField: payload === undefined ? undefined : payloadField });
    this.stats.queued++;
    this.stats.pending = this.queue.length;
    if (!this.drainScheduled) {
      this.drainScheduled = true;
      const timer = setTimeout(() => { void this.drainQueue(); }, 0);
      (timer as any).unref?.();
    }
  }

  private async drainQueue() {
    try {
      await this.dirReady;
    } catch (err) {
      this.stats.errors++;
      this.stats.last_error = String(err).slice(0, 500);
    }

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.stats.pending = this.queue.length;
      try {
        const record = item.payloadField ? { ...item.record, [item.payloadField]: this.debugPayload(item.payload) } : item.record;
        await writeFile(join(this.opts.dir, item.file), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
        this.stats.saved++;
      } catch (err) {
        this.stats.errors++;
        this.stats.last_error = String(err).slice(0, 500);
      }
    }

    this.stats.pending = 0;
    this.drainScheduled = false;
  }

  private debugHeaders(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of headers) {
      const lower = name.toLowerCase();
      if (lower === "authorization" || lower === "proxy-authorization" || lower === "cookie" || lower === "set-cookie" || lower.includes("api-key") || lower.includes("token") || lower.includes("secret")) {
        out[name] = "REDACTED";
      } else if (lower === "chatgpt-account-id") {
        out[name] = this.redact(value) ?? "REDACTED";
      } else {
        out[name] = value;
      }
    }
    return out;
  }

  private debugPayload(payload: unknown) {
    const bytes = payloadBytes(payload);
    if (!bytes) return undefined;
    const bodyBytes = bytes.byteLength;
    const limit = Math.min(bodyBytes, this.opts.bodyBytes);
    const truncated = bodyBytes > limit;
    const slice = bytes.subarray(0, limit);
    const base = { bytes: bodyBytes, truncated };
    if (limit === 0) return base;
    if (this.looksTextPayload(slice)) return { ...base, encoding: "utf8", data: utf8Decoder.decode(slice) };
    return { ...base, encoding: "base64", data: Buffer.from(slice).toString("base64") };
  }

  private looksTextPayload(bytes: Uint8Array): boolean {
    const len = Math.min(bytes.byteLength, 256);
    for (let i = 0; i < len; i++) {
      const c = bytes[i];
      if (c === 0) return false;
      if (c < 0x09) return false;
      if (c > 0x0d && c < 0x20) return false;
    }
    return true;
  }

  private redact(s?: string) {
    if (!s) return s;
    return s.length <= 10 ? "REDACTED" : `${s.slice(0, 5)}…${s.slice(-4)}`;
  }

  private safePathPart(s: string): string {
    return s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "request";
  }
}
