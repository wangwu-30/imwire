import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { mapSlackEvent } from "../src/map.js";

const dir = dirname(fileURLToPath(import.meta.url));
const load = (name: string): unknown => JSON.parse(readFileSync(join(dir, "fixtures", name), "utf8"));

// https://docs.slack.dev/apis/events-api/using-socket-mode
test("maps official Socket Mode events_api message", () => {
  const events = mapSlackEvent(load("message.json"), { accountId: "slack" });
  expect(events).toHaveLength(1);
  const msg = events[0];
  expect(msg?.type).toBe("message");
  if (msg?.type !== "message") return;
  expect(msg.chat.chatId).toBe("D111");
  expect(msg.chat.kind).toBe("dm");
  expect(msg.from.userId).toBe("U111");
  expect(msg.text).toBe("hello");
  expect(msg.messageId).toBe("1710000000.000100");
});

// https://docs.slack.dev/apis/events-api/using-socket-mode#button
test("maps official Socket Mode block_actions button", () => {
  const events = mapSlackEvent(load("block-actions.json"), { accountId: "slack" });
  expect(events).toHaveLength(1);
  const action = events[0];
  expect(action?.type).toBe("action");
  if (action?.type !== "action") return;
  expect(action.actionId).toBe("approve");
  expect(action.value).toBe("ok");
  expect(action.target.messageId).toBe("1548261231.000200");
  expect(action.target.chat.chatId).toBe("D111");
});

test("threads: thread_ts becomes chat.threadId and replyTo", () => {
  const events = mapSlackEvent(
    {
      type: "events_api",
      payload: {
        event: {
          type: "message",
          channel: "C999",
          user: "U2",
          text: "in thread",
          ts: "1710000001.000200",
          thread_ts: "1710000000.000100",
          channel_type: "channel",
        },
      },
    },
    { accountId: "slack" },
  );
  const msg = events[0];
  expect(msg?.type).toBe("message");
  if (msg?.type !== "message") return;
  expect(msg.chat.kind).toBe("group");
  expect(msg.chat.threadId).toBe("1710000000.000100");
  expect(msg.replyTo?.messageId).toBe("1710000000.000100");
});
