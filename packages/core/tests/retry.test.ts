import { describe, expect, it } from "vitest";
import { isRetryableError, withRetry } from "../src/retry.js";
import type { Clock } from "../src/types.js";

function fakeClock(): Clock & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    now: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    sleeps,
  };
}

describe("withRetry", () => {
  it("returns the first success", async () => {
    const result = await withRetry(async () => 7);
    expect(result).toBe(7);
  });

  it("retries retryable errors with backoff", async () => {
    const clock = fakeClock();
    let n = 0;
    const result = await withRetry(
      async () => {
        n += 1;
        if (n < 3) {
          const err = new Error("nope") as Error & { status: number };
          err.status = 429;
          throw err;
        }
        return "ok";
      },
      { maxAttempts: 4, minMs: 100, maxMs: 1000, factor: 2, jitter: 0, clock, random: () => 0 },
    );
    expect(result).toBe("ok");
    expect(n).toBe(3);
    expect(clock.sleeps).toEqual([100, 200]);
  });

  it("sleeps at least retryAfter / Retry-After on 429", async () => {
    const clock = fakeClock();
    let n = 0;
    await withRetry(
      async () => {
        n += 1;
        if (n < 2) {
          throw Object.assign(new Error("slow down"), { status: 429, retryAfter: 3 });
        }
        return "ok";
      },
      { maxAttempts: 3, minMs: 100, maxMs: 200, factor: 2, jitter: 0, clock, random: () => 0 },
    );
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(3000);
    const clock2 = fakeClock();
    n = 0;
    await withRetry(
      async () => {
        n += 1;
        if (n < 2) {
          throw Object.assign(new Error("header"), {
            status: 429,
            headers: { "Retry-After": "2" },
          });
        }
        return "ok";
      },
      { maxAttempts: 3, minMs: 50, maxMs: 50, jitter: 0, clock: clock2, random: () => 0 },
    );
    expect(clock2.sleeps[0]).toBeGreaterThanOrEqual(2000);
  });

  it("does not retry a non-retryable error", async () => {
    const err = new Error("bad") as Error & { status: number };
    err.status = 400;
    await expect(
      withRetry(
        async () => {
          throw err;
        },
        { maxAttempts: 3 },
      ),
    ).rejects.toBe(err);
  });
});

describe("isRetryableError", () => {
  it("treats 429, 5xx and socket codes as retryable", () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
    expect(isRetryableError({ statusCode: 503 })).toBe(true);
    expect(isRetryableError({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryableError({ status: 400 })).toBe(false);
  });
});
