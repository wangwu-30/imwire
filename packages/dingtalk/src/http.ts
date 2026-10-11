import { asNumber, asRecord, asString } from "./util.js";

export type DingTalkFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface DingTalkRequestOpts {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Skip access-token (sessionWebhook is a signed URL). */
  anonymous?: boolean;
}

export interface DingTalkHttp {
  request<T>(opts: DingTalkRequestOpts): Promise<T>;
}

export class DingTalkApiError extends Error {
  readonly status: number;
  readonly code?: string | number;
  readonly retryable: boolean;
  readonly retryAfter?: number;

  constructor(message: string, status: number, code?: string | number, retryAfter?: number) {
    super(message);
    this.name = "DingTalkApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.retryable = status === 429 || (status >= 500 && status < 600);
  }
}

export interface DingTalkHttpOptions {
  clientId: string;
  clientSecret: string;
  fetch?: DingTalkFetch;
  apiBase?: string;
  now?: () => number;
}

const DEFAULT_API = "https://api.dingtalk.com";

export function createDingTalkHttp(opts: DingTalkHttpOptions): DingTalkHttp {
  const fetchFn = opts.fetch ?? fetch;
  const base = opts.apiBase ?? DEFAULT_API;
  const now = opts.now ?? Date.now;
  let token: { value: string; expiresAt: number } | undefined;

  const getToken = async (signal?: AbortSignal): Promise<string> => {
    if (token && token.expiresAt - 30_000 > now()) return token.value;
    const res = await fetchFn(`${base}/v1.0/oauth2/accessToken`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appKey: opts.clientId, appSecret: opts.clientSecret }),
      signal,
    });
    const json = asRecord(await res.json().catch(() => undefined));
    const value = asString(json?.accessToken) ?? asString(json?.access_token);
    if (!value) {
      throw new DingTalkApiError(asString(json?.message) ?? "dingtalk token failed", res.status);
    }
    const expireSec = asNumber(json?.expireIn) ?? asNumber(json?.expire_in) ?? 7200;
    token = { value, expiresAt: now() + expireSec * 1000 };
    return value;
  };

  const buildUrl = (path: string, query?: Record<string, string>): URL => {
    const url = new URL(path.startsWith("http") ? path : `${base}${path.startsWith("/") ? path : `/${path}`}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    }
    return url;
  };

  return {
    async request<T>(req: DingTalkRequestOpts): Promise<T> {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...req.headers,
      };
      if (!req.anonymous) {
        headers["x-acs-dingtalk-access-token"] = await getToken(req.signal);
      }
      const res = await fetchFn(buildUrl(req.path, req.query), {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: req.signal,
      });
      const json: unknown = await res.json().catch(() => undefined);
      const rec = asRecord(json);
      const code = rec?.errcode ?? rec?.code;
      const okCode = code === undefined || code === 0 || code === "0";
      if (!res.ok || !okCode) {
        throw new DingTalkApiError(
          asString(rec?.errmsg) ?? asString(rec?.message) ?? `dingtalk ${req.method} ${req.path} failed`,
          res.status,
          typeof code === "string" || typeof code === "number" ? code : undefined,
        );
      }
      return (rec ?? {}) as T;
    },
  };
}
