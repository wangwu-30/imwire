import { asNumber, asRecord, asString } from "./util.js";

export type TelegramFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface TelegramApiOptions {
  token: string;
  fetch?: TelegramFetch;
  baseUrl?: string;
}

export class TelegramApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfter?: number;

  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.name = "TelegramApiError";
    this.status = status;
    this.retryable = status === 429 || (status >= 500 && status < 600);
    this.retryAfter = retryAfter;
  }
}

export class TelegramApi {
  readonly token: string;
  private readonly fetchFn: TelegramFetch;
  readonly baseUrl: string;

  constructor(opts: TelegramApiOptions) {
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? fetch;
    this.baseUrl = (opts.baseUrl ?? "https://api.telegram.org").replace(/\/$/, "");
  }

  async call<T>(method: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const url = `${this.baseUrl}/bot${this.token}/${method}`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal,
    });
    const json: unknown = await res.json();
    const rec = asRecord(json);
    if (!rec || rec.ok !== true) {
      const description = asString(rec?.description) ?? `telegram ${method} failed`;
      const status = asNumber(rec?.error_code) ?? res.status;
      const retryAfter = asNumber(asRecord(rec?.parameters)?.retry_after);
      throw new TelegramApiError(description, status, retryAfter);
    }
    return rec.result as T;
  }

  async downloadFile(filePath: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const url = `${this.baseUrl}/file/bot${this.token}/${filePath}`;
    const res = await this.fetchFn(url, { signal });
    if (!res.ok || !res.body) {
      throw new TelegramApiError(`download failed: ${res.status}`, res.status);
    }
    return res.body;
  }
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat?: { id: number; type?: string };
}
