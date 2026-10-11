import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { WecomAdapter } from "../src/adapter.js";
import { mapWecomEvent, replyContextOf } from "../src/map.js";
import type { WecomFrame, WecomTransport } from "../src/transport.js";

const dir = dirname(fileURLToPath(import.meta.url));
const load = (name: string): unknown => JSON.parse(readFileSync(join(dir, "fixtures", name), "utf8"));

// https://developer.work.weixin.qq.com/document/path/101463
test("maps official aibot_msg_callback text", () => {
  const events = mapWecomEvent(load("message.json"), { accountId: "aibot_test" });
  expect(events).toHaveLength(1);
  const msg = events[0];
  expect(msg?.type).toBe("message");
  if (msg?.type !== "message") return;
  expect(msg.chat.chatId).toBe("CHATID_DM");
  expect(msg.chat.kind).toBe("dm");
  expect(msg.from.userId).toBe("USERID_ADA");
  expect(msg.text).toBe("hello");
  expect(replyContextOf(load("message.json"))?.reqId).toBe("req-hello-1");
});

// https://developer.work.weixin.qq.com/document/path/101463
test("maps official template_card_event", () => {
  const events = mapWecomEvent(load("card-action.json"), { accountId: "aibot_test" });
  expect(events).toHaveLength(1);
  const action = events[0];
  expect(action?.type).toBe("action");
  if (action?.type !== "action") return;
  expect(action.actionId).toBe("approve");
  expect(action.target.messageId).toBe("TASK_APPROVE");
});

test("send() uses aibot_respond_msg with inbound req_id, never aibot_send_msg", async () => {
  const frames: WecomFrame[] = [];
  const transport: WecomTransport = {
    async send(frame) {
      frames.push(frame);
      return { errcode: 0 };
    },
    isAlive: () => true,
    stop() {},
    async start() {},
  };
  const adapter = new WecomAdapter({ botId: "aibot_test", secret: "s", transport, draftThrottleMs: 0 });
  await adapter.ingest(load("message.json"));
  await adapter.send(
    { platform: "wecom", accountId: "aibot_test", chatId: "CHATID_DM", kind: "dm" },
    { blocks: [{ kind: "markdown", text: "pong" }] },
  );
  expect(frames.every((f) => f.cmd !== "aibot_send_msg")).toBe(true);
  expect(frames.some((f) => f.cmd === "aibot_respond_msg" && f.headers?.req_id === "req-hello-1")).toBe(true);
});

test("group @ text still maps chatid", () => {
  const events = mapWecomEvent(
    {
      cmd: "aibot_msg_callback",
      headers: { req_id: "r2" },
      body: {
        msgid: "m2",
        chatid: "CHAT_GROUP",
        chattype: "group",
        from: { userid: "u1" },
        msgtype: "text",
        text: { content: "@RobotA hello robot" },
      },
    },
    { accountId: "bot" },
  );
  expect(events[0]?.type).toBe("message");
  if (events[0]?.type !== "message") return;
  expect(events[0].chat.kind).toBe("group");
  expect(events[0].chat.chatId).toBe("CHAT_GROUP");
});
