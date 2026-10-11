import { expect, test } from "vitest";
import { DingTalkAdapter } from "../src/adapter.js";
import type { DingTalkHttp } from "../src/http.js";

// PUT /v1.0/card/streaming — https://open.dingtalk.com/document/orgapp/api-streamingupdate
test("draft uses official AI card streaming body (outTrackId, guid, key, content, isFull, isFinalize)", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const http: DingTalkHttp = {
    async request({ method, path, body }) {
      calls.push({ method, path, body });
      return { outTrackId: "card-1" };
    },
  };
  const adapter = new DingTalkAdapter({
    clientId: "ding_app",
    clientSecret: "secret",
    cardTemplateId: "tpl",
    http,
    stream: { isAlive: () => false, stop() {}, async start() {} },
    draftThrottleMs: 0,
  });
  const chat = { platform: "dingtalk" as const, accountId: "ding_app", chatId: "cid_dm_1", kind: "dm" as const };
  const draft = await adapter.draft(chat);
  draft.append("Hello ");
  draft.append("world");
  await draft.finalize({ blocks: [{ kind: "markdown", text: "Hello world" }] });
  const stream = calls.filter((c) => c.path === "/v1.0/card/streaming");
  expect(stream.length).toBeGreaterThan(0);
  const last = stream[stream.length - 1]?.body as Record<string, unknown>;
  expect(last.outTrackId).toBeTruthy();
  expect(last.guid).toBeTruthy();
  expect(last.key).toBe("content");
  expect(last.isFull).toBe(true);
  expect(last.isFinalize).toBe(true);
  expect(calls.some((c) => c.path === "/v1.0/card/instances/createAndDeliver")).toBe(true);
});
