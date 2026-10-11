import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mapTelegramUpdate } from "../src/map.js";

const dir = dirname(fileURLToPath(import.meta.url));
const load = (name: string): unknown => JSON.parse(readFileSync(join(dir, "fixtures", name), "utf8"));

const ctx = { accountId: "bot123", botUserId: "999", botUsername: "imwirebot" };

describe("mapTelegramUpdate", () => {
  it("maps a private text message", () => {
    const [event] = mapTelegramUpdate(load("message.json"), ctx);
    expect(event?.type).toBe("message");
    if (event?.type !== "message") return;
    expect(event.text).toBe("hello");
    expect(event.chat.kind).toBe("dm");
    expect(event.chat.chatId).toBe("111");
    expect(event.from.userId).toBe("111");
    expect(event.mentionsBot).toBe(true);
    expect(event.id).toBe("msg:1001:42");
  });

  it("maps an edited message", () => {
    const [event] = mapTelegramUpdate(load("edit.json"), ctx);
    expect(event?.type).toBe("edit");
    if (event?.type !== "edit") return;
    expect(event.text).toBe("hello, edited");
    expect(event.target.messageId).toBe("42");
  });

  it("maps an inline-keyboard callback to an action", () => {
    const [event] = mapTelegramUpdate(load("callback.json"), ctx);
    expect(event?.type).toBe("action");
    if (event?.type !== "action") return;
    expect(event.actionId).toBe("approve");
    expect(event.target.messageId).toBe("99");
  });

  it("splits callback_data into actionId and value", () => {
    const [event] = mapTelegramUpdate(
      {
        update_id: 9,
        callback_query: {
          id: "cbq",
          from: { id: 1, first_name: "A" },
          message: { message_id: 2, chat: { id: 1, type: "private" } },
          data: "approve:call_42",
        },
      },
      ctx,
    );
    expect(event?.type).toBe("action");
    if (event?.type === "action") {
      expect(event.actionId).toBe("approve");
      expect(event.value).toBe("call_42");
    }
  });

  it("ignores message_thread_id unless is_topic_message", () => {
    const [event] = mapTelegramUpdate(
      {
        update_id: 8,
        message: {
          message_id: 3,
          from: { id: 1, first_name: "A" },
          chat: { id: -9, type: "supergroup" },
          date: 1,
          message_thread_id: 99,
          text: "reply in a normal group",
        },
      },
      ctx,
    );
    expect(event?.type).toBe("message");
    if (event?.type === "message") expect(event.chat.threadId).toBeUndefined();
  });

  it("maps photo, thread, reply, and mention", () => {
    const [event] = mapTelegramUpdate(load("photo.json"), ctx);
    expect(event?.type).toBe("message");
    if (event?.type !== "message") return;
    expect(event.chat.kind).toBe("group");
    expect(event.chat.threadId).toBe("7");
    expect(event.replyTo?.messageId).toBe("49");
    expect(event.media?.[0]?.id).toBe("large");
    expect(event.media?.[0]?.kind).toBe("image");
    expect(event.mentionsBot).toBe(true);
  });

  it("maps a reaction add", () => {
    const [event] = mapTelegramUpdate(load("reaction.json"), ctx);
    expect(event?.type).toBe("reaction");
    if (event?.type !== "reaction") return;
    expect(event.emoji).toBe("👍");
    expect(event.added).toBe(true);
  });

  it("maps slash commands", () => {
    const [event] = mapTelegramUpdate(
      {
        update_id: 9,
        message: {
          message_id: 1,
          from: { id: 1, first_name: "A" },
          chat: { id: 1, type: "private" },
          date: 1,
          text: "/pair 123456",
        },
      },
      ctx,
    );
    expect(event?.type).toBe("command");
    if (event?.type !== "command") return;
    expect(event.name).toBe("pair");
    expect(event.args).toBe("123456");
  });
});
