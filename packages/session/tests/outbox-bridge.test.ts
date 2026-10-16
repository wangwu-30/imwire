import { mkdtemp, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRef, Logger, OutMessage } from "@imwire/core";
import { SessionGateway } from "../src/gateway.js";
import { OutboxBridge, isOutboxItem, type OutboxItem, type OutboxResult } from "../src/outbox-bridge.js";
import { ScriptedDriver } from "../src/scripted-driver.js";
import { proactiveText } from "../src/proactive.js";
import { fakeAdapter } from "./helpers.js";

const SECRET = "injected-token-DO-NOT-LOG-9f31";
const BACKOFF = [30_000, 120_000, 600_000, 1_800_000];
let root: string;
let dir: string;
let gw: SessionGateway;
let bridge: OutboxBridge;
let person: string;
let logger: Logger;
let send: ReturnType<typeof vi.fn>;
let telegram: ReturnType<typeof fakeAdapter> & { isAlive: () => boolean };

function gateway(): SessionGateway {
  return new SessionGateway({ dbPath: join(root, "store.sqlite"), driver: new ScriptedDriver(), logger, sweepIntervalMs: 0 });
}
function item(id = "one", extra: Partial<OutboxItem> = {}): OutboxItem {
  return { v: 1, outbox_id: id, kind: "routed_chat", person_id: person, request_id: `req-${id}`,
    card_version: 3, text: "hello", created_at: new Date().toISOString(), untrusted: true, ...extra };
}
async function publish(value: OutboxItem, name = value.outbox_id): Promise<void> {
  await writeFile(join(dir, "tmp", `${name}.json`), JSON.stringify(value));
  await rename(join(dir, "tmp", `${name}.json`), join(dir, "new", `${name}.json`));
}
async function result(id = "one"): Promise<OutboxResult> {
  return JSON.parse(await readFile(join(root, "chat-results", "new", `${id}.json`), "utf8"));
}
async function files(folder: string): Promise<string[]> {
  return (await readdir(join(dir, folder))).filter((f) => f.endsWith(".json"));
}
async function restart(): Promise<void> {
  await bridge.stop();
  gw.close();
  gw = gateway();
  gw.registerAdapter(telegram);
  bridge = new OutboxBridge(gw, { enabled: true, dir }, logger);
  await bridge.start();
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
  root = await mkdtemp(join(tmpdir(), "imwire-outbox-"));
  dir = join(root, "chat");
  logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  gw = gateway();
  person = gw.store.createPerson("Test", Date.now()).id;
  telegram = Object.assign(fakeAdapter("telegram"), { isAlive: vi.fn(() => true) });
  send = vi.fn(async (chat: ChatRef, _msg: OutMessage) => [{ chat, messageId: "sent-1" }]);
  telegram.send = send;
  gw.registerAdapter(telegram);
  gw.store.linkIdentity(person, "telegram", "bot", "123", Date.now());
  bridge = new OutboxBridge(gw, { enabled: true, dir }, logger);
  await bridge.start();
});
afterEach(async () => {
  await bridge.stop();
  gw.close();
  expect(JSON.stringify(Object.values(logger).map((fn) => vi.mocked(fn).mock.calls))).not.toContain(SECRET);
  await rm(root, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("outbox bridge", () => {
  it("a: 100 concurrent slow tmp writers publish complete files; direct bad JSON becomes dead(invalid)", async () => {
    let writing = true;
    const writers = Promise.all(Array.from({ length: 100 }, async (_, i) => {
      const payload = JSON.stringify(item(`slow-${i}`, { text: `body-${i}-` + "字".repeat(100) }));
      const path = join(dir, "tmp", `${i}.json`);
      const handle = await open(path, "w");
      try {
        for (let offset = 0; offset < payload.length; offset += 17) await handle.write(payload.slice(offset, offset + 17));
        await handle.sync();
      } finally { await handle.close(); }
      await rename(path, join(dir, "new", `${i}.json`));
    })).finally(() => { writing = false; });
    while (writing) await bridge.poll();
    await writers;
    await bridge.poll();
    expect(send).toHaveBeenCalledTimes(100);
    expect(await files("done")).toHaveLength(100);
    expect(await files("dead")).toHaveLength(0);
    for (let i = 0; i < 100; i++) expect(await result(`slow-${i}`)).toMatchObject({ status: "delivered", attempts: 1 });
    await writeFile(join(dir, "new", "broken.json"), '{"text":"' + SECRET);
    await bridge.poll();
    expect(await files("dead")).toHaveLength(1);
    const reasons = (await readdir(join(dir, "dead"))).filter((f) => f.endsWith(".reason"));
    expect(await readFile(join(dir, "dead", reasons[0]!), "utf8")).toBe("invalid\n");
    expect(send).toHaveBeenCalledTimes(100);
    const invalid = (await readdir(join(root, "chat-results", "new"))).find((f) => f.startsWith("invalid-"))!;
    expect(JSON.parse(await readFile(join(root, "chat-results", "new", invalid), "utf8"))).toMatchObject({ status: "dead", reason: "invalid" });
  });

  it("b: duplicate ids send once, including after rebuilding gateway and bridge on the same SQLite file", async () => {
    await Promise.all(["a", "b", "c"].map((name) => publish(item(), name)));
    await Promise.all([bridge.poll(), bridge.poll(), bridge.poll()]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await files("done")).toHaveLength(3);
    await restart();
    await publish(item(), "after-restart");
    await bridge.poll();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await files("done")).toHaveLength(4);
    expect(await result()).toMatchObject({ status: "delivered", attempts: 1 });
    expect(gw.store.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM delivery").get()!.n).toBe(1);
  });

  it("c: two 5xx then success respects persisted deadlines and delivers on attempt 3", async () => {
    send.mockRejectedValueOnce({ status: 503, message: SECRET }).mockRejectedValueOnce({ status: 502 });
    await publish(item());
    await bridge.poll();
    expect(await result()).toMatchObject({ status: "retrying", attempts: 1 });
    vi.setSystemTime(Date.now() + 29_999);
    await bridge.poll();
    expect(send).toHaveBeenCalledTimes(1);
    await restart();
    vi.setSystemTime(Date.now() + 1);
    await bridge.poll();
    expect(await result()).toMatchObject({ status: "retrying", attempts: 2 });
    vi.setSystemTime(Date.now() + 120_000);
    await bridge.poll();
    expect(await result()).toMatchObject({ status: "delivered", attempts: 3 });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("c: persistent 5xx exhausts exactly five attempts; critical result is dead", async () => {
    send.mockRejectedValue({ status: 500, message: SECRET });
    await publish(item("one", { kind: "critical_chat" }));
    await bridge.poll();
    for (const delay of BACKOFF) { vi.setSystemTime(Date.now() + delay); await bridge.poll(); }
    expect(send).toHaveBeenCalledTimes(5);
    expect(await result()).toMatchObject({ status: "dead", reason: "exhausted", kind: "critical_chat", attempts: 5 });
    expect(await files("dead")).toHaveLength(1);
    await restart();
    await publish(item(), "again");
    await bridge.poll();
    expect(send).toHaveBeenCalledTimes(5);
  });

  it.each([400, 401, 403, 404])("c: HTTP %i is dead(permanent) after one attempt even with a retryable flag", async (status) => {
    send.mockRejectedValue({ status, retryable: true, message: SECRET });
    await publish(item()); await bridge.poll();
    expect(await result()).toMatchObject({ status: "dead", reason: "permanent", attempts: 1 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 429, retryAfter: 300 },
    { status: 429, headers: { "Retry-After": "300" } },
    { status: 429, headers: { "Retry-After": "Sat, 17 Oct 2026 00:05:00 GMT" } },
    { cause: { code: "ECONNRESET", retryAfterMs: 300_000 } },
  ])("respects Retry-After and network causes", async (error) => {
    send.mockRejectedValueOnce(error);
    await publish(item()); await bridge.poll();
    vi.setSystemTime(Date.now() + 299_999); await bridge.poll();
    expect(send).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1); await bridge.poll();
    expect(await result()).toMatchObject({ status: "delivered", attempts: 2 });
  });

  it("d: Telegram wins over latest Feishu; offline Telegram uses Feishu", async () => {
    const feishu = Object.assign(fakeAdapter("feishu"), { isAlive: () => true });
    const fsSend = vi.spyOn(feishu, "send");
    gw.registerAdapter(feishu);
    gw.store.linkIdentity(person, "feishu", "bot", "ou_person", Date.now());
    gw.store.touchPresence(person, { platform: "feishu", accountId: "bot", chatId: "oc_dm", kind: "dm" }, Date.now());
    await publish(item("tg")); await bridge.poll();
    expect(await result("tg")).toMatchObject({ channel: "telegram", status: "delivered" });
    expect(fsSend).not.toHaveBeenCalled();
    vi.mocked(telegram.isAlive).mockReturnValue(false);
    await publish(item("fs")); await bridge.poll();
    expect(await result("fs")).toMatchObject({ channel: "feishu", status: "delivered" });
    expect(fsSend).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("d: only WeCom is unsupported and send is never called, even if its capability claims true", async () => {
    const wecom = fakeAdapter("wecom");
    const wecomSend = vi.spyOn(wecom, "send");
    gw.registerAdapter(wecom);
    const other = gw.store.createPerson("WeCom only", Date.now()).id;
    gw.store.linkIdentity(other, "wecom", "bot", "user", Date.now());
    await publish(item("one", { person_id: other, kind: "critical_chat" })); await bridge.poll();
    expect(await result()).toMatchObject({ status: "dead", reason: "unsupported", kind: "critical_chat" });
    expect(wecomSend).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it("d: legacy sendProactive returns no_surface and warns; failed sends also return and warn safely", async () => {
    const other = gw.store.createPerson("Unbound", Date.now()).id;
    expect(await gw.sendProactive(other, SECRET)).toMatchObject({ status: "dead", reason: "no_surface" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    send.mockRejectedValue({ status: 401, message: SECRET });
    expect(await gw.sendProactive(person, SECRET)).toMatchObject({ status: "dead", reason: "permanent" });
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("e: sends cleaned literal text without markdown blocks; limits Unicode to 2000 characters", async () => {
    const text = `[link](https://invalid.test/${SECRET}) @all\u0000\u001b\b\u202e\n<at user_id="all">all</at>` + "😀".repeat(2100);
    await publish(item("one", { text })); await bridge.poll();
    const msg = send.mock.calls[0]![1] as OutMessage;
    expect(msg.blocks).toEqual([{ kind: "text", text: proactiveText(text) }]);
    const cleaned = proactiveText(text);
    expect(Array.from(cleaned)).toHaveLength(2000);
    expect(cleaned).toContain("[link](https://invalid.test/");
    expect(cleaned).toContain("@all");
    expect(cleaned.replaceAll("\n", "")).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(cleaned).not.toContain("<at ");
    expect(send.mock.calls[0]![2]).toEqual({ maxAttempts: 1 });
  });

  it("e: unknown person is dead(invalid), without invoking send", async () => {
    await publish(item("one", { person_id: "unknown" })); await bridge.poll();
    expect(await result()).toMatchObject({ status: "dead", reason: "invalid", attempts: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("f: startup recovers cur without delivered and sends once", async () => {
    await writeFile(join(dir, "cur", "leftover.json"), JSON.stringify(item()));
    await restart(); await bridge.poll();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await files("done")).toEqual(["leftover.json"]);
  });

  it("f: delivered in SQLite with cur leftover is never resent; result is recreated and file archived", async () => {
    await publish(item()); await bridge.poll();
    const name = (await files("done"))[0]!;
    await rename(join(dir, "done", name), join(dir, "cur", name));
    await rm(join(root, "chat-results", "new", "one.json"));
    await restart(); await bridge.poll();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await files("cur")).toHaveLength(0);
    expect(await result()).toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("keeps delivered in cur if publishing results fails, then retries only publication", async () => {
    const output = join(root, "chat-results", "new");
    await rm(output, { recursive: true }); await writeFile(output, "blocked");
    await publish(item()); await bridge.poll();
    expect(gw.store.getOutboxDelivery("one")?.status).toBe("delivered");
    expect(await files("cur")).toHaveLength(1);
    await rm(output); await mkdir(output);
    await bridge.poll();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await result()).toMatchObject({ status: "delivered" });
  });

  it("retries result publication before next_try_at without resending", async () => {
    send.mockRejectedValueOnce({ status: 503 });
    const output = join(root, "chat-results", "new");
    await rm(output, { recursive: true }); await writeFile(output, "blocked");
    await publish(item()); await bridge.poll();
    expect(gw.store.getOutboxDelivery("one")?.status).toBe("retrying");
    await rm(output); await mkdir(output);
    await bridge.poll();
    expect(await result()).toMatchObject({ status: "retrying", attempts: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    const writes = vi.mocked(logger.info).mock.calls.length;
    await bridge.poll();
    expect(logger.info).toHaveBeenCalledTimes(writes);
  });

  it("honors configured channel order and strictly requires proactiveSend=true", async () => {
    await bridge.stop(); gw.close();
    gw = new SessionGateway({ dbPath: join(root, "store.sqlite"), driver: new ScriptedDriver(),
      preferredChannels: ["feishu", "telegram"], sweepIntervalMs: 0 });
    const feishu = fakeAdapter("feishu");
    const fsSend = vi.spyOn(feishu, "send");
    gw.registerAdapter(feishu); gw.registerAdapter(telegram);
    gw.store.linkIdentity(person, "feishu", "bot", "ou_test", Date.now());
    expect(await gw.sendProactiveTo(person, "first")).toMatchObject({ status: "delivered", surface: { platform: "feishu" } });
    Object.defineProperty(feishu, "capabilities", { value: { ...feishu.capabilities, proactiveSend: false } });
    expect(await gw.sendProactiveTo(person, "second")).toMatchObject({ status: "delivered", surface: { platform: "telegram" } });
    expect(fsSend).toHaveBeenCalledTimes(1);
  });

  it("does not fall through to Feishu after the selected Telegram fails", async () => {
    const feishu = fakeAdapter("feishu");
    const fsSend = vi.spyOn(feishu, "send");
    gw.registerAdapter(feishu);
    gw.store.linkIdentity(person, "feishu", "bot", "ou_test", Date.now());
    send.mockRejectedValue({ status: 503 });
    await publish(item()); await bridge.poll();
    expect(await result()).toMatchObject({ status: "retrying", channel: "telegram" });
    expect(fsSend).not.toHaveBeenCalled();
  });

  it("accepts the maximum ID length without exceeding filesystem filename limits", async () => {
    const id = "x".repeat(200);
    await publish(item(id), `${Date.now()}-${id}`); await bridge.poll();
    expect(await result(id)).toMatchObject({ status: "delivered" });
  });

  it("serializes simultaneous gateway calls using the same idempotency key", async () => {
    const results = await Promise.all(Array.from({ length: 3 }, () => gw.sendProactiveTo(person, "hi", { idempotencyKey: "direct" })));
    expect(results.every((r) => r.status === "delivered")).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("migrates an existing store additively and preserves people", async () => {
    gw.store.db.exec("DROP TABLE outbox_deliveries");
    await restart();
    expect(gw.store.getPerson(person)?.id).toBe(person);
    await publish(item()); await bridge.poll();
    expect(await result()).toMatchObject({ status: "delivered" });
  });

  it("is disabled by default and does not create directories", async () => {
    const disabled = new OutboxBridge(gw, { dir: join(root, "disabled") });
    await disabled.start(); await disabled.poll(); await disabled.stop();
    expect(await readdir(root)).not.toContain("disabled");
  });

  it.each([
    { v: 2 }, { outbox_id: "../escape" }, { kind: "execute" }, { request_id: "" },
    { card_version: -1 }, { text: null }, { created_at: "tomorrow" }, { untrusted: false },
    { deeplink: "https://invalid.test" },
  ])("rejects invalid schema without leaking payloads: %j", async (change) => {
    const value = { ...item(), ...change };
    expect(isOutboxItem(value)).toBe(false);
    await writeFile(join(dir, "new", "bad.json"), JSON.stringify(value));
    await bridge.poll();
    expect(await files("dead")).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });
});
