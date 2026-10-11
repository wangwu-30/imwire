import { asNumber, asRecord, asString } from "./util.js";

export type FeishuFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface FeishuRequestOpts {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

export interface FeishuHttp {
  request<T>(opts: FeishuRequestOpts): Promise<T>;
  requestBytes(opts: FeishuRequestOpts): Promise<Uint8Array>;
}

export class FeishuApiError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly retryable: boolean;
  /** Seconds, from `retry_after` / Retry-After. */
  readonly retryAfter?: number;

  constructor(message: string, status: number, code?: number, retryAfter?: number) {
    super(message);
    this.name = "FeishuApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.retryable = status === 429 || (status >= 500 && status < 600) || code === 99991400;
  }
}

export interface FeishuHttpOptions {
  appId: string;
  appSecret: string;
  domain?: "feishu" | "lark";
  /** Override Open API host (tests / reverse proxies). Default: open.feishu.cn or open.larksuite.com. */
  apiBase?: string;
  fetch?: FeishuFetch;
  now?: () => number;
}

const HOSTS = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
} as const;

export function createFeishuHttp(opts: FeishuHttpOptions): FeishuHttp {
  const fetchFn = opts.fetch ?? fetch;
  const base = (opts.apiBase ?? HOSTS[opts.domain ?? "feishu"]).replace(/\/$/, "");
  let token: { value: string; expiresAt: number } | undefined;
  const now = opts.now ?? Date.now;

  const tokenUrl = `${base}/open-apis/auth/v3/tenant_access_token/internal`;

  const getToken = async (signal?: AbortSignal): Promise<string> => {
    if (token && token.expiresAt - 30_000 > now()) return token.value;
    const res = await fetchFn(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: opts.appId, app_secret: opts.appSecret }),
      signal,
    });
    const json = asRecord(await res.json());
    const value = asString(json?.tenant_access_token);
    if (!value) {
      throw new FeishuApiError(
        asString(json?.msg) ?? "token failed",
        res.status,
        asNumber(json?.code),
        headerRetryAfter(res),
      );
    }
    token = { value, expiresAt: now() + (asNumber(json?.expire) ?? 7200) * 1000 };
    return value;
  };

  const buildUrl = (path: string, query?: Record<string, string>): URL => {
    const url = new URL(path.startsWith("http") ? path : `${base}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    }
    return url;
  };

  return {
    async request<T>(req: FeishuRequestOpts): Promise<T> {
      const { method, path, query, body, signal } = req;
      const access = await getToken(signal);
      const res = await fetchFn(buildUrl(path, query), {
        method,
        headers: {
          authorization: `Bearer ${access}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      const json: unknown = await res.json().catch(() => undefined);
      const rec = asRecord(json);
      const code = asNumber(rec?.code);
      const retryAfter = headerRetryAfter(res) ?? asNumber(rec?.retry_after) ?? asNumber(rec?.retryAfter);
      if (!res.ok || (code !== undefined && code !== 0)) {
        throw new FeishuApiError(
          asString(rec?.msg) ?? `feishu ${method} ${path} failed`,
          res.status,
          code,
          retryAfter,
        );
      }
      return (rec?.data ?? rec) as T;
    },
    async requestBytes(req: FeishuRequestOpts): Promise<Uint8Array> {
      const { method, path, query, signal } = req;
      const access = await getToken(signal);
      const res = await fetchFn(buildUrl(path, query), {
        method,
        headers: { authorization: `Bearer ${access}` },
        signal,
      });
      if (!res.ok) {
        throw new FeishuApiError(
          `feishu ${method} ${path} failed`,
          res.status,
          undefined,
          headerRetryAfter(res),
        );
      }
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

function headerRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get("retry-after") ?? res.headers.get("Retry-After");
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
