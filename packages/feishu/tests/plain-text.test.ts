import { expect, it, vi } from "vitest";
import { FeishuAdapter } from "../src/adapter.js";

it("sends literal text, not interactive Markdown, and targets bound open_id", async () => {
  const request = vi.fn(async () => ({ message_id: "om_1" }));
  const adapter = new FeishuAdapter({ appId: "app", appSecret: "test", http: { request, requestBytes: async () => new Uint8Array() } });
  const chat = { platform: "feishu", accountId: "app", chatId: "ou_person", kind: "dm" as const };
  const text = "[link](https://invalid.test) @all";
  await adapter.send(chat, { blocks: [{ kind: "text", text }] }, { maxAttempts: 1 });
  expect(request).toHaveBeenCalledWith({ method: "POST", path: "/open-apis/im/v1/messages",
    query: { receive_id_type: "open_id" }, body: { receive_id: "ou_person", msg_type: "text", content: JSON.stringify({ text }) } });
  request.mockRejectedValue({ status: 503 });
  await expect(adapter.send(chat, { blocks: [{ kind: "text", text }] }, { maxAttempts: 1 })).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(2);
});
