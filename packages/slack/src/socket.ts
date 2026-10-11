import type { SlackWeb } from "./api.js";
import { asRecord, asString } from "./util.js";

export interface SlackSocketHandlers {
  onEnvelope: (raw: unknown) => Promise<void>;
}

export interface SlackSocket {
  start(handlers: SlackSocketHandlers, signal: AbortSignal): Promise<void>;
  ack(envelopeId: string, payload?: unknown): Promise<void>;
  isAlive(): boolean;
  stop(): void;
}

export interface RawSocketOptions {
  web: SlackWeb;
  WebSocketImpl?: new (url: string) => MinimalWs;
}

export interface MinimalWs {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  addEventListener?: (event: string, listener: (ev: { data?: unknown }) => void) => void;
  send: (data: string) => void;
  close: () => void;
}

/**
 * Socket Mode without Bolt:
 * POST apps.connections.open (app token) → wss URL, then ack each envelope_id.
 * https://docs.slack.dev/apis/events-api/using-socket-mode
 */
export function createRawSlackSocket(opts: RawSocketOptions): SlackSocket {
  let alive = false;
  let socket: MinimalWs | undefined;

  return {
    isAlive: () => alive,
    stop() {
      alive = false;
      socket?.close();
      socket = undefined;
    },
    async ack(envelopeId, payload) {
      if (!socket) return;
      const frame: Record<string, unknown> = { envelope_id: envelopeId };
      if (payload !== undefined) frame.payload = payload;
      socket.send(JSON.stringify(frame));
    },
    async start(handlers, signal) {
      const opened = await opts.web.call<{ url?: string }>("apps.connections.open", {}, "app");
      const url = asString(opened.url);
      if (!url) throw new Error("slack socket: apps.connections.open returned no url");
      const WS = opts.WebSocketImpl ?? (await loadWs());
      const ws = new WS(url);
      socket = ws;
      alive = true;

      const handleData = async (data: unknown): Promise<void> => {
        const text = typeof data === "string" ? data : data instanceof Buffer ? data.toString("utf8") : String(data);
        let frame: Record<string, unknown>;
        try {
          frame = asRecord(JSON.parse(text)) ?? {};
        } catch {
          return;
        }
        const type = asString(frame.type);
        if (type === "hello") return;
        if (type === "disconnect") {
          const reason = asString(frame.reason);
          // https://docs.slack.dev/apis/events-api/using-socket-mode#disconnect
          if (reason === "warning") return;
          if (reason === "link_disabled") {
            alive = false;
            return;
          }
          ws.close();
          return;
        }
        await handlers.onEnvelope(frame);
      };

      await new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          alive = false;
          resolve();
        };
        if (signal.aborted) {
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
          error: (err) => {
            alive = false;
            reject(err instanceof Error ? err : new Error(String(err)));
          },
          close: () => finish(),
        });
      });
    },
  };
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
