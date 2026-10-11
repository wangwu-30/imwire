import { WECOM_WS_URL } from "./capabilities.js";
import { asNumber, asRecord, asString, newId } from "./util.js";

export interface WecomFrame {
  cmd?: string;
  headers?: { req_id?: string };
  body?: unknown;
}

export interface WecomTransport {
  send(frame: WecomFrame): Promise<unknown>;
  start(onFrame: (frame: unknown) => Promise<void>, signal: AbortSignal): Promise<void>;
  isAlive(): boolean;
  stop(): void;
}

export interface RawWecomOptions {
  botId: string;
  secret: string;
  url?: string;
  WebSocketImpl?: new (url: string) => MinimalWs;
  pingMs?: number;
}

export interface MinimalWs {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  addEventListener?: (event: string, listener: (ev: { data?: unknown }) => void) => void;
  send: (data: string) => void;
  close: () => void;
}

/**
 * WeCom 智能机器人 long-connection.
 * wss://openws.work.weixin.qq.com then aibot_subscribe { bot_id, secret }.
 * https://developer.work.weixin.qq.com/document/path/101463
 */
export function createRawWecomTransport(opts: RawWecomOptions): WecomTransport {
  let alive = false;
  let socket: MinimalWs | undefined;
  const pending = new Map<string, (value: unknown) => void>();

  const send = async (frame: WecomFrame): Promise<unknown> => {
    const reqId = frame.headers?.req_id ?? newId("req");
    const payload = { ...frame, headers: { ...frame.headers, req_id: reqId } };
    if (!socket) throw new Error("wecom transport is not connected");
    const wait = new Promise<unknown>((resolve) => {
      pending.set(reqId, resolve);
    });
    socket.send(JSON.stringify(payload));
    return wait;
  };

  return {
    send,
    isAlive: () => alive,
    stop() {
      alive = false;
      socket?.close();
      socket = undefined;
    },
    async start(onFrame, signal) {
      const WS = opts.WebSocketImpl ?? (await loadWs());
      const ws = new WS(opts.url ?? WECOM_WS_URL);
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
        const reqId = asString(asRecord(frame.headers)?.req_id);
        const waiter = reqId ? pending.get(reqId) : undefined;
        if (waiter && asNumber(frame.errcode) !== undefined && !asString(frame.cmd)) {
          pending.delete(reqId!);
          waiter(frame);
          return;
        }
        await onFrame(frame);
      };

      const ping = setInterval(() => {
        if (!alive || !socket) return;
        try {
          socket.send(JSON.stringify({ cmd: "ping", headers: { req_id: newId("ping") }, body: {} }));
        } catch {
          // ignore
        }
      }, opts.pingMs ?? 30_000);

      await new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          clearInterval(ping);
          alive = false;
          resolve();
        };
        const onOpen = (): void => {
          void send({
            cmd: "aibot_subscribe",
            headers: { req_id: newId("sub") },
            body: { bot_id: opts.botId, secret: opts.secret },
          }).catch(reject);
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
          open: onOpen,
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
  handlers: {
    open: () => void;
    message: (data: unknown) => void;
    error: (err: unknown) => void;
    close: () => void;
  },
): void {
  if (typeof ws.on === "function") {
    ws.on("open", handlers.open);
    ws.on("message", handlers.message);
    ws.on("error", handlers.error);
    ws.on("close", handlers.close);
    return;
  }
  ws.addEventListener?.("open", () => handlers.open());
  ws.addEventListener?.("message", (ev) => handlers.message(ev.data));
  ws.addEventListener?.("error", (ev) => handlers.error(ev));
  ws.addEventListener?.("close", () => handlers.close());
}

async function loadWs(): Promise<new (url: string) => MinimalWs> {
  const mod = (await import("ws")) as unknown as { default?: new (url: string) => MinimalWs };
  return (mod.default ?? (mod as unknown as new (url: string) => MinimalWs)) as new (url: string) => MinimalWs;
}
