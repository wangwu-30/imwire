import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStore } from "@imwire/session";
import { chatPreset } from "../src/chat.js";
import { createServeHost, type ServeHost } from "../src/server.js";
import { dm, fakeAdapter, markdownCalls } from "../../session/tests/helpers.js";

let host: ServeHost | undefined;
let root: string | undefined;
afterEach(async () => {
  await host?.stop();
  host = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

it.each([{}, { IMWIRE_CHAT: "on" }, { IMWIRE_PI_PROVIDER: "fake" },
  { IMWIRE_CHAT: "off", IMWIRE_USE_PI: "1", IMWIRE_PI_PROVIDER: "fake" },
  { IMWIRE_CHAT: "off", OPENAI_API_KEY: "test-only-placeholder" },
])("keeps inbound broadcast-only when chat is disabled: %j", async (env) => {
  const { driver } = chatPreset(env);
  expect(driver).toBeUndefined();
  const adapter = fakeAdapter("telegram");
  const messages: unknown[] = [];
  host = createServeHost({ adapters: [adapter], driver, write: (msg) => messages.push(msg) });
  await adapter.ingest(dm({ platform: "telegram", userId: "123", text: "hi" }));
  expect(messages).toHaveLength(1);
  expect(adapter.calls).toHaveLength(0);
});

it.each([false, true])("routes inbound to fake pi and still broadcasts (outbox enabled: %s)", async (outbox) => {
  root = await mkdtemp(join(tmpdir(), "imwire-serve-chat-"));
  const dbPath = join(root, "session.sqlite");
  const store = new SessionStore(dbPath);
  const person = store.createPerson("Test", Date.now());
  store.linkIdentity(person.id, "telegram", "bot", "123", Date.now());
  store.close();
  const { driver } = chatPreset({ IMWIRE_USE_PI: "1", IMWIRE_PI_PROVIDER: "fake" });
  expect(driver).toBeDefined();
  const prompt = vi.spyOn(driver!, "prompt");
  const adapter = fakeAdapter("telegram");
  const messages: unknown[] = [];
  host = createServeHost({ adapters: [adapter], driver, dbPath,
    outboxBridge: outbox ? { enabled: true, dir: join(root, "outbox") } : undefined,
    write: (msg) => messages.push(msg) });
  await adapter.ingest(dm({ platform: "telegram", userId: "123", text: "hello pi" }));
  await host.stop();
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(prompt.mock.calls[0]?.[1].text).toBe("hello pi");
  expect(markdownCalls(adapter).join("\n")).toContain("(offline demo)");
  expect(messages).toHaveLength(1);
  const reopened = new SessionStore(dbPath);
  try {
    const conv = reopened.activeConversation(person.id, Date.now());
    expect(reopened.snapshot(conv.id).messages.some((m) => m.role === "assistant" && m.text.includes("(offline demo)"))).toBe(true);
  } finally { reopened.close(); }
});

it("keeps unpaired senders out of pi", async () => {
  const { driver } = chatPreset({ IMWIRE_USE_PI: "1", IMWIRE_PI_PROVIDER: "fake" });
  const prompt = vi.spyOn(driver!, "prompt");
  const adapter = fakeAdapter("telegram");
  host = createServeHost({ adapters: [adapter], driver, dbPath: ":memory:" });
  await adapter.ingest(dm({ platform: "telegram", userId: "stranger", text: "hi" }));
  await host.stop();
  expect(prompt).not.toHaveBeenCalled();
  expect(markdownCalls(adapter).join("\n")).toContain("This bot is private");
});

it("drains an active turn before closing the store and ignores inbound after stop", async () => {
  const { driver } = chatPreset({ IMWIRE_USE_PI: "1", IMWIRE_PI_PROVIDER: "fake" });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const prompt = vi.spyOn(driver!, "prompt").mockImplementation(async (_id, _input, sink) => {
    await gate;
    sink.text("finished");
    return { text: "finished" };
  });
  const adapter = fakeAdapter("telegram");
  host = createServeHost({ adapters: [adapter], driver, dbPath: ":memory:",
    allowlist: [{ platform: "telegram", accountId: "bot", userId: "123" }] });
  try {
    await adapter.ingest(dm({ platform: "telegram", userId: "123", text: "hi" }));
    // First allowlisted DM bootstraps the owner; the next message starts chat.
    await adapter.ingest(dm({ platform: "telegram", userId: "123", text: "chat now" }));
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stop = host.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    await adapter.ingest(dm({ platform: "telegram", userId: "123", text: "too late" }));
    finish();
    await stop;
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(markdownCalls(adapter).join("\n")).toContain("finished");
  } finally { finish(); }
});
