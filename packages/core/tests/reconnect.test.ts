import { describe, expect, it } from "vitest";
import { runReconnectSupervisor } from "../src/reconnect.js";

describe("runReconnectSupervisor", () => {
  it("reconnects after connect() throws, then stops on abort", async () => {
    let attempts = 0;
    const ac = new AbortController();
    const done = runReconnectSupervisor(
      {
        connect: async () => {
          attempts += 1;
          if (attempts >= 3) ac.abort();
          throw new Error("boom");
        },
        isAlive: () => false,
      },
      ac.signal,
      { minMs: 1, maxMs: 1, jitter: 0, random: () => 0 },
    );
    await done;
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it("exits immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    let connected = 0;
    await runReconnectSupervisor(
      {
        connect: async () => {
          connected += 1;
        },
        isAlive: () => false,
      },
      ac.signal,
    );
    expect(connected).toBe(0);
  });
});
