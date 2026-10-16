import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStore } from "@imwire/session";
import { fakeAdapter } from "../../session/tests/helpers.js";
import { createServeHost } from "../src/server.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); vi.useRealTimers(); });

it("serve polls by default every 2000ms, broadcasts inbound without replying, and drains sends before closing DB", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
  const root = await mkdtemp(join(tmpdir(), "imwire-serve-outbox-"));
  const dbPath = join(root, "session.sqlite");
  const dir = join(root, "chat");
  const store = new SessionStore(dbPath);
  const person = store.createPerson("Test", Date.now());
  store.linkIdentity(person.id, "telegram", "bot", "123", Date.now()); store.close();
  const adapter = fakeAdapter("telegram");
  const ac = new AbortController();
  const messages: unknown[] = [];
  let finish!: () => void;
  const pending = new Promise<void>((r) => { finish = r; });
  const send = vi.spyOn(adapter, "send").mockImplementation(async (chat) => {
    await pending;
    return [{ chat, messageId: "sent" }];
  });
  const host = createServeHost({ adapters: [adapter], dbPath, outboxBridge: { enabled: true, dir }, write: (msg) => messages.push(msg) });
  const run = host.start(ac.signal);
  cleanup = async () => { finish(); ac.abort(); await run; await host.stop(); await rm(root, { recursive: true, force: true }); };
  await vi.waitFor(() => expect(adapter.isStarted).toBe(true));
  await adapter.ingest({ type: "message", id: "inbound", ts: Date.now(), chat: { platform: "telegram", accountId: "bot", chatId: "123", kind: "dm" },
    from: { platform: "telegram", accountId: "bot", userId: "123" }, messageId: "1", text: "hi", mentionsBot: true });
  expect(messages).toHaveLength(1); expect(send).not.toHaveBeenCalled();
  await mkdir(join(dir, "tmp"), { recursive: true });
  await writeFile(join(dir, "tmp", "one.json"), JSON.stringify({ v: 1, outbox_id: "one", kind: "routed_chat", person_id: person.id,
    request_id: "request", card_version: 1, text: "test", created_at: new Date().toISOString(), untrusted: true }));
  await rename(join(dir, "tmp", "one.json"), join(dir, "new", "one.json"));
  await vi.advanceTimersByTimeAsync(1999); expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  ac.abort();
  let stopped = false;
  const stop = host.stop().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false);
  finish(); await stop; await run;
  expect(JSON.parse(await readFile(join(root, "chat-results", "new", "one.json"), "utf8"))).toMatchObject({ status: "delivered" });
});
