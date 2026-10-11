import { sendJson, listenJson, type JsonServer, type MockRequest } from "./http.js";

export interface TelegramMock extends JsonServer {
  token: string;
  texts: () => string[];
  lastCallbackData: () => string | undefined;
  lastApprovalId: () => string | undefined;
}

export async function startTelegramMock(token = "TEST:token"): Promise<TelegramMock> {
  let seq = 0;
  const releaseUpdates: Array<() => void> = [];
  const server = await listenJson((req, res) => {
    const method = telegramMethod(req.path, token);
    if (method === "getMe") {
      sendJson(res, { ok: true, result: { id: 999, is_bot: true, username: "imwirebot" } });
      return;
    }
    if (method === "sendMessage") {
      seq += 1;
      const body = asRecord(req.body);
      sendJson(res, {
        ok: true,
        result: { message_id: seq, chat: { id: body?.chat_id ?? 0 } },
      });
      return;
    }
    if (method === "editMessageText") {
      const body = asRecord(req.body);
      sendJson(res, {
        ok: true,
        result: { message_id: body?.message_id ?? seq, chat: { id: body?.chat_id ?? 0 } },
      });
      return;
    }
    if (
      method === "answerCallbackQuery" ||
      method === "sendChatAction" ||
      method === "setMessageReaction" ||
      method === "deleteMessage" ||
      method === "deleteWebhook"
    ) {
      sendJson(res, { ok: true, result: true });
      return;
    }
    if (method === "getUpdates") {
      // Hang until close() so adapter.start() can call getMe without busy-looping.
      return new Promise<void>((resolve) => {
        releaseUpdates.push(() => {
          if (!res.writableEnded) sendJson(res, { ok: true, result: [] });
          resolve();
        });
      });
    }
    sendJson(res, { ok: true, result: {} });
  });

  return {
    ...server,
    token,
    texts: () => collectTelegramTexts(server.requests),
    lastCallbackData: () => lastCallback(server.requests),
    lastApprovalId: () => {
      const data = lastCallback(server.requests);
      if (!data) return undefined;
      const idx = data.indexOf(":");
      return idx === -1 ? undefined : data.slice(idx + 1);
    },
    close: async () => {
      for (const release of releaseUpdates.splice(0)) release();
      await server.close();
    },
  };
}

function telegramMethod(path: string, token: string): string {
  const prefix = `/bot${token}/`;
  if (path.startsWith(prefix)) return path.slice(prefix.length);
  const parts = path.split("/");
  return parts[parts.length - 1] ?? "";
}

function collectTelegramTexts(requests: MockRequest[]): string[] {
  const out: string[] = [];
  for (const req of requests) {
    const method = req.path.split("/").pop();
    if (method !== "sendMessage" && method !== "editMessageText") continue;
    const text = asString(asRecord(req.body)?.text);
    if (text) out.push(text);
  }
  return out;
}

function lastCallback(requests: MockRequest[]): string | undefined {
  for (let i = requests.length - 1; i >= 0; i -= 1) {
    const body = asRecord(requests[i]?.body);
    const keyboard = asRecord(body?.reply_markup)?.inline_keyboard;
    if (!Array.isArray(keyboard)) continue;
    for (const row of keyboard) {
      if (!Array.isArray(row)) continue;
      for (const btn of row) {
        const data = asString(asRecord(btn)?.callback_data);
        if (data) return data;
      }
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
