import { noopLogger, systemClock, type Clock, type Logger } from "./types.js";

export interface Connectable {
  connect(signal: AbortSignal): Promise<void>;
  isAlive(): boolean;
  disconnect?(): Promise<void> | void;
}

export interface ReconnectOptions {
  minMs?: number;
  maxMs?: number;
  factor?: number;
  jitter?: number;
  clock?: Clock;
  random?: () => number;
  logger?: Logger;
  onError?: (err: unknown, attempt: number) => void;
  /** Return false to stop the supervisor (auth / link_disabled). */
  shouldRetry?: (err: unknown) => boolean;
}

export async function runReconnectSupervisor(
  conn: Connectable,
  signal: AbortSignal,
  opts: ReconnectOptions = {},
): Promise<void> {
  const minMs = opts.minMs ?? 500;
  const maxMs = opts.maxMs ?? 30_000;
  const factor = opts.factor ?? 2;
  const jitter = opts.jitter ?? 0.25;
  const clock = opts.clock ?? systemClock();
  const random = opts.random ?? Math.random;
  const logger = opts.logger ?? noopLogger;

  let attempt = 0;

  const onAbort = (): void => {
    void Promise.resolve(conn.disconnect?.()).catch((err: unknown) => {
      logger.warn("disconnect failed", { err: String(err) });
    });
  };
  if (signal.aborted) {
    onAbort();
    return;
  }
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (!signal.aborted) {
      try {
        attempt += 1;
        logger.debug("connect attempt", { attempt });
        await conn.connect(signal);
        if (signal.aborted) return;
        // connect() returning while still alive means the transport is
        // SDK-managed (e.g. Feishu WSClient.start resolves immediately).
        // Wait for a real death instead of opening another client.
        if (conn.isAlive()) {
          attempt = 0;
          while (conn.isAlive() && !signal.aborted) {
            await abortableSleep(clock, 250, signal);
          }
          if (signal.aborted) return;
        }
      } catch (err) {
        if (signal.aborted) return;
        logger.warn("connection dropped", { attempt, err: String(err) });
        opts.onError?.(err, attempt);
        if (opts.shouldRetry && !opts.shouldRetry(err)) {
          logger.error("reconnect stopped", { err: String(err) });
          return;
        }
      }
      if (signal.aborted) return;
      const exp = minMs * factor ** Math.max(0, attempt - 1);
      const capped = Math.min(maxMs, exp);
      const spread = capped * jitter;
      const delay = Math.max(0, capped - spread + random() * spread * 2);
      logger.debug("reconnect backoff", { attempt, delay });
      await abortableSleep(clock, delay, signal);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function abortableSleep(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return;
  await Promise.race([
    clock.sleep(ms),
    new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }),
  ]);
}
