import { ptr } from "bun:ffi";
import type { AuthEntry, TransportStats, WsProxyData } from "./types";
import type { ZigCore } from "./native-core";
import { AuthStore } from "./auth-store";
import { CacheAffinityStore } from "./cache-affinity";
import { DebugRequestCapture } from "./debug-capture";
import { cooldownMsForFailure, jsonResponse, staticJsonResponse } from "./http-proxy";
import { payloadBytes } from "./json-root-scan";

const WS_UPGRADE_FAILED_BODY = JSON.stringify({ error: { message: "websocket upgrade failed" } }, null, 2);
const COMPACT_ROOT_TYPE_PREFIX = '{"type":"';
const utf8Decoder = new TextDecoder();

interface WsProxyOptions {
  authStore: AuthStore;
  cacheAffinity: CacheAffinityStore;
  debugCapture: DebugRequestCapture;
  transportStats: TransportStats;
  upstreamWsUrl: string;
  wsBase: string;
  connectTimeoutMs: number;
  cooldownMs: number;
  exposeRotationHeaders: boolean;
  zigCore: () => ZigCore | undefined;
  log: (...args: unknown[]) => void;
}

export async function proxyWebSocketUpgrade(req: Request, server: any, path: string, pathname: string, opts: WsProxyOptions): Promise<Response> {
  const affinityKey = opts.cacheAffinity.keyFromRequest(req);
  const tried: AuthEntry[] = [];
  let lastStatus = 0;
  let lastText = "";

  for (let attempt = 0; attempt < opts.authStore.maxCredentialAttempts(); attempt++) {
    const a = opts.cacheAffinity.choose(affinityKey, tried) ?? opts.authStore.choose(tried);
    if (!a) break;
    tried.push(a);

    try {
      await opts.authStore.ensureFresh(a);
    } catch (err) {
      lastStatus = 401;
      lastText = String(err);
      a.coolingUntil = Date.now() + opts.cooldownMs;
      opts.log(`cooling ${a.label} after websocket refresh failure: ${lastText}`);
      continue;
    }

    const connected = await connectUpstreamWebSocket(req, a, path, pathname, opts);
    if (!connected.ok) {
      lastStatus = connected.status;
      lastText = connected.detail;
      a.coolingUntil = Date.now() + cooldownMsForFailure(connected.status, opts.cooldownMs);
      opts.log(`cooling ${a.label} after websocket connect failure: ${connected.detail}`);
      continue;
    }

    connected.data.cacheAffinityKey = affinityKey;
    connected.data.frameCacheAffinityBound = !!affinityKey;
    const ok = server.upgrade(req, {
      data: connected.data,
      headers: opts.exposeRotationHeaders ? {
        "x-cd-proxy-auth-label": a.label,
        ...(a.data.account_id ? { "x-cd-proxy-auth-account-prefix": a.data.account_id.slice(0, 5) } : {}),
        "x-cd-proxy-attempt": String(attempt),
        "x-cd-proxy-next-rr-index": String(opts.authStore.rrIndex),
      } : undefined,
    });
    if (!ok) {
      try { connected.data.upstream.close(); } catch {}
      return staticJsonResponse(WS_UPGRADE_FAILED_BODY, 400);
    }
    opts.cacheAffinity.bind(affinityKey, a);
    opts.debugCapture.saveWebSocketHandshake(req, pathname, connected.data.upstreamUrl, affinityKey, a.label, a.path, attempt);
    opts.transportStats.responsesWebSocketUpgrades++;
    return undefined as any;
  }

  return jsonResponse({ error: { message: "all codex websocket credentials failed or are cooling down", status: lastStatus, detail: lastText.slice(0, 1000) } }, { status: lastStatus || 503 });
}

export function handleClientWebSocketMessage(ws: ServerWebSocket<WsProxyData>, message: string | Buffer, cacheAffinity: CacheAffinityStore, debugCapture: DebugRequestCapture) {
  let frameAffinityKey: string | undefined;
  if (!ws.data.frameCacheAffinityBound) {
    ws.data.frameCacheAffinityBound = true;
    frameAffinityKey = cacheAffinity.keyFromPayload(message);
    if (frameAffinityKey) {
      ws.data.cacheAffinityKey = frameAffinityKey;
      cacheAffinity.bindByPath(frameAffinityKey, ws.data.authPath);
    }
  }
  debugCapture.saveWebSocketClientMessage(ws.data, message, frameAffinityKey);
  if (ws.data.upstreamOpen) ws.data.upstream.send(message as any);
  else ws.data.queue.push(message as any);
}

