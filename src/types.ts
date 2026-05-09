export interface CodexAuthFile {
  type?: string;
  email?: string;
  account_id?: string;
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expired?: string;
  last_refresh?: string;
  disabled?: boolean;
}

export interface AuthEntry {
  path: string;
  label: string;
  data: CodexAuthFile;
  expiresAtMs?: number;
  coolingUntil: number;
  refreshInFlight?: Promise<void>;
}

export interface CacheAffinityEntry {
  authPath: string;
  expiresAt: number;
  lastUsed: number;
}

export interface TransportStats {
  responsesHttpRequests: number;
  responsesWebSocketUpgrades: number;
  responsesWebSocketUpstreamOpens: number;
  responsesWebSocketTerminalEvents: number;
}

export interface WsProxyData {
  upstream: WebSocket;
  upstreamOpen: boolean;
  queue: Array<string | ArrayBuffer | Uint8Array>;
  downstreamQueue: Array<string | ArrayBuffer | Uint8Array>;
  authPath: string;
  authLabel: string;
  pathname: string;
  upstreamUrl: string;
  cacheAffinityKey?: string;
  frameCacheAffinityBound: boolean;
}
