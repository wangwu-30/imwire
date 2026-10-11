import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineAdapterContract, type OutboundCall } from "@imwire/core/testing";
import { WecomAdapter } from "../src/adapter.js";
import type { WecomFrame, WecomTransport } from "../src/transport.js";

const dir = dirname(fileURLToPath(import.meta.url));
const load = (name: string): unknown => JSON.parse(readFileSync(join(dir, "fixtures", name), "utf8"));

/**
 * Fixtures copied from official 智能机器人长连接 examples:
 * https://developer.work.weixin.qq.com/document/path/101463
 * - aibot_msg_callback text body {msgid, chatid, chattype, from.userid, text.content}
 * - aibot_event_callback template_card_event
 * Reply-only: outbound is always aibot_respond_msg with the inbound req_id.
 */
function createHarness() {
  const calls: OutboundCall[] = [];
  let stopped = true;
  const transport: WecomTransport = {
    async send(frame: WecomFrame) {
      const stream = frame.body && typeof frame.body === "object" ? (frame.body as { stream?: { finish?: boolean } }).stream : undefined;
      const op =
        frame.cmd === "aibot_respond_update_msg"
          ? "edit"
          : stream && stream.finish
            ? "streamFinish"
            : stream
              ? "streamUpdate"
              : "send";
      if (frame.cmd === "aibot_respond_msg" && stream && !calls.some((c) => c.op === "streamStart")) {
        calls.push({ op: "streamStart", args: frame });
      }
      calls.push({ op, args: frame });
      return { errcode: 0 };
    },
    isAlive: () => !stopped,
    stop() {
      stopped = true;
    },
    async start(_onFrame, signal) {
      stopped = false;
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          stopped = true;
          resolve();
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            stopped = true;
            resolve();
          },
          { once: true },
        );
      });
    },
  };

  const adapter = new WecomAdapter({
    botId: "aibot_test",
    secret: "secret",
    transport,
    draftThrottleMs: 0,
  });
  adapter.rememberReply("CHATID_DM", "req-seed", "MSGID_HELLO");

  return {
    adapter,
    emit: async (raw: unknown) => {
      await adapter.ingest(raw);
    },
    calls: () => calls,
    fixtures: {
      message: load("message.json"),
      action: load("card-action.json"),
    },
    expectedMessage: { text: "hello", chatId: "CHATID_DM", userId: "USERID_ADA" },
    chat: { platform: "wecom" as const, accountId: "aibot_test", chatId: "CHATID_DM", kind: "dm" as const },
  };
}

defineAdapterContract("wecom", createHarness);
