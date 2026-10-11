import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineAdapterContract, type OutboundCall } from "@imwire/core/testing";
import { TelegramAdapter } from "../src/adapter.js";
import type { TelegramFetch } from "../src/api.js";

const dir = dirname(fileURLToPath(import.meta.url));
const load = (name: string): unknown => JSON.parse(readFileSync(join(dir, "fixtures", name), "utf8"));

function jsonResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function createHarness() {
  const calls: OutboundCall[] = [];
  let seq = 0;
  const fetchFn: TelegramFetch = async (input, init) => {
    const url = String(input);
    const method = url.split("/").pop() ?? "";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ op: method === "sendChatAction" ? "typing" : method === "editMessageText" ? "edit" : "send", args: { method, body } });
    if (init?.signal?.aborted) throw abortError();
    if (method === "getMe") return jsonResponse({ id: 999, is_bot: true, username: "imwirebot" });
    if (method === "getUpdates") {
      await new Promise<void>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal || signal.aborted) {
          reject(abortError());
          return;
        }
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    }
    if (method === "sendMessage") {
      seq += 1;
      return jsonResponse({ message_id: seq, chat: { id: body.chat_id } });
    }
    if (method === "editMessageText") return jsonResponse({ message_id: body.message_id, chat: { id: body.chat_id } });
    if (method === "answerCallbackQuery" || method === "sendChatAction" || method === "setMessageReaction") {
      return jsonResponse(true);
    }
    return jsonResponse({});
  };

  const adapter = new TelegramAdapter({
    token: "TEST:token",
    accountId: "999",
    fetch: fetchFn,
    pollTimeoutSec: 1,
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
      action: load("callback.json"),
      edit: load("edit.json"),
    },
    expectedMessage: { text: "hello", chatId: "111", userId: "111" },
    chat: { platform: "telegram" as const, accountId: "999", chatId: "111", kind: "dm" as const },
  };
}

defineAdapterContract("telegram", createHarness);
