import { TOPIC_CARD, TOPIC_ROBOT } from "./capabilities.js";
import type { DingTalkHttp } from "./http.js";
import { asRecord, asString } from "./util.js";

export interface DingTalkStreamHandlers {
  onEvent: (raw: unknown, topic?: string) => Promise<void>;
}

export interface DingTalkStream {
  start(handlers: DingTalkStreamHandlers, signal: AbortSignal): Promise<void>;
  isAlive(): boolean;
  stop(): void;
}

export interface RawStreamOptions {
  clientId: string;
  clientSecret: string;
  http: DingTalkHttp;
  /** Injected WebSocket ctor (tests). Defaults to `ws`. */
  WebSocketImpl?: new (url: string) => MinimalWs;
}

export interface MinimalWs {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  addEventListener?: (event: string, listener: (ev: { data?: unknown }) => void) => void;
  send: (data: string) => void;
  close: () => void;
  readyState?: number;
}

/**
 * Official Stream protocol (same topics as `dingtalk-stream`):
 * POST /v1.0/gateway/connections/open then WS with ticket.
 * https://open.dingtalk.com/document/resourcedownload/introduction-to-stream-mode.md
 * Ping ack: echo the original `data` JSON *string* (contains `opaque`).
 * https://github.com/open-dingtalk/developerpedia/blob/main/docs/learn/stream/protocol.md
 */
export function createRawDingTalkStream(opts: RawStreamOptions): DingTalkStream {
  let alive = false;
  let socket: MinimalWs | undefined;
  let stopped = false;

  return {
    isAlive: () => alive,
    stop() {
      stopped = true;
      alive = false;
      socket?.close();
      socket = undefined;
    },
    async start(handlers, signal) {
      stopped = false;
      const opened = await opts.http.request<{ endpoint?: string; ticket?: string }>({
        method: "POST",
        path: "/v1.0/gateway/connections/open",
        anonymous: true,
        body: {
          clientId: opts.clientId,
          clientSecret: opts.clientSecret,
          ua: "imwire-dingtalk/0.1",
          subscriptions: [
            { type: "CALLBACK", topic: TOPIC_ROBOT },
            { type: "CALLBACK", topic: TOPIC_CARD },
          ],
        },
      });
      const endpoint = asString(opened.endpoint);
      const ticket = asString(opened.ticket);
      if (!endpoint || !ticket) throw new Error("dingtalk stream: connections/open missing endpoint/ticket");

      const WS = opts.WebSocketImpl ?? (await loadWs());
      const url = `${endpoint}${endpoint.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket)}`;
      const ws = new WS(url);
      socket = ws;
      alive = true;

      await new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          alive = false;
          if (socket === ws) socket = undefined;
          resolve();
        };
        const fail = (err: unknown): void => {
          alive = false;
          if (socket === ws) socket = undefined;
          reject(err instanceof Error ? err : new Error(String(err)));
        };

        const handleData = async (data: unknown): Promise<void> => {
          const text = typeof data === "string" ? data : data instanceof Buffer ? data.toString("utf8") : String(data);
          let frame: Record<string, unknown>;
          try {
            frame = asRecord(JSON.parse(text)) ?? {};
          } catch {
            return;
          }
          const type = asString(frame.type);
          const headers = asRecord(frame.headers);
          const messageId = asString(headers?.messageId);
          const topic = asString(headers?.topic);
          if (type === "SYSTEM" && topic === "ping") {
            const echoed = typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data ?? {});
            ack(ws, messageId, echoed);
            return;
          }
          if (type === "SYSTEM" && topic === "disconnect") {
            alive = false;
            ws.close();
            fail(new Error("dingtalk stream disconnect"));
            return;
          }
          if (type === "CALLBACK") {
            ack(ws, messageId, JSON.stringify({ response: {} }));
            await handlers.onEvent(frame, topic);
          }
        };

        if (signal.aborted || stopped) {
          ws.close();
          finish();
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            ws.close();
            finish();
          },
          { once: true },
        );
        attachWs(ws, {
          message: (data) => {
            void handleData(data);
          },
          error: (err) => fail(err),
          close: () => {
            if (alive) finish();
          },
        });
      });
    },
  };
}

function ack(ws: MinimalWs, messageId: string | undefined, data?: unknown): void {
  if (!messageId) return;
  try {
    ws.send(
      JSON.stringify({
        code: 200,
        headers: { messageId, contentType: "application/json" },
        message: "OK",
        data,
      }),
    );
  } catch {
    // socket already closed
  }
}

function attachWs(
  ws: MinimalWs,
  handlers: { message: (data: unknown) => void; error: (err: unknown) => void; close: () => void },
): void {
  if (typeof ws.on === "function") {
    ws.on("message", handlers.message);
    ws.on("error", handlers.error);
    ws.on("close", handlers.close);
    return;
  }
  ws.addEventListener?.("message", (ev) => handlers.message(ev.data));
  ws.addEventListener?.("error", (ev) => handlers.error(ev));
  ws.addEventListener?.("close", () => handlers.close());
}

async function loadWs(): Promise<new (url: string) => MinimalWs> {
  const mod = (await import("ws")) as unknown as { default?: new (url: string) => MinimalWs };
  return (mod.default ?? (mod as unknown as new (url: string) => MinimalWs)) as new (url: string) => MinimalWs;
}
