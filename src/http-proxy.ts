import type { AuthEntry, TransportStats } from "./types";
import { AuthStore } from "./auth-store";
import { CacheAffinityStore } from "./cache-affinity";
import { DebugRequestCapture } from "./debug-capture";

const JSON_HEADERS = { "content-type": "application/json" } as const;

interface HttpProxyOptions {
  authStore: AuthStore;
  cacheAffinity: CacheAffinityStore;
  debugCapture: DebugRequestCapture;
  transportStats: TransportStats;
  upstreamResponsesUrl: string;
  upstreamResponsesCompactUrl: string;
  retryableHttpStatuses: Set<number>;
  cooldownMs: number;
  log: (...args: unknown[]) => void;
}

export function jsonResponse(value: unknown, init?: ResponseInit) {
  return jsonTextResponse(JSON.stringify(value, null, 2), init);
}

export function jsonTextResponse(body: string, init?: ResponseInit) {
  if (!init) return new Response(body, { headers: JSON_HEADERS });
  return new Response(body, { ...init, headers: { ...JSON_HEADERS, ...(init.headers ?? {}) } });
}

export function staticJsonResponse(body: string, status: number) {
  return new Response(body, { status, headers: JSON_HEADERS });
}

export function withRotationHeaders(res: Response, a: AuthEntry, attempt: number, expose: boolean, home: string, rrIndex: number, authCount: number): Response {
  if (!expose) return res;
  const headers = new Headers(res.headers);
  headers.set("x-cd-proxy-auth-label", a.label);
  if (a.data.account_id) headers.set("x-cd-proxy-auth-account-prefix", a.data.account_id.slice(0, 5));
  headers.set("x-cd-proxy-auth-file", a.path.replace(home, "~"));
  headers.set("x-cd-proxy-attempt", String(attempt));
  headers.set("x-cd-proxy-next-rr-index", String(rrIndex % Math.max(1, authCount)));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export async function proxyWithRotation(req: Request, path: string, pathname: string, opts: HttpProxyOptions, exposeHeaders: boolean, home: string): Promise<Response> {
  if (path === "responses" || path === "responses/compact") opts.transportStats.responsesHttpRequests++;
  const tried: AuthEntry[] = [];
  let lastStatus = 0;
  let lastText = "";
  const requestBody = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const affinityKey = opts.cacheAffinity.keyFromRequest(req) ?? opts.cacheAffinity.keyFromPayload(requestBody);
  const upstream = path === "responses/compact" ? opts.upstreamResponsesCompactUrl : opts.upstreamResponsesUrl;
  opts.debugCapture.saveHttpRequest(req, pathname, path, affinityKey, requestBody);

  for (let attempt = 0; attempt < opts.authStore.maxCredentialAttempts(); attempt++) {
    const a = opts.cacheAffinity.choose(affinityKey, tried) ?? opts.authStore.choose(tried);
    if (!a) break;
    tried.push(a);
    try {
      await opts.authStore.ensureFresh(a);
      opts.log(`${req.method} ${pathname} -> ${upstream} as ${a.label}`);
      const res = await fetch(upstream, { method: req.method, headers: buildHeaders(req, a), body: requestBody, duplex: "half" } as any);

      if (res.status === 401) {
        lastStatus = res.status;
        lastText = await res.text().catch(() => "");
        try {
          await opts.authStore.refresh(a);
          const retry = await fetch(upstream, { method: req.method, headers: buildHeaders(req, a), body: requestBody, duplex: "half" } as any);
          if (!isRetryableHttpStatus(retry.status, opts.retryableHttpStatuses)) {
            opts.cacheAffinity.bind(affinityKey, a);
            return withRotationHeaders(retry, a, attempt, exposeHeaders, home, opts.authStore.rrIndex, opts.authStore.auths.length);
          }
          lastStatus = retry.status;
          lastText = await retry.text().catch(() => "");
        } catch (err) {
          lastText = String(err);
        }
        a.coolingUntil = Date.now() + opts.cooldownMs;
        opts.log(`cooling ${a.label} after 401/refresh retry failure: ${lastStatus} ${lastText.slice(0, 160)}`);
        continue;
      }

      if (isRetryableHttpStatus(res.status, opts.retryableHttpStatuses)) {
        lastStatus = res.status;
        lastText = await res.text().catch(() => "");
        a.coolingUntil = Date.now() + cooldownMsForFailure(res.status, opts.cooldownMs);
        opts.log(`cooling ${a.label} after retryable upstream status ${res.status}: ${lastText.slice(0, 160)}`);
        continue;
      }

      opts.cacheAffinity.bind(affinityKey, a);
      return withRotationHeaders(res, a, attempt, exposeHeaders, home, opts.authStore.rrIndex, opts.authStore.auths.length);
    } catch (err) {
      lastStatus = 502;
      lastText = String(err);
      a.coolingUntil = Date.now() + cooldownMsForFailure(502, opts.cooldownMs);
      opts.log(`cooling ${a.label} after upstream fetch failure: ${lastText.slice(0, 160)}`);
    }
  }

  return jsonResponse({ error: { message: "all codex credentials failed or are cooling down", status: lastStatus, detail: lastText.slice(0, 1000) } }, { status: lastStatus || 503 });
}

function buildHeaders(req: Request, a: AuthEntry): Headers {
  const h = new Headers(req.headers);
  h.delete("host");
  h.delete("connection");
  h.delete("content-length");
  h.set("authorization", `Bearer ${a.data.access_token}`);
  h.set("content-type", req.headers.get("content-type") ?? "application/json");
  if (a.data.account_id) h.set("ChatGPT-Account-ID", a.data.account_id);
  if (!h.has("accept") && req.method !== "GET") h.set("accept", "text/event-stream");
  return h;
}

function isRetryableHttpStatus(status: number, retryable: Set<number>): boolean {
  return status >= 400 && retryable.has(status);
}

export function cooldownMsForFailure(status: number, cooldownMs: number): number {
  if (status === 401 || status === 403 || status === 429) return cooldownMs;
  return Math.min(cooldownMs, 5000);
}
