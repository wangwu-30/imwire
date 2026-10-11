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
  /** Must write to stderr — stdout is reserved for JSON-RPC when served. */
  logger?: {
    debug?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
    trace?: (...args: unknown[]) => void;
  };
  loggerLevel?: string;
}

type WsLike = {
  start: (opts: { eventDispatcher: unknown }) => Promise<void> | void;
  close?: () => void;
  getConnectionStatus?: () => unknown;
};

const LIVE_STATES = new Set(["idle", "connecting", "connected", "reconnecting"]);

/**
 * `WSClient.getConnectionStatus()` returns `{ state, reconnectAttempts, … }`,
 * not a string. `String(status)` is `"[object Object]"` and hides `failed`.
 */
export function readWsConnectionState(status: unknown): string | undefined {
  if (status == null) return undefined;
  if (typeof status === "string" || typeof status === "number") return String(status).toLowerCase();
  if (typeof status === "object" && "state" in status) {
    const state = (status as { state?: unknown }).state;
    if (typeof state === "string" || typeof state === "number") return String(state).toLowerCase();
  }
  return undefined;
}

export function isWsConnectionAlive(status: unknown, closed: boolean): boolean {
  if (closed) return false;
  const state = readWsConnectionState(status);
  if (state === undefined) return true;
  return LIVE_STATES.has(state);
}

/**
 * Official `@larksuiteoapi/node-sdk` long connection. Loaded lazily so mapping
 * tests never touch the network or the SDK constructor.
 *
 * `WSClient.start()` resolves immediately and keeps its own reconnect loop.
 * This wrapper therefore:
 * - creates **one** client
 * - does not treat `start()` resolving as a disconnect
 * - waits until abort or a terminal start() / `state: failed` / `onError`
 * - acks card callbacks without awaiting user handlers (3 s deadline)
 */
export async function createSdkRealtime(opts: SdkRealtimeOptions): Promise<FeishuRealtime> {
  const mod = (await import("@larksuiteoapi/node-sdk")) as unknown as {
    default?: unknown;
    EventDispatcher: new (opts: Record<string, never>) => {
      register: (handlers: Record<string, (data: unknown) => Promise<unknown>>) => unknown;
    };
    WSClient: new (opts: {
      appId: string;
      appSecret: string;
      domain?: unknown;
      onError?: (err: Error) => void;
      logger?: unknown;
      loggerLevel?: unknown;
    }) => WsLike;
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
    return isWsConnectionAlive(client.getConnectionStatus?.(), closed);
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

      const wsOpts: {
        appId: string;
        appSecret: string;
        domain?: unknown;
        onError?: (err: Error) => void;
        logger?: unknown;
        loggerLevel?: unknown;
      } = {
        appId: opts.appId,
        appSecret: opts.appSecret,
        logger: opts.logger ?? stderrSdkLogger(),
        loggerLevel: opts.loggerLevel ?? "error",
      };
      if (domain !== undefined) wsOpts.domain = domain;

      closeClient();
      closed = false;

      let settleFatal: ((err: Error) => void) | undefined;
      const fatal = new Promise<never>((_resolve, reject) => {
        settleFatal = (err) => {
          closeClient();
          reject(err);
        };
      });
      const onFatal = (err: unknown): void => {
        const error = err instanceof Error ? err : new Error(String(err));
        settleFatal?.(error);
        settleFatal = undefined;
      };
      wsOpts.onError = (err) => onFatal(err);

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

      const watchFailed = (async () => {
        while (!closed && !signal.aborted) {
          await sleep(250);
          const state = readWsConnectionState(client?.getConnectionStatus?.());
          if (state === "failed") {
            onFatal(new Error("feishu websocket failed (bad credentials or exhausted reconnect)"));
            return;
          }
        }
      })();

      try {
        const started = Promise.resolve(client.start({ eventDispatcher: dispatcher }));
        await Promise.race([
          aborted,
          fatal,
          watchFailed,
          started.then(
            () => aborted,
            (err: unknown) => {
              onFatal(err);
              return fatal;
            },
          ),
        ]);
      } finally {
        closeClient();
      }
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stderrSdkLogger(): {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
} {
  const write = (level: string, args: unknown[]): void => {
    process.stderr.write(
      `[${level}]: ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
    );
  };
  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
    trace: (...args) => write("trace", args),
  };
}
