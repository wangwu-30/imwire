import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mapFeishuEvent } from "../src/map.js";

const dir = dirname(fileURLToPath(import.meta.url));
const load = (name: string): unknown => JSON.parse(readFileSync(join(dir, "fixtures", name), "utf8"));

const ctx = { accountId: "cli_test", botOpenId: "ou_bot" };

describe("mapFeishuEvent", () => {
  it("maps im.message.receive_v1 in a DM", () => {
    const [event] = mapFeishuEvent(load("message.json"), ctx);
    expect(event?.type).toBe("message");
    if (event?.type !== "message") return;
    expect(event.text).toBe("hello");
    expect(event.chat.kind).toBe("dm");
    expect(event.chat.chatId).toBe("oc_dm_1");
    expect(event.from.userId).toBe("ou_sender");
    expect(event.mentionsBot).toBe(true);
    expect(event.replyTo?.messageId).toBe("om_parent");
    expect(event.id).toBe("5e3702a84e847582be8db7fb73283c02");
  });

  it("maps card.action.trigger to an approval callback", () => {
    const [event] = mapFeishuEvent(load("card-action.json"), ctx);
    expect(event?.type).toBe("action");
    if (event?.type !== "action") return;
    expect(event.actionId).toBe("approve");
    expect(event.target.messageId).toBe("om_card_1");
    expect(event.from.userId).toBe("ou_operator");
  });

  it("maps an image in a group thread with a bot mention", () => {
    const [event] = mapFeishuEvent(load("image.json"), ctx);
    expect(event?.type).toBe("message");
    if (event?.type !== "message") return;
    expect(event.chat.kind).toBe("group");
    expect(event.chat.threadId).toBe("omt_thread");
    expect(event.mentionsBot).toBe(true);
    expect(event.media?.[0]).toEqual({ id: "om_img/img_xxx", kind: "image" });
  });

  it("maps the EventDispatcher-unwrapped body", () => {
    const [event] = mapFeishuEvent(
      {
        sender: { sender_id: { open_id: "ou_x" }, sender_type: "user" },
        message: {
          message_id: "om_1",
          chat_id: "oc_1",
          chat_type: "p2p",
          message_type: "text",
          content: "{\"text\":\"ping\"}",
        },
      },
      ctx,
      "im.message.receive_v1",
    );
    expect(event?.type).toBe("message");
    if (event?.type === "message") expect(event.text).toBe("ping");
  });
});
