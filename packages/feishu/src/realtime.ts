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
};

/**
 * Official `@larksuiteoapi/node-sdk` long connection. Loaded lazily so mapping
 * tests never touch the network or the SDK constructor.
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

  let alive = false;
  let client: WsLike | undefined;

  return {
    isAlive: () => alive,
    stop() {
      alive = false;
      try {
        client?.close?.();
      } catch {
        // ignore
      }
    },
    async start(handlers, signal) {
      const dispatcher = new Lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data: unknown) => {
          await handlers.onEvent(data, "im.message.receive_v1");
        },
        "card.action.trigger": async (data: unknown) => {
          await handlers.onEvent(data, "card.action.trigger");
          return {
            toast: { type: "info", content: "OK" },
          };
        },
        "im.message.reaction.created_v1": async (data: unknown) => {
          await handlers.onEvent(data, "im.message.reaction.created_v1");
        },
        "im.message.reaction.deleted_v1": async (data: unknown) => {
          await handlers.onEvent(data, "im.message.reaction.deleted_v1");
        },
      });

      const wsOpts: { appId: string; appSecret: string; domain?: unknown } = {
        appId: opts.appId,
        appSecret: opts.appSecret,
      };
      if (domain !== undefined) wsOpts.domain = domain;
      client = new Lark.WSClient(wsOpts);
      alive = true;

      const onAbort = (): void => {
        alive = false;
        try {
          client?.close?.();
        } catch {
          // ignore
        }
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        await Promise.resolve(client.start({ eventDispatcher: dispatcher }));
      } finally {
        alive = false;
      }
    },
  };
}
