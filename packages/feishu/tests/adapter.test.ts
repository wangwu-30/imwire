import { describe, expect, it } from "vitest";
import { FeishuAdapter } from "../src/adapter.js";
import type { FeishuHttp } from "../src/http.js";
import type { ChatRef } from "@imwire/core";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function mockHttp(opts?: { onRequest?: (c: Call) => void }): { http: FeishuHttp; calls: Call[]; seqByCard: Map<string, number[]> } {
  const calls: Call[] = [];
  const seqByCard = new Map<string, number[]>();
  let n = 0;
  const http: FeishuHttp = {
    async request({ method, path, body }) {
      const call: Call = { method, path, body };
      calls.push(call);
      opts?.onRequest?.(call);
      const cardMatch = /\/cardkit\/v1\/cards\/([^/]+)/.exec(path);
      const rec = body as { sequence?: number } | undefined;
      if (cardMatch && rec?.sequence !== undefined) {
        const id = cardMatch[1] ?? "";
        const prev = seqByCard.get(id) ?? [];
        const last = prev.at(-1) ?? 0;
        if (rec.sequence <= last) {
          const err = Object.assign(new Error("300317 sequence must increase"), { code: 300317 });
          throw err;
        }
        seqByCard.set(id, [...prev, rec.sequence]);
      }
      n += 1;
      if (path.includes("/cardkit/v1/cards") && method === "POST" && !path.includes("/elements")) {
        return { card_id: `card-${n}` };
      }
      if (path === "/open-apis/bot/v3/info") return { bot: { open_id: "ou_bot" } };
      return { message_id: `om-${n}` };
    },
    async requestBytes() {
      return new Uint8Array([1, 2, 3, 4]);
    },
  };
  return { http, calls, seqByCard };
}

const chatA: ChatRef = { platform: "feishu", accountId: "cli_test", chatId: "oc_a", kind: "dm" };
const chatB: ChatRef = { platform: "feishu", accountId: "cli_test", chatId: "oc_b", kind: "dm" };