function buildWebSocketHeaders(req: Request, a: AuthEntry): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [name, value] of req.headers) {
    switch (name) {
      case "host":
      case "connection":
      case "upgrade":
      case "content-length":
      case "authorization":
      case "chatgpt-account-id":
      case "sec-websocket-key":
      case "sec-websocket-version":
      case "sec-websocket-extensions":
      case "sec-websocket-protocol":
        continue;
      default:
        h[name] = value;
    }
  }
  h.authorization = `Bearer ${a.data.access_token}`;
  if (a.data.account_id) h["ChatGPT-Account-ID"] = a.data.account_id;
  return h;
}

function websocketUrlForPath(path: string, opts: WsProxyOptions): string {
  return path === "responses" ? opts.upstreamWsUrl : `${opts.wsBase}/${path}`;
}

async function connectUpstreamWebSocket(req: Request, a: AuthEntry, path: string, pathname: string, opts: WsProxyOptions): Promise<{ ok: true; data: WsProxyData } | { ok: false; status: number; detail: string }> {
  const upstreamUrl = websocketUrlForPath(path, opts);
  let upstream: WebSocket;
  try {
    upstream = new WebSocket(upstreamUrl, { headers: buildWebSocketHeaders(req, a) });
  } catch (err) {
    return { ok: false, status: 502, detail: String(err) };
  }
  upstream.binaryType = "arraybuffer";

  const data: WsProxyData = { upstream, upstreamOpen: false, queue: [], downstreamQueue: [], authPath: a.path, authLabel: a.label, pathname, upstreamUrl, frameCacheAffinityBound: false };
  const opened = await new Promise<{ ok: true } | { ok: false; status: number; detail: string }>((resolve) => {
    let settled = false;
    const finish = (result: { ok: true } | { ok: false; status: number; detail: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { upstream.close(); } catch {}
      finish({ ok: false, status: 504, detail: `upstream websocket did not open within ${opts.connectTimeoutMs}ms` });
    }, Math.max(1, opts.connectTimeoutMs));

    upstream.addEventListener("open", () => {
      opts.transportStats.responsesWebSocketUpstreamOpens++;
      data.upstreamOpen = true;
      opts.log(`WS ${pathname} -> ${upstreamUrl} as ${a.label}`);
      for (const msg of data.queue.splice(0)) upstream.send(msg as any);
      finish({ ok: true });
    });
    upstream.addEventListener("message", (event: MessageEvent) => {
      const payload = event.data;
      const client = (upstream as any).__client;
      if (client) client.send(payload as any);
      else data.downstreamQueue.push(payload as any);
      if (isTerminalResponseEventPayload(payload, opts.zigCore())) opts.transportStats.responsesWebSocketTerminalEvents++;
    });
    upstream.addEventListener("close", (event: CloseEvent) => {
      if (!data.upstreamOpen) {
        finish({ ok: false, status: 502, detail: `upstream websocket closed before open: ${event.code || 1006} ${event.reason || ""}`.trim() });
        return;
      }
      const client = (upstream as any).__client;
      try { client?.close(event.code || 1000, event.reason || undefined); } catch {}
    });
    upstream.addEventListener("error", () => {
      if (!data.upstreamOpen) {
        finish({ ok: false, status: 502, detail: "upstream websocket error before open" });
        return;
      }
      const client = (upstream as any).__client;
      try { client?.close(1011, "upstream websocket error"); } catch {}
    });
  });

  if (!opened.ok) {
    try { upstream.close(); } catch {}
    return opened;
  }
  return { ok: true, data };
}

function compactTerminalTypeText(text: string): boolean | undefined {
  if (text.startsWith('{"type":"response.completed"') || text.startsWith('{"type":"response.done"') || text.startsWith('{"type":"response.incomplete"')) return true;
  if (text.startsWith(COMPACT_ROOT_TYPE_PREFIX)) return false;
  return undefined;
}

function isTerminalResponseEventText(text: string): boolean {
  const compact = compactTerminalTypeText(text);
  if (compact !== undefined) return compact;
  if (!text.includes("response.completed") && !text.includes("response.done") && !text.includes("response.incomplete")) return false;
  try {
    const parsed = JSON.parse(text);
    return parsed?.type === "response.completed" || parsed?.type === "response.done" || parsed?.type === "response.incomplete";
  } catch {
    return false;
  }
}

function isTerminalResponseEventPayload(payload: unknown, zigCore: ZigCore | undefined): boolean {
  if (typeof payload === "string") return isTerminalResponseEventText(payload);
  if (zigCore?.cdproxy_is_terminal_response_event) {
    const bytes = payloadBytes(payload);
    if (bytes) {
      const p = ptr(bytes);
      if (p) return !!zigCore.cdproxy_is_terminal_response_event(p as any, bytes.byteLength);
    }
  }
  let text: string | undefined;
  if (payload instanceof ArrayBuffer) text = utf8Decoder.decode(new Uint8Array(payload));
  else if (ArrayBuffer.isView(payload)) text = utf8Decoder.decode(payload as Uint8Array);
  if (!text) return false;
  return isTerminalResponseEventText(text);
}
