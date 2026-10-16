import { expect, it, vi } from "vitest";
import { TelegramAdapter } from "../src/adapter.js";

it("sends text literally with no parse_mode; durable caller can disable internal retries", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })));
  const adapter = new TelegramAdapter({ token: "test", fetch });
  const chat = { platform: "telegram", accountId: "telegram", chatId: "123", kind: "dm" as const };
  const text = "[link](https://invalid.test) @all";
  await adapter.send(chat, { blocks: [{ kind: "text", text }] }, { maxAttempts: 1 });
  const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [unknown, RequestInit])[1].body));
  expect(body.text).toBe(text);
  expect(body.parse_mode).toBeUndefined();
  fetch.mockImplementation(async () => new Response(JSON.stringify({ ok: false, error_code: 503 }), { status: 503 }));
  await expect(adapter.send(chat, { blocks: [{ kind: "text", text }] }, { maxAttempts: 1 })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(2);
});
