import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineAdapterContract, type OutboundCall } from "@imwire/core/testing";
import { SlackAdapter } from "../src/adapter.js";
import type { SlackWeb } from "../src/api.js";
import type { SlackSocket } from "../src/socket.js";

const dir = dirname(fileURLToPath(import.meta.url));
const load = (name: string): unknown => JSON.parse(readFileSync(join(dir, "fixtures", name), "utf8"));

/**
 * Fixtures follow official Socket Mode envelopes:
 * https://docs.slack.dev/apis/events-api/using-socket-mode
 * - events_api + message (channel_type im)
 * - interactive + block_actions button (same page, Block Kit buttons)
 * Streaming uses chat.update (chat.startStream is documented but unverified).
 * https://docs.slack.dev/reference/methods/chat.update
 */
function createHarness() {
  const calls: OutboundCall[] = [];
  let seq = 0;
  const web: SlackWeb = {
    async call(method, body) {
      const op = method === "chat.update" ? "edit" : method === "chat.delete" ? "delete" : "send";
      calls.push({ op, args: { method, body } });
      if (method === "chat.postMessage") {
        seq += 1;
        return { ok: true, ts: `1710000000.00${String(seq).padStart(4, "0")}` };
      }
      return { ok: true };
    },
  };

  let stopped = true;
  const socket: SlackSocket = {
    isAlive: () => !stopped,
    stop() {
      stopped = true;
    },
    async ack() {},
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

  const adapter = new SlackAdapter({
    botToken: "xoxb-test",
    appToken: "xapp-test",
    accountId: "slack",
    web,
    socket,
    draftThrottleMs: 0,
  });

  return {
    adapter,
    emit: async (raw: unknown) => {
      await adapter.ingest(raw);
    },
    calls: () => calls,
    fixtures: {
      message: load("message.json"),
      action: load("block-actions.json"),
    },
    expectedMessage: { text: "hello", chatId: "D111", userId: "U111" },
    chat: { platform: "slack" as const, accountId: "slack", chatId: "D111", kind: "dm" as const },
  };
}

defineAdapterContract("slack", createHarness);
