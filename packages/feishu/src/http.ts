import { asNumber, asRecord, asString } from "./util.js";

export type FeishuFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface FeishuHttp {
  request<T>(opts: {
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
  }): Promise<T>;
}

export class FeishuApiError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, code?: number) {
    super(message);
    this.name = "FeishuApiError";
    this.status = status;
    this.code = code;
    this.retryable = status === 429 || (status >= 500 && status < 600) || code === 99991400;
  }
}

export interface FeishuHttpOptions {
  appId: string;
  appSecret: string;
  domain?: "feishu" | "lark";
  fetch?: FeishuFetch;
  now?: () => number;
}

const HOSTS = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
} as const;

export function createFeishuHttp(opts: FeishuHttpOptions): FeishuHttp {
  const fetchFn = opts.fetch ?? fetch;
  const base = HOSTS[opts.domain ?? "feishu"];
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
      throw new FeishuApiError(asString(json?.msg) ?? "token failed", res.status, asNumber(json?.code));
    }
    token = { value, expiresAt: now() + (asNumber(json?.expire) ?? 7200) * 1000 };
    return value;
  };

  return {
    async request<T>(opts: {
      method: string;
      path: string;
      query?: Record<string, string>;
      body?: unknown;
      signal?: AbortSignal;
    }): Promise<T> {
      const { method, path, query, body, signal } = opts;
      const url = new URL(path.startsWith("http") ? path : `${base}${path}`);
      if (query) {
        for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
      }
      const access = await getToken(signal);
      const res = await fetchFn(url, {
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
      if (!res.ok || (code !== undefined && code !== 0)) {
        throw new FeishuApiError(
          asString(rec?.msg) ?? `feishu ${method} ${path} failed`,
          res.status,
          code,
        );
      }
      return (rec?.data ?? rec) as T;
    },
  };
}
