export interface ShutdownOptions {
  /** Force-exit this long after the first signal if the event loop is still busy. Default 5000. */
  graceMs?: number;
  signals?: NodeJS.Signals[];
  /** Injected for tests. */
  proc?: Pick<NodeJS.EventEmitter, "on"> & { exit: (code?: number) => void };
  log?: (msg: string) => void;
}

/**
 * Run `stop` on SIGINT / SIGTERM, then make sure the process actually exits.
 *
 * Installing a signal listener disables Node's default "exit on SIGTERM", so a
 * single handle that refuses to close (a websocket waiting 30 s for a close
 * frame over a dead link, an SDK timer, …) would otherwise leave the process
 * running until `kill -9`. After `graceMs` (unref'd, so a clean drain exits
 * sooner) or on a second signal, exit with 128 + signal number.
 */
export function onShutdownSignal(stop: () => void, opts: ShutdownOptions = {}): void {
  const proc = opts.proc ?? process;
  const graceMs = opts.graceMs ?? 5_000;
  const log = opts.log ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  let stopping = false;
  for (const sig of opts.signals ?? (["SIGINT", "SIGTERM"] as NodeJS.Signals[])) {
    proc.on(sig, () => {
      const code = 128 + (sig === "SIGINT" ? 2 : 15);
      if (stopping) {
        log(`${sig} again: exiting now`);
        proc.exit(code);
        return;
      }
      stopping = true;
      log(`${sig}: shutting down`);
      const timer = setTimeout(() => {
        log(`still running ${graceMs} ms after ${sig}: forcing exit`);
        proc.exit(code);
      }, graceMs);
      timer.unref?.();
      try {
        stop();
      } catch (err) {
        log(`shutdown error: ${String(err)}`);
      }
    });
  }
}
