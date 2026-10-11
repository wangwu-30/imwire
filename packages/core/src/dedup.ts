export interface DedupStore {
  /** Returns true if `key` was already seen (and still within TTL). */
  seen(key: string): Promise<boolean>;
}

export interface MemoryDedupOptions {
  max?: number;
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_MAX = 10_000;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function dedupKey(platform: string, accountId: string, eventId: string): string {
  return `${platform}:${accountId}:${eventId}`;
}

export class MemoryDedupStore implements DedupStore {
  private readonly map = new Map<string, number>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: MemoryDedupOptions = {}) {
    this.max = opts.max ?? DEFAULT_MAX;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  async seen(key: string): Promise<boolean> {
    this.prune();
    const prev = this.map.get(key);
    const now = this.now();
    if (prev !== undefined && now - prev < this.ttlMs) {
      return true;
    }
    if (prev !== undefined) this.map.delete(key);
    this.map.set(key, now);
    this.pruneOverflow();
    return false;
  }

  get size(): number {
    return this.map.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, ts] of this.map) {
      if (now - ts >= this.ttlMs) this.map.delete(key);
    }
  }

  private pruneOverflow(): void {
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
