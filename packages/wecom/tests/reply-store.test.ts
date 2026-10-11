import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { WECOM_REPLY_TTL_MS, WecomReplyStore } from "../src/reply-store.js";

test("LRU evicts least-recently-used keys once the memory budget is full", () => {
  const store = new WecomReplyStore({ maxBytes: 280 });
  store.set("old", { reqId: "r-old", msgid: "m-old", at: store.now() });
  store.set("keep", { reqId: "r-keep", msgid: "m-keep", at: store.now() });
  expect(store.get("keep")?.reqId).toBe("r-keep");
  store.set("n0", { reqId: "r0", msgid: "m0", at: store.now() });
  store.set("n1", { reqId: "r1", msgid: "m1", at: store.now() });
  expect(store.byteSize).toBeLessThanOrEqual(280);
  expect(store.get("old")).toBeUndefined();
  expect(store.get("keep")?.reqId).toBe("r-keep");
});

test("TTL follows the documented 24h window", () => {
  let now = 1_000;
  const store = new WecomReplyStore({ now: () => now });
  store.set("c", { reqId: "r", msgid: "m", at: now });
  now += WECOM_REPLY_TTL_MS;
  expect(store.get("c")?.reqId).toBe("r");
  now += 1;
  expect(store.get("c")).toBeUndefined();
});

test("optional persist reloads unexpired entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "wecom-store-"));
  const path = join(dir, "reply.json");
  const first = new WecomReplyStore({ persistPath: path });
  first.set("chat", { reqId: "req-1", msgid: "msg-1", at: first.now() });
  const raw = JSON.parse(readFileSync(path, "utf8")) as { entries: unknown[] };
  expect(raw.entries.length).toBeGreaterThan(0);
  const second = new WecomReplyStore({ persistPath: path });
  expect(second.get("chat")?.reqId).toBe("req-1");
});