describe("FeishuAdapter stream cards", () => {
  it("keeps an independent monotonically increasing sequence per card", async () => {
    const { http, seqByCard } = mockHttp();
    const adapter = new FeishuAdapter({
      appId: "cli_test",
      appSecret: "secret",
      http,
      realtime: { start: async () => undefined, isAlive: () => false, stop() {} },
      draftThrottleMs: 0,
    });
    const a = await adapter.draft(chatA);
    const b = await adapter.draft(chatB);
    a.append("A1");
    b.append("B1");
    a.append("A2");
    await a.finalize({
      blocks: [
        { kind: "markdown", text: "A done" },
        { kind: "buttons", buttons: [{ id: "approve", label: "OK", value: "x" }] },
      ],
    });
    await b.finalize({ blocks: [{ kind: "markdown", text: "B done" }] });
    expect(seqByCard.size).toBe(2);
    for (const seqs of seqByCard.values()) {
      expect(seqs.length).toBeGreaterThan(0);
      for (let i = 1; i < seqs.length; i += 1) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1] ?? 0);
      }
    }
  });

  it("writes final content, then buttons, then closes streaming_mode", async () => {
    const { http, calls } = mockHttp();
    const adapter = new FeishuAdapter({
      appId: "cli_test",
      appSecret: "secret",
      http,
      realtime: { start: async () => undefined, isAlive: () => false, stop() {} },
      draftThrottleMs: 0,
    });
    const draft = await adapter.draft(chatA);
    draft.append("hello");
    await draft.finalize({
      blocks: [
        { kind: "markdown", text: "hello" },
        { kind: "buttons", buttons: [{ id: "approve", label: "Approve", value: "call_42" }] },
      ],
    });
    const cardkit = calls.filter((c) => c.path.includes("/cardkit/"));
    const contentIdx = cardkit.findIndex((c) => c.path.includes("/content") && c.method === "PUT");
    const buttonsIdx = cardkit.findIndex((c) => c.path.endsWith("/elements") && c.method === "POST");
    const settingsIdx = cardkit.findIndex((c) => c.path.endsWith("/settings") && c.method === "PATCH");
    expect(contentIdx).toBeGreaterThanOrEqual(0);
    expect(buttonsIdx).toBeGreaterThan(contentIdx);
    expect(settingsIdx).toBeGreaterThan(buttonsIdx);
    const settings = cardkit[settingsIdx]?.body as { settings?: string };
    expect(settings.settings).toContain('"streaming_mode":false');
  });

  it("closes streaming_mode even when the final content PUT fails", async () => {
    const { http, calls } = mockHttp({
      onRequest: (c) => {
        const seq = (c.body as { sequence?: number } | undefined)?.sequence;
        if (c.path.includes("/content") && c.method === "PUT" && (seq ?? 0) >= 2) {
          throw Object.assign(new Error("content failed"), { code: 300317 });
        }
      },
    });
    const adapter = new FeishuAdapter({
      appId: "cli_test",
      appSecret: "secret",
      http,
      realtime: { start: async () => undefined, isAlive: () => false, stop() {} },
      draftThrottleMs: 0,
    });
    const draft = await adapter.draft(chatA);
    draft.append("hello");
    await draft.finalize({ blocks: [{ kind: "markdown", text: "hello" }] });
    expect(calls.some((c) => c.path.endsWith("/settings") && c.method === "PATCH")).toBe(true);
  });

  it("looks up chat_mode for card actions when the payload has no chat_type", async () => {
    const { http } = mockHttp();
    const orig = http.request.bind(http);
    http.request = async (opts) => {
      if (opts.path.includes("/im/v1/chats/") && opts.method === "GET") {
        return { chat_mode: "group" };
      }
      return orig(opts);
    };
    const adapter = new FeishuAdapter({
      appId: "cli_test",
      appSecret: "secret",
      http,
      realtime: { start: async () => undefined, isAlive: () => false, stop() {} },
    });
    const seen: string[] = [];
    adapter.on(async (e) => {
      if (e.type === "action") seen.push(e.target.chat.kind);
    });
    await adapter.ingest(
      {
        operator: { open_id: "ou_x" },
        action: { value: { actionId: "approve" } },
        context: { open_chat_id: "oc_group_looks_like_dm", open_message_id: "om_1" },
      },
      "card.action.trigger",
    );
    expect(seen).toEqual(["group"]);
  });

  it("download() returns the real bytes from requestBytes", async () => {
    const { http } = mockHttp();
    const adapter = new FeishuAdapter({
      appId: "cli_test",
      appSecret: "secret",
      http,
      realtime: { start: async () => undefined, isAlive: () => false, stop() {} },
    });
    const stream = await adapter.download({ id: "om_1/img_x", kind: "image" });
    const reader = stream.getReader();
    const { value } = await reader.read();
    expect(value).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("ingest returns before a slow handler finishes", async () => {
    const { http } = mockHttp();
    const adapter = new FeishuAdapter({
      appId: "cli_test",
      appSecret: "secret",
      http,
      realtime: { start: async () => undefined, isAlive: () => false, stop() {} },
    });
    let finished = false;
    adapter.on(async () => {
      await new Promise((r) => setTimeout(r, 80));
      finished = true;
    });
    const t0 = Date.now();
    await adapter.ingest(
      {
        sender: { sender_id: { open_id: "ou_x" }, sender_type: "user" },
        message: {
          message_id: "om_fast",
          chat_id: "oc_1",
          chat_type: "p2p",
          message_type: "text",
          content: '{"text":"ping"}',
        },
      },
      "im.message.receive_v1",
      { wait: false },
    );
    expect(Date.now() - t0).toBeLessThan(50);
    expect(finished).toBe(false);
    await adapter.flush();
    expect(finished).toBe(true);
  });
});
