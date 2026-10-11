import { WECOM_WS_URL } from "./capabilities.js";
import { WecomApiError } from "./errors.js";
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
  stop(reason?: string): void;
}

export interface RawWecomOptions {
  botId: string;
  secret: string;
  url?: string;
  WebSocketImpl?: new (url: string) => MinimalWs;
  pingMs?: number;
  requestTimeoutMs?: number;
}

export interface MinimalWs {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  addEventListener?: (event: string, listener: (ev: { data?: unknown }) => void) => void;
  send: (data: string) => void;
  close: () => void;
}

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void };

/**
 * WeCom 智能机器人 long-connection.
 * wss://openws.work.weixin.qq.com then aibot_subscribe { bot_id, secret }.
 * https://developer.work.weixin.qq.com/document/path/101463
 */
export function createRawWecomTransport(opts: RawWecomOptions): WecomTransport {
  let alive = false;
  let socket: MinimalWs | undefined;
  const pending = new Map<string, Pending>();
  let endStart: ((err?: Error) => void) | undefined;

  const rejectAll = (err: Error): void => {
    for (const waiter of pending.values()) waiter.reject(err);
    pending.clear();
  };

  const send = async (frame: WecomFrame): Promise<unknown> => {
    const reqId = frame.headers?.req_id ?? newId("req");
    const payload = { ...frame, headers: { ...frame.headers, req_id: reqId } };
    if (!socket || !alive) throw new Error("wecom transport is not connected");
    const wait = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new WecomApiError("wecom request timed out", -1));
      }, opts.requestTimeoutMs ?? 15_000);
      pending.set(reqId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
    socket.send(JSON.stringify(payload));
    return wait;
  };

  const teardown = (err?: Error): void => {
    const current = socket;
    alive = false;
    socket = undefined;
    rejectAll(err ?? new Error("wecom transport closed"));
    const end = endStart;
    endStart = undefined;
    end?.(err);
    current?.close();
  };

  return {
    send,
    isAlive: () => alive,
    stop(reason) {
      teardown(new Error(reason ?? "wecom transport closed"));
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
          const code = asNumber(frame.errcode) ?? 0;
          if (code !== 0) {
            waiter.reject(new WecomApiError(asString(frame.errmsg) ?? `wecom errcode ${code}`, code));
          } else {
            waiter.resolve(frame);
          }
          return;
        }
        try {
          await onFrame(frame);
        } catch {
          // adapter may stop() on disconnected_event
        }
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
        let settled = false;
        endStart = (err) => {
          clearInterval(ping);
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve();
        };
        const finish = (): void => teardown();
        const fail = (err: unknown): void => {
          teardown(err instanceof Error ? err : new Error(String(err)));
        };
        const onOpen = (): void => {
          void send({
            cmd: "aibot_subscribe",
            headers: { req_id: newId("sub") },
            body: { bot_id: opts.botId, secret: opts.secret },
          }).then(
            () => undefined,
            (err: unknown) => fail(err),
          );
        };
        if (signal.aborted) {
          finish();
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            finish();
          },
          { once: true },
        );
        attachWs(ws, {
          open: onOpen,
          message: (data) => {
            void handleData(data);
          },
          error: (err) => fail(err),
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
