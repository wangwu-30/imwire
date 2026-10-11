import { describe, expect, it } from "vitest";
import { MemoryDedupStore, dedupKey } from "../src/dedup.js";

describe("MemoryDedupStore", () => {
  it("records the first sighting and rejects the replay", async () => {
    const store = new MemoryDedupStore({ now: () => 1_000 });
    const key = dedupKey("telegram", "bot", "42");
    expect(await store.seen(key)).toBe(false);
    expect(await store.seen(key)).toBe(true);
    expect(await store.seen(key)).toBe(true);
  });

  it("expires keys after TTL", async () => {
    let now = 0;
    const store = new MemoryDedupStore({ ttlMs: 100, now: () => now });
    expect(await store.seen("a")).toBe(false);
    now = 99;
    expect(await store.seen("a")).toBe(true);
    now = 100;
    expect(await store.seen("a")).toBe(false);
  });

  it("evicts the oldest key when over capacity", async () => {
    let now = 0;
    const store = new MemoryDedupStore({ max: 2, ttlMs: 10_000, now: () => now });
    expect(await store.seen("a")).toBe(false);
    now = 1;
    expect(await store.seen("b")).toBe(false);
    now = 2;
    expect(await store.seen("c")).toBe(false);
    expect(store.size).toBe(2);
    expect(await store.seen("b")).toBe(true);
    expect(await store.seen("a")).toBe(false);
  });

  it("isolates keys by platform and account", async () => {
    const store = new MemoryDedupStore();
    expect(await store.seen(dedupKey("telegram", "a", "1"))).toBe(false);
    expect(await store.seen(dedupKey("telegram", "b", "1"))).toBe(false);
    expect(await store.seen(dedupKey("feishu", "a", "1"))).toBe(false);
  });
});
