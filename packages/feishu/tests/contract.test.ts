import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineAdapterContract, type OutboundCall } from "@imwire/core/testing";
import { FeishuAdapter } from "../src/adapter.js";
import type { FeishuHttp } from "../src/http.js";
import type { FeishuRealtime } from "../src/realtime.js";

const dir = dirname(fileURLToPath(import.meta.url));
const load = (name: string): unknown => JSON.parse(readFileSync(join(dir, "fixtures", name), "utf8"));

function createHarness() {
  const calls: OutboundCall[] = [];
  let seq = 0;
  const http: FeishuHttp = {
    async request({ method, path, body }) {
      const op =
        path.includes("/cardkit/") && method === "POST"
          ? "streamStart"
          : path.includes("/content")
            ? "streamUpdate"
            : path.includes("/settings")
              ? "streamFinish"
              : method === "PATCH"
                ? "edit"
                : "send";
      calls.push({ op, args: { method, path, body } });
      seq += 1;
      if (path.includes("/cardkit/v1/cards") && method === "POST") return { card_id: `card-${seq}` };
      return { message_id: `om-${seq}` };
    },
    async requestBytes() {
      return new Uint8Array([0]);
    },
  };

  const realtime: FeishuRealtime = {
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
  let stopped = true;

  const adapter = new FeishuAdapter({
    appId: "cli_test",
    appSecret: "secret",
    http,
    realtime,
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
      action: load("card-action.json"),
    },
    expectedMessage: { text: "hello", chatId: "oc_dm_1", userId: "ou_sender" },
    chat: { platform: "feishu" as const, accountId: "cli_test", chatId: "oc_dm_1", kind: "dm" as const },
  };
}

defineAdapterContract("feishu", createHarness);
