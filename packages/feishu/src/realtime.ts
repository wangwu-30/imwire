export interface FeishuRealtimeHandlers {
  onEvent: (raw: unknown, eventType?: string) => Promise<void>;
}

export interface FeishuRealtime {
  start(handlers: FeishuRealtimeHandlers, signal: AbortSignal): Promise<void>;
  isAlive(): boolean;
  stop(): void;
}

export interface SdkRealtimeOptions {
  appId: string;
  appSecret: string;
  domain?: "feishu" | "lark";
}

type WsLike = {
  start: (opts: { eventDispatcher: unknown }) => Promise<void> | void;
  close?: () => void;
  getConnectionStatus?: () => string | number;
};

/**
 * Official `@larksuiteoapi/node-sdk` long connection. Loaded lazily so mapping
 * tests never touch the network or the SDK constructor.
 *
 * `WSClient.start()` resolves immediately and keeps its own reconnect loop.
 * This wrapper therefore:
 * - creates **one** client
 * - does not treat `start()` resolving as a disconnect
 * - waits until abort or a terminal start() rejection
 * - acks card callbacks without awaiting user handlers (3 s deadline)
 */
export async function createSdkRealtime(opts: SdkRealtimeOptions): Promise<FeishuRealtime> {
  const mod = (await import("@larksuiteoapi/node-sdk")) as unknown as {
    default?: unknown;
    EventDispatcher: new (opts: Record<string, never>) => {
      register: (handlers: Record<string, (data: unknown) => Promise<unknown>>) => unknown;
    };
    WSClient: new (opts: { appId: string; appSecret: string; domain?: unknown }) => WsLike;
    Domain?: { Lark?: unknown; Feishu?: unknown };
  };
  const Lark = (mod.default ?? mod) as typeof mod;
  const domain = opts.domain === "lark" ? Lark.Domain?.Lark : Lark.Domain?.Feishu;

  let client: WsLike | undefined;
  let closed = true;

  const closeClient = (): void => {
    closed = true;
    const current = client;
    client = undefined;
    try {
      current?.close?.();
    } catch {
      // ignore
    }
  };

  const statusAlive = (): boolean => {
    if (closed || !client) return false;
    const status = client.getConnectionStatus?.();
    if (status === undefined) return true;
    const s = String(status).toLowerCase();
    return s !== "closed" && s !== "failed" && s !== "close" && s !== "0";
  };

  return {
    isAlive: statusAlive,
    stop() {
      closeClient();
    },
    async start(handlers, signal) {
      const dispatch = (data: unknown, type: string): void => {
        void Promise.resolve(handlers.onEvent(data, type)).catch(() => undefined);
      };

      const dispatcher = new Lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data: unknown) => {
          dispatch(data, "im.message.receive_v1");
        },
        "card.action.trigger": async (data: unknown) => {
          dispatch(data, "card.action.trigger");
          return {
            toast: { type: "info", content: "OK" },
          };
        },
        "im.message.reaction.created_v1": async (data: unknown) => {
          dispatch(data, "im.message.reaction.created_v1");
        },
        "im.message.reaction.deleted_v1": async (data: unknown) => {
          dispatch(data, "im.message.reaction.deleted_v1");
        },
      });

      const wsOpts: { appId: string; appSecret: string; domain?: unknown } = {
        appId: opts.appId,
        appSecret: opts.appSecret,
      };
      if (domain !== undefined) wsOpts.domain = domain;

      closeClient();
      closed = false;
      client = new Lark.WSClient(wsOpts);

      const aborted = new Promise<void>((resolve) => {
        const onAbort = (): void => {
          closeClient();
          resolve();
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });

      try {
        const started = Promise.resolve(client.start({ eventDispatcher: dispatcher }));
        await Promise.race([
          aborted,
          started.then(
            () => aborted,
            (err: unknown) => {
              closeClient();
              throw err;
            },
          ),
        ]);
      } finally {
        closeClient();
      }
    },
  };
}
