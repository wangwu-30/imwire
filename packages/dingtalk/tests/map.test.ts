import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { mapDingTalkEvent, robotSessionOf } from "../src/map.js";

const dir = dirname(fileURLToPath(import.meta.url));
const load = (name: string): unknown => JSON.parse(readFileSync(join(dir, "fixtures", name), "utf8"));

// https://open.dingtalk.com/document/dingstart/robot-receive-message
test("maps official robot Stream CALLBACK (conversationType 1 = dm)", () => {
  const events = mapDingTalkEvent(load("message.json"), { accountId: "ding_app" });
  expect(events).toHaveLength(1);
  const msg = events[0];
  expect(msg?.type).toBe("message");
  if (msg?.type !== "message") return;
  expect(msg.chat.chatId).toBe("cid_dm_1");
  expect(msg.chat.kind).toBe("dm");
  expect(msg.from.userId).toBe("staff_ada");
  expect(msg.text).toBe("hello");
  expect(msg.mentionsBot).toBe(true);
  expect(robotSessionOf(load("message.json"))?.webhook).toContain("sendBySession");
});

// https://open.dingtalk.com/document/resourcedownload/introduction-to-stream-mode.md
test("maps official card callback topic to action", () => {
  const events = mapDingTalkEvent(load("card-action.json"), { accountId: "ding_app" });
  expect(events).toHaveLength(1);
  const action = events[0];
  expect(action?.type).toBe("action");
  if (action?.type !== "action") return;
  expect(action.actionId).toBe("approve");
  expect(action.value).toBe("ok");
  expect(action.target.messageId).toBe("card-track-1");
});

test("group conversationType 2", () => {
  const events = mapDingTalkEvent(
    {
      conversationId: "cid_group",
      conversationType: "2",
      senderStaffId: "u1",
      msgId: "m1",
      text: { content: "/topic work" },
      isInAtList: true,
    },
    { accountId: "ding_app" },
  );
  expect(events[0]?.type).toBe("command");
  if (events[0]?.type !== "command") return;
  expect(events[0].chat.kind).toBe("group");
  expect(events[0].name).toBe("topic");
  expect(events[0].args).toBe("work");
});
