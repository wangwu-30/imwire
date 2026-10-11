import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { SlackAdapter } from "../src/adapter.js";
import type { SlackWeb } from "../src/api.js";
import { mapSlackEvent } from "../src/map.js";
import { createRawSlackSocket, type SlackSocket } from "../src/socket.js";

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

// https://docs.slack.dev/apis/events-api/using-socket-mode
test("SL1 bot_id / own user messages are dropped", async () => {
  const inbound: unknown[] = [];
  const web: SlackWeb = {
    async call(m) {
      return m === "chat.postMessage" ? { ok: true, ts: "1700000000.000200" } : { ok: true };
    },
  };
  const ad = new SlackAdapter({ botToken: "xoxb-x", botUserId: "UBOT", web });
  ad.on(async (e) => {
    inbound.push(e);
  });
  await ad.ingest({
    envelope_id: "e1",
    type: "events_api",
    payload: {
      event_id: "Ev1",
      event: {
        type: "message",
        channel: "D1",
        channel_type: "im",
        user: "UBOT",
        bot_id: "BBOT",
        text: "echo: hi",
        ts: "1700000000.000200",
      },
    },
  });
  expect(inbound).toEqual([]);
});

test("SL2 mention detection is only the bot's user id", async () => {
  const inbound: Array<{ mentionsBot?: boolean }> = [];
  const ad = new SlackAdapter({
    botToken: "xoxb-x",
    botUserId: "UBOT",
    web: { async call() { return { ok: true }; } },
  });
  ad.on(async (e) => {
    inbound.push(e as { mentionsBot?: boolean });
  });
  await ad.ingest({
    envelope_id: "e2",
    type: "events_api",
    payload: {
      event: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        text: "ping <@U999OTHER>",
        ts: "1700000000.000300",
      },
    },
  });
  expect(inbound[0]?.mentionsBot).toBe(false);

  inbound.length = 0;
  await ad.ingest({
    envelope_id: "e3",
    type: "events_api",
    payload: {
      event: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        text: "hey <@UBOT>",
        ts: "1700000000.000400",
      },
    },
  });
  expect(inbound[0]?.mentionsBot).toBe(true);
});

test("auth.test on connect sets botUserId used by the self-filter", async () => {
  const methods: string[] = [];
  const web: SlackWeb = {
    async call(m) {
      methods.push(m);
      if (m === "auth.test") return { user_id: "UBOT" };
      return { ok: true };
    },
  };
  const socket: SlackSocket = {
    isAlive: () => true,
    stop() {},
    async ack() {},
    async start() {},
  };
  const ad = new SlackAdapter({ botToken: "xoxb-x", web, socket });
  const ac = new AbortController();
  await ad.connect(ac.signal);
  expect(methods).toContain("auth.test");
  const events = mapSlackEvent(
    {
      type: "events_api",
      payload: { event: { type: "message", channel: "D1", channel_type: "im", user: "UBOT", text: "x", ts: "1.0" } },
    },
    { accountId: "slack", botUserId: "UBOT" },
  );
  expect(events).toEqual([]);
  ac.abort();
});

// https://docs.slack.dev/apis/events-api/using-socket-mode#disconnect
test("disconnect: warning stays up, refresh closes, link_disabled closes and stops", async () => {
  const web: SlackWeb = {
    async call() {
      return { url: "wss://mock" };
    },
  };
  const sock = createRawSlackSocket({ web, WebSocketImpl: MockWs });
  const ac = new AbortController();
  const started = sock.start({ onEnvelope: async () => undefined }, ac.signal);
  await sleep(20);
  const ws = MockWs.last!;
  ws.push({ type: "disconnect", reason: "warning" });
  await sleep(10);
  expect(ws.closed).toBe(false);
  expect(sock.isAlive()).toBe(true);

  ws.push({ type: "disconnect", reason: "link_disabled" });
  await expect(started).rejects.toThrow(/link_disabled/);
  expect(ws.closed).toBe(true);
  expect(sock.isAlive()).toBe(false);

  const sock2 = createRawSlackSocket({ web, WebSocketImpl: MockWs });
  const ac2 = new AbortController();
  const started2 = sock2.start({ onEnvelope: async () => undefined }, ac2.signal);
  await sleep(20);
  MockWs.last!.push({ type: "disconnect", reason: "refresh_requested" });
  await started2;
  expect(MockWs.last!.closed).toBe(true);
  ac.abort();
  ac2.abort();
});
