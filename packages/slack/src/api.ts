import { asRecord, asString } from "./util.js";

export type SlackFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SlackWeb {
  call<T = Record<string, unknown>>(method: string, body?: Record<string, unknown>, token?: "bot" | "app"): Promise<T>;
}

export class SlackApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryable: boolean;
  readonly retryAfter?: number;

  constructor(message: string, status: number, code?: string, retryAfter?: number) {
    super(message);
    this.name = "SlackApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.retryable = status === 429 || (status >= 500 && status < 600);
  }
}

export interface SlackWebOptions {
  botToken: string;
  appToken?: string;
  fetch?: SlackFetch;
  apiBase?: string;
}

export function createSlackWeb(opts: SlackWebOptions): SlackWeb {
  const fetchFn = opts.fetch ?? fetch;
  const base = opts.apiBase ?? "https://slack.com/api";

  return {
    async call<T>(method: string, body: Record<string, unknown> = {}, token: "bot" | "app" = "bot"): Promise<T> {
      const bearer = token === "app" ? opts.appToken : opts.botToken;
      if (!bearer) throw new SlackApiError(`missing ${token} token for ${method}`, 401);
      const res = await fetchFn(`${base}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
      const json = asRecord(await res.json().catch(() => undefined));
      if (!res.ok || json?.ok === false) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "") || undefined;
        throw new SlackApiError(
          asString(json?.error) ?? `slack ${method} failed`,
          res.status,
          asString(json?.error),
          retryAfter,
        );
      }
      return (json ?? {}) as T;
    },
  };
}
