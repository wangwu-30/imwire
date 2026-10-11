import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineAdapterContract, type OutboundCall } from "@imwire/core/testing";
import { DingTalkAdapter } from "../src/adapter.js";
import type { DingTalkHttp } from "../src/http.js";
import type { DingTalkStream } from "../src/stream.js";

const dir = dirname(fileURLToPath(import.meta.url));
const load = (name: string): unknown => JSON.parse(readFileSync(join(dir, "fixtures", name), "utf8"));

/**
 * Fixtures follow official Stream CALLBACK envelopes:
 * - robot: https://open.dingtalk.com/document/dingstart/robot-receive-message
 *   topic `/v1.0/im/bot/messages/get`
 *   https://open.dingtalk.com/document/resourcedownload/introduction-to-stream-mode.md
 * - card: topic `/v1.0/card/instances/callback` (same Stream intro)
 * AI card updates: PUT /v1.0/card/streaming
 *   https://open.dingtalk.com/document/orgapp/api-streamingupdate
 */
function createHarness() {
  const calls: OutboundCall[] = [];
  const http: DingTalkHttp = {
    async request({ method, path, body }) {
      const op =
        path.includes("/card/streaming")
          ? "streamUpdate"
          : path.includes("/card/instances/createAndDeliver")
            ? "streamStart"
            : path.includes("sendBySession") || path.includes("oToMessages") || path.includes("groupMessages")
              ? "send"
              : method === "PUT"
                ? "edit"
                : "send";
      calls.push({ op, args: { method, path, body } });
      return { accessToken: "tok", endpoint: "wss://example.test/connect", ticket: "t", outTrackId: "card-1" };
    },
  };

  let stopped = true;
  const stream: DingTalkStream = {
    isAlive: () => !stopped,
    stop() {
      stopped = true;
    },
    async start(_handlers, signal) {
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

  const adapter = new DingTalkAdapter({
    clientId: "ding_app",
    clientSecret: "secret",
    http,
    stream,
    draftThrottleMs: 0,
  });
  adapter.rememberSession("cid_dm_1", "https://oapi.dingtalk.com/robot/sendBySession?session=test");

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
    expectedMessage: { text: "hello", chatId: "cid_dm_1", userId: "staff_ada" },
    chat: { platform: "dingtalk" as const, accountId: "ding_app", chatId: "cid_dm_1", kind: "dm" as const },
  };
}

defineAdapterContract("dingtalk", createHarness);
