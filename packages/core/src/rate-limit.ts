import { systemClock, type Clock } from "./types.js";

export interface TokenBucketOptions {
  ratePerSec: number;
  burst: number;
  clock?: Clock;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly ratePerSec: number;
  private readonly burst: number;
  private readonly clock: Clock;

  constructor(opts: TokenBucketOptions) {
    if (opts.ratePerSec <= 0) throw new Error("ratePerSec must be > 0");
    if (opts.burst <= 0) throw new Error("burst must be > 0");
    this.ratePerSec = opts.ratePerSec;
    this.burst = opts.burst;
    this.clock = opts.clock ?? systemClock();
  }

  async take(key: string, n = 1): Promise<void> {
    if (n <= 0) return;
    if (n > this.burst) {
      throw new Error(`cannot take ${n} tokens; burst is ${this.burst}`);
    }
    for (;;) {
      this.refill(key);
      const bucket = this.buckets.get(key);
      if (!bucket) continue;
      if (bucket.tokens >= n) {
        bucket.tokens -= n;
        return;
      }
      const deficit = n - bucket.tokens;
      const waitMs = Math.ceil((deficit / this.ratePerSec) * 1000);
      await this.clock.sleep(Math.max(1, waitMs));
    }
  }

  peek(key: string): number {
    this.refill(key);
    return this.buckets.get(key)?.tokens ?? this.burst;
  }

  private refill(key: string): void {
    const now = this.clock.now();
    const existing = this.buckets.get(key);
    if (!existing) {
      this.buckets.set(key, { tokens: this.burst, updatedAt: now });
      return;
    }
    const elapsedSec = Math.max(0, now - existing.updatedAt) / 1000;
    existing.tokens = Math.min(this.burst, existing.tokens + elapsedSec * this.ratePerSec);
    existing.updatedAt = now;
  }
}

export interface CoalescingThrottle {
  schedule(run: () => Promise<void>): void;
  flush(): Promise<void>;
  pending(): boolean;
}

export function createCoalescingThrottle(opts: {
  intervalMs: number;
  clock?: Clock;
}): CoalescingThrottle {
  const clock = opts.clock ?? systemClock();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastRun = 0;
  let inflight: Promise<void> = Promise.resolve();
  let queued: (() => Promise<void>) | undefined;

  const fire = (): void => {
    timer = undefined;
    const job = queued;
    queued = undefined;
    if (!job) return;
    lastRun = clock.now();
    inflight = inflight
      .catch(() => undefined)
      .then(job)
      .catch(() => undefined);
  };

  return {
    pending: () => queued !== undefined || timer !== undefined,
    schedule(run) {
      queued = run;
      if (timer !== undefined) return;
      const wait = Math.max(0, opts.intervalMs - (clock.now() - lastRun));
      timer = setTimeout(fire, wait);
    },
    async flush() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      fire();
      await inflight;
    },
  };
}
