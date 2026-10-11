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
  /** SDK numeric `LoggerLevel` (string values silence every WSClient log). */
  loggerLevel?: number;
  /**
   * Seconds to wait for any inbound frame after each ping before the socket is
   * presumed dead and torn down (the SDK then reconnects). Default 30; 0 disables.
   * Feishu pings every ~120 s; the SDK re-arms this watchdog on every ping, so it
   * only fires when it is shorter than the server ping interval.
   */
  pingTimeoutSec?: number;
  /** Abort a WebSocket handshake that hangs this long (ms). Default 15000; 0 disables. */
  handshakeTimeoutMs?: number;
  /** Override the endpoint host the SDK pulls the WS URL from (tests / private deployments). */
  wsDomain?: string;
  /** Load the SDK module (tests). Default: `import("@larksuiteoapi/node-sdk")`. */
  loadSdk?: () => Promise<unknown>;
}

type WsLike = {
  start: (opts: { eventDispatcher: unknown }) => Promise<void> | void;
  close?: (params?: { force?: boolean }) => void;
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
  const mod = (await (opts.loadSdk ?? (() => import("@larksuiteoapi/node-sdk")))()) as unknown as {
    default?: unknown;
    EventDispatcher: new (opts: {
      logger?: unknown;
      loggerLevel?: unknown;
    }) => {
      register: (handlers: Record<string, (data: unknown) => Promise<unknown>>) => unknown;
    };
    WSClient: new (opts: {
      appId: string;
      appSecret: string;
      domain?: unknown;
      onError?: (err: Error) => void;
      onReconnecting?: () => void;
      onReconnected?: () => void;
      logger?: unknown;
      loggerLevel?: unknown;
      wsConfig?: { pingTimeout?: number };
      handshakeTimeoutMs?: number;
    }) => WsLike;
    Domain?: { Lark?: unknown; Feishu?: unknown };
    LoggerLevel?: { fatal: number; error: number; warn: number; info: number };
  };
  const Lark = (mod.default ?? mod) as typeof mod;
  const LoggerLevel = Lark.LoggerLevel ?? (mod as typeof mod).LoggerLevel;
  const domain = opts.wsDomain ?? (opts.domain === "lark" ? Lark.Domain?.Lark : Lark.Domain?.Feishu);
  const pingTimeoutSec = opts.pingTimeoutSec ?? 30;
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 15_000;

  let client: WsLike | undefined;
  let closed = true;

  const closeClient = (): void => {
    closed = true;
    const current = client;
    client = undefined;
    try {
      // force: terminate the socket. A polite close() waits up to 30 s for the
      // peer's close frame, which never comes on a dead link and holds the
      // process open after SIGTERM.
      current?.close?.({ force: true });
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

      const sdkLogger = opts.logger ?? stderrSdkLogger();
      const loggerLevel = opts.loggerLevel ?? LoggerLevel?.warn ?? 2;

      const dispatcher = new Lark.EventDispatcher({ logger: sdkLogger, loggerLevel }).register({
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
        onReconnecting?: () => void;
        onReconnected?: () => void;
        logger?: unknown;
        loggerLevel?: unknown;
        wsConfig?: { pingTimeout?: number };
        handshakeTimeoutMs?: number;
      } = {
        appId: opts.appId,
        appSecret: opts.appSecret,
        logger: sdkLogger,
        loggerLevel,
        // Without a liveness watchdog the SDK only reconnects on a socket
        // 'close'. Behind a TUN / transparent proxy a dead upstream leaves the
        // local TCP leg ESTABLISHED (pings pile up in Send-Q) and 'close' never
        // fires, so events silently stop.
        onReconnecting: () => sdkLogger.warn?.("[imwire/feishu]", "websocket lost, reconnecting"),
        onReconnected: () => sdkLogger.warn?.("[imwire/feishu]", "websocket reconnected"),
      };
      if (pingTimeoutSec > 0) wsOpts.wsConfig = { pingTimeout: pingTimeoutSec };
      if (handshakeTimeoutMs > 0) wsOpts.handshakeTimeoutMs = handshakeTimeoutMs;
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

      if (signal.aborted || !client) {
        closeClient();
        return;
      }

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
