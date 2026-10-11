import { FakeAdapter } from "@imwire/core/testing";
import type { Capabilities, Inbound } from "@imwire/core";
import { expect, test } from "vitest";
import { PROTOCOL_VERSION } from "../src/protocol.js";
import { createServeHost } from "../src/server.js";

const caps: Capabilities = {
  streaming: "edit",
  streamingCard: false,
  edit: true,
  editScope: "any",
  proactiveSend: true,
  delete: true,
  buttons: true,
  reactions: false,
  threads: false,
  typing: true,
  media: { image: false, file: false },
  maxTextLength: 1000,
  markdown: "none",
};

function harness() {
  const adapter = new FakeAdapter({ platform: "telegram", accountId: "999", capabilities: caps });
  const out: unknown[] = [];
  const host = createServeHost({
    adapters: [adapter],
    write: (msg) => {
      out.push(msg);
    },
  });
  const chat = { platform: "telegram" as const, accountId: "999", chatId: "111", kind: "dm" as const };
  return { adapter, out, host, chat };
}

test("hello reports protocol 1.0 and capabilities", async () => {
  const { host, out } = harness();
  await host.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello" }));
  const reply = out[0] as { result?: { protocolVersion?: string; platforms?: { platform: string }[] } };
  expect(reply.result?.protocolVersion).toBe(PROTOCOL_VERSION);
  expect(reply.result?.platforms?.[0]?.platform).toBe("telegram");
});

test("inbound event is emitted as a notification", async () => {
  const { adapter, out, host } = harness();
  const event: Inbound = {
    type: "message",
    id: "m1",
    ts: 1,
    chat: { platform: "telegram", accountId: "999", chatId: "111", kind: "dm" },
    from: { platform: "telegram", accountId: "999", userId: "111" },
    messageId: "42",
    text: "hello",
    mentionsBot: true,
  };
  await adapter.ingest(event);
  expect(out.some((m) => (m as { method?: string }).method === "event")).toBe(true);
  void host;
});

test("send / edit / draft / approval round-trip", async () => {
  const { host, out, chat } = harness();
  await host.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "send",
      params: { chat, msg: { blocks: [{ kind: "markdown", text: "hi" }] } },
    }),
  );
  const send = out.find((m) => (m as { id?: number }).id === 2) as { result?: { refs?: { messageId: string }[] } };
  expect(send.result?.refs?.length).toBeGreaterThan(0);

  await host.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "edit",
      params: {
        ref: { chat, messageId: send.result?.refs?.[0]?.messageId },
        msg: { blocks: [{ kind: "markdown", text: "edited" }] },
      },
    }),
  );
  expect(out.some((m) => (m as { id?: number }).id === 3)).toBe(true);

  await host.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 4, method: "draft", params: { op: "start", chat } }),
  );
  const started = out.find((m) => (m as { id?: number }).id === 4) as { result?: { draftId?: string } };
  const draftId = started.result?.draftId;
  expect(draftId).toBeTruthy();
  await host.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 5, method: "draft", params: { op: "append", draftId, delta: "Hel" } }),
  );
  await host.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "draft",
      params: { op: "finalize", draftId, msg: { blocks: [{ kind: "markdown", text: "Hello" }] } },
    }),
  );
  const fin = out.find((m) => (m as { id?: number }).id === 6) as { result?: { refs?: unknown[] } };
  expect(fin.result?.refs?.length).toBeGreaterThan(0);

  await host.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "approval",
      params: { chat, text: "ship it?", requestId: "r1" },
    }),
  );
  expect(out.some((m) => (m as { id?: number }).id === 7)).toBe(true);
});
