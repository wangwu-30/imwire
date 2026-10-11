import { defineAdapterContract } from "../src/testing/contract.js";
import { FakeAdapter } from "../src/testing/fake-transport.js";
import type { ChatRef, Inbound } from "../src/types.js";

const chat: ChatRef = {
  platform: "fake",
  accountId: "acct",
  chatId: "c1",
  kind: "dm",
};

const message: Inbound = {
  type: "message",
  id: "evt-1",
  ts: 1,
  chat,
  from: { platform: "fake", accountId: "acct", userId: "u1", displayName: "Ada" },
  messageId: "m-hello",
  text: "hello",
  mentionsBot: true,
};

const action: Inbound = {
  type: "action",
  id: "evt-2",
  ts: 2,
  target: { chat, messageId: "m1" },
  from: { platform: "fake", accountId: "acct", userId: "u1" },
  actionId: "approve",
};

function harness(streamingCard: boolean) {
  const adapter = new FakeAdapter({
    capabilities: {
      streaming: streamingCard ? "card" : "edit",
      streamingCard,
      edit: true,
      editScope: "any",
      proactiveSend: true,
      delete: true,
      buttons: true,
      reactions: true,
      threads: true,
      typing: true,
      media: { image: true, file: true },
      maxTextLength: 100,
      markdown: "subset",
    },
  });
  return {
    adapter,
    emit: async (raw: unknown) => {
      await adapter.ingest(raw as Inbound);
    },
    calls: () => adapter.calls,
    fixtures: { message, action },
    expectedMessage: { text: "hello", chatId: "c1", userId: "u1" },
    chat,
  };
}

defineAdapterContract("fake/edit", () => harness(false));
defineAdapterContract("fake/card", () => harness(true));
