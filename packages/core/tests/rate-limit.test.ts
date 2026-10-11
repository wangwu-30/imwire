import { describe, expect, it } from "vitest";
import { TokenBucketLimiter, createCoalescingThrottle } from "../src/rate-limit.js";
import type { Clock } from "../src/types.js";

function fakeClock(start = 0): Clock & { advance(ms: number): void } {
  let now = start;
  const waiters: Array<{ until: number; resolve: () => void }> = [];
  return {
    now: () => now,
    sleep: (ms) =>
      new Promise((resolve) => {
        waiters.push({ until: now + ms, resolve });
      }),
    advance(ms: number) {
      now += ms;
      const due = waiters.filter((w) => w.until <= now);
      for (const w of due) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    },
  };
}

describe("TokenBucketLimiter", () => {
  it("allows a burst then blocks until tokens refill", async () => {
    const clock = fakeClock();
    const limiter = new TokenBucketLimiter({ ratePerSec: 10, burst: 2, clock });
    await limiter.take("chat");
    await limiter.take("chat");
    expect(limiter.peek("chat")).toBe(0);
    const pending = limiter.take("chat");
    let done = false;
    void pending.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    clock.advance(100);
    await pending;
    expect(done).toBe(true);
  });

  it("keeps independent buckets per key", async () => {
    const clock = fakeClock();
    const limiter = new TokenBucketLimiter({ ratePerSec: 1, burst: 1, clock });
    await limiter.take("a");
    expect(limiter.peek("a")).toBe(0);
    expect(limiter.peek("b")).toBe(1);
  });
});

describe("createCoalescingThrottle", () => {
  it("merges rapid updates into a single flush", async () => {
    const runs: string[] = [];
    const throttle = createCoalescingThrottle({ intervalMs: 0 });
    throttle.schedule(async () => {
      runs.push("a");
    });
    throttle.schedule(async () => {
      runs.push("b");
    });
    await throttle.flush();
    expect(runs).toEqual(["b"]);
  });

  it("keeps at most one in-flight job and one latest pending job", async () => {
    const started: string[] = [];
    const finished: string[] = [];
    const throttle = createCoalescingThrottle({ intervalMs: 0 });
    const slow = (name: string) => async () => {
      started.push(name);
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished.push(name);
    };
    throttle.schedule(slow("a"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    throttle.schedule(slow("b"));
    throttle.schedule(slow("c"));
    await throttle.flush();
    expect(started).toEqual(["a", "c"]);
    expect(finished).toEqual(["a", "c"]);
  });
});
