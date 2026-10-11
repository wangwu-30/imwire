import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { WecomAdapter } from "../src/adapter.js";
import { WecomApiError, wecomShouldRetry, WECOM_AUTH_ERRCODES } from "../src/errors.js";
import { isDisconnectedEvent } from "../src/map.js";
import { WECOM_REPLY_TTL_MS } from "../src/reply-store.js";
import { createRawWecomTransport, type WecomTransport } from "../src/transport.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class MockWs extends EventEmitter {
  static last: MockWs | undefined;
  sent: unknown[] = [];
  closed = false;
  url: string;
  onSend?: (f: Record<string, unknown>) => void;
  constructor(url: string) {
    super();
    this.url = url;
    MockWs.last = this;
    setTimeout(() => this.emit("open"), 5);
  }
  send(d: string) {
    if (this.closed) return;
    const parsed = JSON.parse(d) as Record<string, unknown>;
    this.sent.push(parsed);
    this.onSend?.(parsed);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
  push(o: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(o)));
  }
}

// https://developer.work.weixin.qq.com/document/path/101463
test("WC1 subscribe errcode rejects start() and clears isAlive", async () => {
  class FailSub extends MockWs {
    onSend = (f: Record<string, unknown>) => {
      if (f.cmd === "aibot_subscribe") {
        setTimeout(
          () => this.push({ headers: f.headers, errcode: 40058, errmsg: "invalid secret" }),
          2,
        );
      }
    };
  }
  const t = createRawWecomTransport({ botId: "b", secret: "s", WebSocketImpl: FailSub, pingMs: 50 });
  const ac = new AbortController();
  const started = t.start(async () => undefined, ac.signal);
  await expect(started).rejects.toBeInstanceOf(WecomApiError);
  expect(t.isAlive()).toBe(false);
  ac.abort();
});

test("WC2 send() after socket close rejects instead of hanging", async () => {
  class OkSub extends MockWs {
    onSend = (f: Record<string, unknown>) => {
      if (f.cmd === "aibot_subscribe") {
        setTimeout(() => this.push({ headers: f.headers, errcode: 0 }), 2);
      }
    };
  }
  const t = createRawWecomTransport({ botId: "b", secret: "s", WebSocketImpl: OkSub, pingMs: 50 });
  const ac = new AbortController();
  const started = t.start(async () => undefined, ac.signal);
  await sleep(30);
  MockWs.last!.close();
  await started;
  const sendP = t.send({
    cmd: "aibot_respond_msg",
    headers: { req_id: "R1" },
    body: { msgtype: "markdown", markdown: { content: "x" } },
  });
  const raced = await Promise.race([
    sendP.then(
      () => "resolved",
      (e: unknown) => "rejected " + (e instanceof Error ? e.message : String(e)),
    ),
    sleep(1500).then(() => "STILL PENDING after 1.5s"),
  ]);
  expect(raced).toMatch(/^rejected /);
  ac.abort();
});

test("WC3 respond_msg errcode is surfaced as WecomApiError", async () => {
  class ReplyErr extends MockWs {
    onSend = (f: Record<string, unknown>) => {
      setTimeout(() => {
        this.push({
          headers: f.headers,
          errcode: f.cmd === "aibot_respond_msg" ? 846609 : 0,
          errmsg: "req_id expired",
        });
      }, 2);
    };
  }
  const t = createRawWecomTransport({ botId: "b", secret: "s", WebSocketImpl: ReplyErr, pingMs: 50 });
  const ac = new AbortController();
  void t.start(async () => undefined, ac.signal);
  await sleep(25);
  await expect(t.send({ cmd: "aibot_respond_msg", headers: { req_id: "OLD" }, body: {} })).rejects.toBeInstanceOf(
    WecomApiError,
  );
  ac.abort();
});

test("rate-limit errcodes are retryable", () => {
  expect(new WecomApiError("busy", 45009).retryable).toBe(true);
  expect(new WecomApiError("expired", 846609).retryable).toBe(false);
  expect(wecomShouldRetry(new WecomApiError("invalid secret", 40058))).toBe(false);
  expect(wecomShouldRetry(new Error("wecom disconnected_event: another instance took over"))).toBe(true);
});

// https://developer.work.weixin.qq.com/document/path/96213
test("853000 and documented credential errors are fatal and stop reconnect", async () => {
  const credential = [40091, 41004, 41024, 846601, 853000] as const;
  for (const code of credential) {
    expect(WECOM_AUTH_ERRCODES.has(code)).toBe(true);
    expect(new WecomApiError("credential", code).fatal).toBe(true);
    expect(wecomShouldRetry(new WecomApiError("credential", code))).toBe(false);
  }
  expect(new WecomApiError("req_id expired", 846604).fatal).toBe(false);
  expect(wecomShouldRetry(new WecomApiError("req_id expired", 846604))).toBe(true);

  let connects = 0;
  const transport: WecomTransport = {
    async send() {
      return { errcode: 0 };
    },
    isAlive: () => false,
    stop() {},
    async start() {
      connects += 1;
      throw new WecomApiError("无效的 bot_id 或者 secret", 853000);
    },
  };
  const ad = new WecomAdapter({ botId: "b", secret: "s", transport });
  const ac = new AbortController();
  await ad.start(ac.signal);
  expect(connects).toBe(1);
});

