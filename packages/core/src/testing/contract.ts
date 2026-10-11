import { expect, test } from "vitest";
import type { Adapter, Capabilities, ChatRef, Inbound, MsgRef } from "../types.js";
import type { OutboundCall } from "./fake-transport.js";

export interface AdapterContractHarness {
  adapter: Adapter;
  /** Feed a platform-native payload (or already-normalized event for FakeAdapter). */
  emit: (raw: unknown) => Promise<void>;
  calls: () => OutboundCall[];
  fixtures: {
    message: unknown;
    action?: unknown;
    edit?: unknown;
  };
  expectedMessage: {
    text: string;
    chatId: string;
    userId: string;
  };
  chat: ChatRef;
}

export type AdapterContractFactory = () => Promise<AdapterContractHarness> | AdapterContractHarness;

export const contractCapabilitiesShape: Array<keyof Capabilities> = [
  "streaming",
  "streamingCard",
  "edit",
  "delete",
  "buttons",
  "reactions",
  "threads",
  "typing",
  "media",
  "maxTextLength",
  "markdown",
];

/**
 * Contract every adapter must pass against a fake / recorded transport.
 * Call from the adapter package's tests:
 *
 *   defineAdapterContract("telegram", () => makeTelegramHarness());
 */
export function defineAdapterContract(name: string, factory: AdapterContractFactory): void {
  test(`${name}: declares a complete capability table`, async () => {
    const { adapter } = await factory();
    for (const key of contractCapabilitiesShape) {
      expect(adapter.capabilities[key], key).toBeDefined();
    }
    expect(adapter.capabilities.maxTextLength).toBeGreaterThan(0);
    expect(adapter.platform).toBeTruthy();
    expect(adapter.accountId).toBeTruthy();
  });

  test(`${name}: maps a recorded message onto the normalized event model`, async () => {
    const h = await factory();
    const seen: Inbound[] = [];
    h.adapter.on(async (e) => {
      seen.push(e);
    });
    await h.emit(h.fixtures.message);
    const msg = seen.find((e) => e.type === "message" || e.type === "command");
    expect(msg, "expected a message or command event").toBeTruthy();
    if (!msg || (msg.type !== "message" && msg.type !== "command")) return;
    expect(msg.chat.chatId).toBe(h.expectedMessage.chatId);
    expect(msg.from.userId).toBe(h.expectedMessage.userId);
    expect(msg.chat.platform).toBe(h.adapter.platform);
    if (msg.type === "message") {
      expect(msg.text).toContain(h.expectedMessage.text);
    }
  });

  test(`${name}: inbound dedup drops a replayed event id`, async () => {
    const h = await factory();
    let count = 0;
    h.adapter.on(async () => {
      count += 1;
    });
    await h.emit(h.fixtures.message);
    await h.emit(h.fixtures.message);
    expect(count).toBe(1);
  });

  test(`${name}: send() records an outbound call on the fake transport`, async () => {
    const h = await factory();
    const refs = await h.adapter.send(h.chat, {
      blocks: [{ kind: "markdown", text: "hello from contract" }],
    });
    expect(refs.length).toBeGreaterThan(0);
    expect(h.calls().some((c) => c.op === "send")).toBe(true);
  });

  test(`${name}: draft streaming degrades according to capabilities`, async () => {
    const h = await factory();
    const draft = await h.adapter.draft(h.chat);
    draft.append("Hello ");
    draft.append("world");
    const refs = await draft.finalize({
      blocks: [
        { kind: "markdown", text: "Hello world" },
        {
          kind: "buttons",
          buttons: [
            { id: "approve", label: "Approve", style: "primary" },
            { id: "deny", label: "Deny", style: "danger" },
          ],
        },
      ],
    });
    expect(refs.length).toBeGreaterThan(0);
    const ops = h.calls().map((c) => c.op);
    if (h.adapter.capabilities.streaming === "card" && h.adapter.capabilities.streamingCard) {
      expect(ops.some((op) => op === "streamStart" || op === "streamUpdate" || op === "streamFinish" || op === "send")).toBe(
        true,
      );
    } else if (h.adapter.capabilities.streaming === "edit" && h.adapter.capabilities.edit) {
      expect(ops.includes("send") || ops.includes("edit")).toBe(true);
    } else {
      expect(ops.includes("send")).toBe(true);
    }
  });

  test(`${name}: typing is a no-op when unsupported, a call when supported`, async () => {
    const h = await factory();
    const before = h.calls().length;
    await h.adapter.typing(h.chat);
    const after = h.calls().length;
    if (h.adapter.capabilities.typing) expect(after).toBeGreaterThan(before);
    else expect(after).toBe(before);
  });

  test(`${name}: start() respects AbortSignal`, async () => {
    const h = await factory();
    const ac = new AbortController();
    const started = h.adapter.start(ac.signal);
    ac.abort();
    await started;
  });

  test(`${name}: action fixture maps to a button/approval callback`, async () => {
    const h = await factory();
    if (!h.fixtures.action) return;
    const seen: Inbound[] = [];
    h.adapter.on(async (e) => {
      seen.push(e);
    });
    await h.emit(h.fixtures.action);
    const action = seen.find((e) => e.type === "action");
    expect(action, "expected an action event").toBeTruthy();
    if (action?.type === "action") {
      expect(action.actionId.length).toBeGreaterThan(0);
      expect(action.target.messageId.length).toBeGreaterThan(0);
    }
  });
}

export function asMsgRef(chat: ChatRef, messageId: string): MsgRef {
  return { chat, messageId };
}
