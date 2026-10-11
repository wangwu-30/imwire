import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { DingTalkAdapter } from "../src/adapter.js";
import { DINGTALK_STREAM_CONTENT_LIMIT } from "../src/capabilities.js";
import type { DingTalkHttp } from "../src/http.js";
import { mapDingTalkEvent } from "../src/map.js";
import { createRawDingTalkStream } from "../src/stream.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class MockWs extends EventEmitter {
  static last: MockWs | undefined;
  sent: unknown[] = [];
  closed = false;
  url: string;
  constructor(url: string) {
    super();
    this.url = url;
    MockWs.last = this;
    setTimeout(() => this.emit("open"), 5);
  }
  send(d: string) {
    if (this.closed) return;
    this.sent.push(JSON.parse(d));
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

// https://github.com/open-dingtalk/developerpedia/blob/main/docs/learn/stream/protocol.md
test("DT1 ping ack echoes the original data JSON string (opaque)", async () => {
  const http = { request: async () => ({ endpoint: "wss://mock", ticket: "t1" }) };
  const st = createRawDingTalkStream({
    clientId: "c",
    clientSecret: "s",
    http,
    WebSocketImpl: MockWs,
  });
  const ac = new AbortController();
  const started = st.start({ onEvent: async () => undefined }, ac.signal);
  await sleep(20);
  const ws = MockWs.last!;
  ws.push({
    specVersion: "1.0",
    type: "SYSTEM",
    headers: { topic: "ping", messageId: "m1", contentType: "application/json" },
    data: JSON.stringify({ opaque: "OP-123" }),
  });
  await sleep(10);
  const pong = ws.sent.at(-1) as { data?: unknown; headers?: { messageId?: string } };
  expect(typeof pong.data).toBe("string");
  expect(pong.data).toContain("OP-123");
  expect(pong.headers?.messageId).toBe("m1");
  ac.abort();
  await started;
});

// https://github.com/open-dingtalk/developerpedia/blob/main/docs/learn/stream/protocol.md
test("DT2 SYSTEM disconnect closes the socket and clears isAlive", async () => {
  const http = { request: async () => ({ endpoint: "wss://mock", ticket: "t1" }) };
  const st = createRawDingTalkStream({
    clientId: "c",
    clientSecret: "s",
    http,
    WebSocketImpl: MockWs,
  });
  const ac = new AbortController();
  const started = st.start({ onEvent: async () => undefined }, ac.signal);
  await sleep(20);
  const ws = MockWs.last!;
  ws.push({
    type: "SYSTEM",
    headers: { topic: "disconnect", messageId: "m2" },
    data: JSON.stringify({ reason: "server upgrade" }),
  });
  await expect(started).rejects.toThrow(/disconnect/);
  expect(ws.closed).toBe(true);
  expect(st.isAlive()).toBe(false);
  ac.abort();
});

// https://open.dingtalk.com/document/development/event-callback-card.md
test("DT3 card callback parses content JSON string and actionIds[0]", () => {
  const frame = {
    type: "CALLBACK",
    headers: { topic: "/v1.0/card/instances/callback", messageId: "m3" },
    data: JSON.stringify({
      type: "actionCallback",
      outTrackId: "card_1",
      corpId: "ding1",
      userId: "u1",
      content: JSON.stringify({
        cardPrivateData: { actionIds: ["approve"], params: { action: "approve", value: "req-9" } },
      }),
    }),
  };
  const ev = mapDingTalkEvent(frame, { accountId: "a" })[0];
  expect(ev?.type).toBe("action");
  if (ev?.type !== "action") return;
  expect(ev.actionId).toBe("approve");
  expect(ev.value).toBe("req-9");
});

test("card callback replies to the chat remembered at createAndDeliver, not the card id", async () => {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const http: DingTalkHttp = {
    async request(r) {
      calls.push({ path: r.path, body: r.body as Record<string, unknown> });
      return {};
    },
  };
  const ad = new DingTalkAdapter({
    clientId: "c",
    clientSecret: "s",
    robotCode: "ROBOT",
    cardTemplateId: "tpl",
    http,
    stream: { isAlive: () => false, stop() {}, async start() {} },
  });
  const chat = { platform: "dingtalk" as const, accountId: ad.accountId, chatId: "staff_1", kind: "dm" as const };
  await ad.send(chat, { blocks: [{ kind: "markdown", text: "hi" }] });
  const created = calls.find((c) => c.path.includes("createAndDeliver"));
  const outTrackId = created?.body?.outTrackId as string;
  const ev = mapDingTalkEvent(
    {
      type: "CALLBACK",
      headers: { topic: "/v1.0/card/instances/callback" },
      data: JSON.stringify({
        type: "actionCallback",
        outTrackId,
        userId: "u1",
        content: JSON.stringify({ cardPrivateData: { actionIds: ["ok"], params: { value: "v" } } }),
      }),
    },
    { accountId: ad.accountId, chatForTrack: (id) => (id === outTrackId ? chat : undefined) },
  )[0];
  expect(ev?.type).toBe("action");
  if (ev?.type !== "action") return;
  expect(ev.target.chat.chatId).toBe("staff_1");
  expect(ev.target.chat.chatId).not.toBe(outTrackId);
});

// https://open.dingtalk.com/document/development/create-and-deliver-cards.md
test("DT4 / DT5 createAndDeliver openSpaceId + deliver models", async () => {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const http: DingTalkHttp = {
    async request(r) {
      calls.push({ path: r.path, body: r.body as Record<string, unknown> });
      return {};
    },
  };
  const ad = new DingTalkAdapter({
    clientId: "c",
    clientSecret: "s",
    robotCode: "ROBOT",
    cardTemplateId: "tpl",
    http,
    stream: { isAlive: () => false, stop() {}, async start() {} },
  });
  await ad.send(
    { platform: "dingtalk", accountId: ad.accountId, chatId: "staff_1", kind: "dm" },
    { blocks: [{ kind: "markdown", text: "hi" }] },
  );
  const dm = calls.find((r) => r.path.includes("createAndDeliver"))?.body;
  expect(dm?.openSpaceId).toBe("dtv1.card//IM_ROBOT.staff_1");
  expect(dm?.imRobotOpenDeliverModel).toEqual({ spaceType: "IM_ROBOT", robotCode: "ROBOT" });
  expect(String(dm?.openSpaceId)).not.toContain("IM_ROBOT.ROBOT.");

  calls.length = 0;
  await ad.send(
    { platform: "dingtalk", accountId: ad.accountId, chatId: "cidG", kind: "group" },
    { blocks: [{ kind: "markdown", text: "hi" }] },
  );
  const g = calls.find((r) => r.path.includes("createAndDeliver"))?.body;
  expect(g?.openSpaceId).toBe("dtv1.card//IM_GROUP.cidG");
  expect(g?.imGroupOpenDeliverModel).toEqual({ robotCode: "ROBOT" });
});

test("DT6 expired sessionWebhook falls back to OpenAPI", async () => {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const http: DingTalkHttp = {
    async request(r) {
      calls.push({ path: r.path, body: r.body });
      return {};
    },
  };
  const ad = new DingTalkAdapter({
    clientId: "c",
    clientSecret: "s",
    robotCode: "ROBOT",
    http,
    stream: { isAlive: () => false, stop() {}, async start() {} },
  });
  await ad.ingest({
    conversationId: "cid9",
    conversationType: "2",
    msgId: "x1",
    text: { content: "hi" },
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=old",
    sessionWebhookExpiredTime: Date.now() - 3_600_000,
  });
  await ad.send(
    { platform: "dingtalk", accountId: ad.accountId, chatId: "cid9", kind: "group" },
    { blocks: [{ kind: "markdown", text: "late" }] },
  );
  expect(calls.at(-1)?.path).toBe("/v1.0/robot/groupMessages/send");
});

test("DT7 no card template: buttons capability off, no dead actionURL", async () => {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const http: DingTalkHttp = {
    async request(r) {
      calls.push({ path: r.path, body: r.body as Record<string, unknown> });
      return {};
    },
  };
  const ad = new DingTalkAdapter({
    clientId: "c",
    clientSecret: "s",
    robotCode: "ROBOT",
    http,
    stream: { isAlive: () => false, stop() {}, async start() {} },
  });
  expect(ad.capabilities.buttons).toBe(false);
  await ad.ingest({
    conversationId: "cid9",
    conversationType: "2",
    msgId: "x1",
    text: { content: "hi" },
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=fresh",
    sessionWebhookExpiredTime: Date.now() + 3_600_000,
  });
  await ad.send(
    { platform: "dingtalk", accountId: ad.accountId, chatId: "cid9", kind: "group" },
    {
      blocks: [
        { kind: "markdown", text: "pick" },
        { kind: "buttons", buttons: [{ id: "ok", label: "OK" }] },
      ],
    },
  );
  const last = calls.at(-1)?.body;
  expect(JSON.stringify(last ?? {})).not.toContain("imwire.invalid");
  expect(ad.capabilities.streaming).toBe("buffer");
});

// https://open.dingtalk.com/document/development/api-streamingupdate.md
test("streaming card updates stay within 1 KB; overflow is follow-up messages", async () => {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const http: DingTalkHttp = {
    async request(r) {
      calls.push({ path: r.path, body: r.body as Record<string, unknown> });
      return {};
    },
  };
  const ad = new DingTalkAdapter({
    clientId: "c",
    clientSecret: "s",
    cardTemplateId: "tpl",
    http,
    stream: { isAlive: () => false, stop() {}, async start() {} },
    draftThrottleMs: 0,
  });
  const chat = { platform: "dingtalk" as const, accountId: ad.accountId, chatId: "staff_1", kind: "dm" as const };
  const draft = await ad.draft(chat);
  draft.append("x".repeat(5000));
  await draft.finalize({ blocks: [{ kind: "markdown", text: "x".repeat(5000) }] });
  const stream = calls.filter((c) => c.path === "/v1.0/card/streaming");
  expect(stream.length).toBeGreaterThan(0);
  for (const c of stream) {
    const content = String(c.body?.content ?? "");
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(DINGTALK_STREAM_CONTENT_LIMIT);
  }
  expect(calls.some((c) => c.path.includes("oToMessages") || c.path.includes("groupMessages"))).toBe(true);
});

test("4.5KB reply is fully delivered (card + follow-ups)", async () => {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const http: DingTalkHttp = {
    async request(r) {
      calls.push({ path: r.path, body: r.body as Record<string, unknown> });
      return {};
    },
  };
  const ad = new DingTalkAdapter({
    clientId: "c",
    clientSecret: "s",
    robotCode: "ROBOT",
    cardTemplateId: "tpl",
    http,
    stream: { isAlive: () => false, stop() {}, async start() {} },
  });
  const text = "x".repeat(4500);
  await ad.send(
    { platform: "dingtalk", accountId: ad.accountId, chatId: "staff_1", kind: "dm" },
    { blocks: [{ kind: "markdown", text }] },
  );
  const pieces: string[] = [];
  for (const c of calls) {
    const body = c.body ?? {};
    if (typeof body.content === "string") pieces.push(body.content);
    const card = body.cardData as { cardParamMap?: { content?: string } } | undefined;
    if (typeof card?.cardParamMap?.content === "string") pieces.push(card.cardParamMap.content);
    if (typeof body.msgParam === "string") {
      try {
        const parsed = JSON.parse(body.msgParam) as { text?: string };
        if (parsed.text) pieces.push(parsed.text);
      } catch {
        // ignore
      }
    }
  }
  const xs = pieces.join("").replace(/[^x]/g, "");
  expect(xs.length).toBeGreaterThanOrEqual(4500);
});