test("disconnected_event stops the transport", async () => {
  const frames: unknown[] = [];
  const transport: WecomTransport = {
    async send(frame) {
      frames.push(frame);
      return { errcode: 0 };
    },
    isAlive: () => true,
    stop() {
      frames.push("stopped");
    },
    async start() {},
  };
  const ad = new WecomAdapter({ botId: "b", secret: "s", transport });
  const raw = {
    cmd: "aibot_event_callback",
    body: { event: { eventtype: "disconnected_event" } },
  };
  expect(isDisconnectedEvent(raw)).toBe(true);
  await expect(ad.ingest(raw)).rejects.toThrow(/another instance took over/);
  expect(frames).toContain("stopped");
});

test("bad secret is fatal and stops reconnect", async () => {
  let connects = 0;
  const transport: WecomTransport = {
    async send() {
      return { errcode: 0 };
    },
    isAlive: () => false,
    stop() {},
    async start() {
      connects += 1;
      throw new WecomApiError("invalid secret", 40058);
    },
  };
  const ad = new WecomAdapter({ botId: "b", secret: "s", transport });
  const ac = new AbortController();
  await ad.start(ac.signal);
  expect(connects).toBe(1);
});

test("reply map is a memory-bounded LRU", async () => {
  const frames: unknown[] = [];
  const transport: WecomTransport = {
    async send(frame) {
      frames.push(frame);
      return { errcode: 0 };
    },
    isAlive: () => true,
    stop() {},
    async start() {},
  };
  const ad = new WecomAdapter({ botId: "b", secret: "s", transport, replyMaxBytes: 2_000 });
  for (let i = 0; i < 80; i += 1) {
    ad.rememberReply(`c${i}`, `r${i}`, `m${i}`);
  }
  await expect(
    ad.send(
      { platform: "wecom", accountId: "b", chatId: "c0", kind: "dm" },
      { blocks: [{ kind: "markdown", text: "x" }] },
    ),
  ).rejects.toThrow(/no req_id/);
  await ad.send(
    { platform: "wecom", accountId: "b", chatId: "c79", kind: "dm" },
    { blocks: [{ kind: "markdown", text: "ok" }] },
  );
  expect(frames.length).toBeGreaterThan(0);
});

// https://developer.work.weixin.qq.com/document/path/101463
test("reply context is kept for the documented 24h window", async () => {
  const frames: unknown[] = [];
  const transport: WecomTransport = {
    async send(frame) {
      frames.push(frame);
      return { errcode: 0 };
    },
    isAlive: () => true,
    stop() {},
    async start() {},
  };
  let now = 1_700_000_000_000;
  const ad = new WecomAdapter({ botId: "b", secret: "s", transport, now: () => now });
  ad.rememberReply("c1", "req-24h", "m1");
  now += WECOM_REPLY_TTL_MS - 1;
  await ad.send(
    { platform: "wecom", accountId: "b", chatId: "c1", kind: "dm" },
    { blocks: [{ kind: "markdown", text: "still-in-window" }] },
  );
  const sent = frames.at(-1) as { headers?: { req_id?: string } };
  expect(sent.headers?.req_id).toBe("req-24h");

  now += 2;
  await expect(
    ad.send(
      { platform: "wecom", accountId: "b", chatId: "c1", kind: "dm" },
      { blocks: [{ kind: "markdown", text: "expired" }] },
    ),
  ).rejects.toThrow(/no req_id/);
});

test("reply context can persist across adapter restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wecom-reply-"));
  const path = join(dir, "store.json");
  const frames: unknown[] = [];
  const transport = (): WecomTransport => ({
    async send(frame) {
      frames.push(frame);
      return { errcode: 0 };
    },
    isAlive: () => true,
    stop() {},
    async start() {},
  });
  const first = new WecomAdapter({ botId: "b", secret: "s", transport: transport(), replyStorePath: path });
  first.rememberReply("c-persist", "req-persist", "m-persist");
  const restarted = new WecomAdapter({ botId: "b", secret: "s", transport: transport(), replyStorePath: path });
  await restarted.send(
    { platform: "wecom", accountId: "b", chatId: "c-persist", kind: "dm" },
    { blocks: [{ kind: "markdown", text: "after-restart" }] },
  );
  const sent = frames.at(-1) as { headers?: { req_id?: string } };
  expect(sent.headers?.req_id).toBe("req-persist");
});
