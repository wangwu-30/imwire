import { systemClock, type Clock } from "./types.js";

export interface TokenBucketOptions {
  ratePerSec: number;
  burst: number;
  clock?: Clock;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
  blockedUntil?: number;
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
      const now = this.clock.now();
      if (bucket.blockedUntil !== undefined && now < bucket.blockedUntil) {
        await this.clock.sleep(Math.max(1, bucket.blockedUntil - now));
        continue;
      }
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

  /** Hold this bucket empty for at least `ms` (used after 429 retry_after). */
  cooldown(key: string, ms: number): void {
    this.refill(key);
    const bucket = this.buckets.get(key);
    const until = this.clock.now() + Math.max(0, ms);
    if (bucket) {
      bucket.tokens = 0;
      bucket.blockedUntil = until;
    } else {
      this.buckets.set(key, { tokens: 0, updatedAt: this.clock.now(), blockedUntil: until });
    }
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
  let running: Promise<void> | undefined;
  let queued: (() => Promise<void>) | undefined;

  const kick = (): void => {
    if (running || !queued) return;
    const job = queued;
    queued = undefined;
    lastRun = clock.now();
    running = Promise.resolve()
      .then(job)
      .catch(() => undefined)
      .finally(() => {
        running = undefined;
        if (!queued) return;
        const wait = Math.max(0, opts.intervalMs - (clock.now() - lastRun));
        timer = setTimeout(() => {
          timer = undefined;
          kick();
        }, wait);
      });
  };

  return {
    pending: () => queued !== undefined || timer !== undefined || running !== undefined,
    schedule(run) {
      queued = run;
      if (running) return;
      if (timer !== undefined) return;
      const wait = Math.max(0, opts.intervalMs - (clock.now() - lastRun));
      timer = setTimeout(() => {
        timer = undefined;
        kick();
      }, wait);
    },
    async flush() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (running) await running;
      kick();
      if (running) await running;
    },
  };
}
