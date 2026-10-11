import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { onShutdownSignal } from "../src/index.js";
import { runReconnectSupervisor } from "../src/reconnect.js";

function fakeProc() {
  const proc = Object.assign(new EventEmitter(), { exit: vi.fn() });
  return proc;
}

describe("onShutdownSignal", () => {
  it("runs stop once, then force-exits after the grace period", () => {
    vi.useFakeTimers();
    try {
      const proc = fakeProc();
      const stop = vi.fn();
      onShutdownSignal(stop, { proc, graceMs: 1_000, log: () => undefined });
      proc.emit("SIGTERM");
      expect(stop).toHaveBeenCalledTimes(1);
      expect(proc.exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(proc.exit).toHaveBeenCalledWith(143);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second signal exits immediately", () => {
    const proc = fakeProc();
    const stop = vi.fn();
    onShutdownSignal(stop, { proc, graceMs: 60_000, log: () => undefined });
    proc.emit("SIGINT");
    proc.emit("SIGINT");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(130);
  });
});

describe("reconnect supervisor", () => {
  it("does not accumulate abort listeners while polling a live connection", async () => {
    const ac = new AbortController();
    let added = 0;
    let removed = 0;
    const add = ac.signal.addEventListener.bind(ac.signal);
    const remove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((...args: Parameters<typeof add>) => {
      added += 1;
      return add(...args);
    }) as typeof add;
    ac.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      removed += 1;
      return remove(...args);
    }) as typeof remove;

    let polls = 0;
    const conn = {
      connect: async () => undefined,
      isAlive: () => {
        polls += 1;
        if (polls >= 200) ac.abort();
        return true;
      },
    };
    const clock = { now: () => Date.now(), sleep: () => Promise.resolve() };
    await runReconnectSupervisor(conn, ac.signal, { clock });
    expect(polls).toBeGreaterThanOrEqual(200);
    expect(added - removed).toBeLessThanOrEqual(1);
  });
});
