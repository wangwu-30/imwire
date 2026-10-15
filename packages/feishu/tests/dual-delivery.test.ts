import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Inbound } from "@imwire/core";
import { FeishuAdapter } from "../src/adapter.js";
import { FeishuDualDelivery } from "../src/dual-delivery.js";
import { mapFeishuEvent } from "../src/map.js";

function input(id: string, thread = "topic", changes: Record<string, unknown> = {}) {
  return {
    header: { event_type: "im.message.receive_v1", event_id: `event-${id}` },
    event: {
      sender: { sender_id: { open_id: "person" } },
      message: {
        message_id: id, chat_id: "chat", chat_type: "group", thread_id: thread,
        create_time: "1000", message_type: "text", content: '{"text":"work"}', ...changes,
      },
    },
  };
}

function setup(accountId = "account") {
  const adapter = new FeishuAdapter({ appId: "fixture", appSecret: "fixture", accountId });
  const received: Inbound[] = [];
  adapter.on(async (event) => { received.push(event); });
  return { adapter, received };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Feishu dual delivery through ingest", () => {
  it("same-id: first passes and runtime suppresses replay with a new event id", async () => {
    const { adapter, received } = setup();
    await adapter.ingest(input("one"));
    const replay = input("one");
    replay.header.event_id = "retry";
    await adapter.ingest(replay);
    expect(received.map((e) => e.id)).toEqual(["one"]);
  });

  it("dual-delivery: topic first suppresses distinct-id main copies", async () => {
    const { adapter, received } = setup();
    await adapter.ingest(input("topic"));
    await adapter.ingest(input("main", ""));
    await adapter.ingest(input("extra", ""));
    expect(received.map((e) => e.id)).toEqual(["topic"]);
  });

  it("prefers the topic when main arrives first within the pairing window", async () => {
    const { adapter, received } = setup();
    const flat = adapter.ingest(input("main", ""));
    await vi.advanceTimersByTimeAsync(999);
    expect(received).toEqual([]);
    await adapter.ingest(input("topic"));
    await flat;
    expect(received.map((e) => e.id)).toEqual(["topic"]);
    expect(received[0]?.type === "message" && received[0].chat.threadId).toBe("topic");
  });

  it("first unpaired main passes after one second; late topic cannot dispatch again", async () => {
    const { adapter, received } = setup();
    const first = adapter.ingest(input("main", ""));
    await vi.advanceTimersByTimeAsync(1000);
    await first;
    await adapter.ingest(input("topic"));
    expect(received.map((e) => e.id)).toEqual(["main"]);
  });

  it.each([
    { create_time: "1001" }, { content: '{"text":"new work"}' },
    { chat_id: "another-chat" }, { message_type: "post" },
  ])("new-send: identity changes pass independently (%j)", async (changes) => {
    const { adapter, received } = setup();
    await adapter.ingest(input("first"));
    await adapter.ingest(input("second", "topic", changes));
    expect(received.map((e) => e.id)).toEqual(["first", "second"]);
  });

  it("different senders are independent", async () => {
    const { adapter, received } = setup();
    await adapter.ingest(input("first"));
    const second = input("second");
    second.event.sender.sender_id.open_id = "another-person";
    await adapter.ingest(second);
    expect(received).toHaveLength(2);
  });

  it("concurrent main retries and topic copies emit only once", async () => {
    const { adapter, received } = setup();
    await Promise.all([
      adapter.ingest(input("main", "")), adapter.ingest(input("main", "")),
      adapter.ingest(input("topic")), adapter.ingest(input("topic")),
    ]);
    expect(received.map((e) => e.id)).toEqual(["topic"]);
  });

  it("late-copy window expires without changing runtime's same-id TTL", async () => {
    const { adapter, received } = setup();
    await adapter.ingest(input("first"));
    await vi.advanceTimersByTimeAsync(24999);
    await adapter.ingest(input("late", ""));
    expect(received).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await adapter.ingest(input("first"));
    expect(received).toHaveLength(1);
    // The replay creates a new logical window; allow that to expire too.
    await vi.advanceTimersByTimeAsync(25000);
    await adapter.ingest(input("fresh-id"));
    expect(received).toHaveLength(2);
  });

  it("commands also retain the topic route", async () => {
    const { adapter, received } = setup();
    const changes = { content: '{"text":"/help"}' };
    await adapter.ingest(input("topic", "topic", changes));
    await adapter.ingest(input("main", "", changes));
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("command");
  });

  it.each([undefined, ""])("missing create time (%s) falls back to id dedup", async (create_time) => {
    const { adapter, received } = setup();
    await adapter.ingest(input("first", "", { create_time }));
    await adapter.ingest(input("second", "", { create_time }));
    expect(received).toHaveLength(2);
  });

  it("DMs do not wait and adapter instances do not share state", async () => {
    const a = setup();
    const b = setup();
    await a.adapter.ingest(input("dm", "", { chat_type: "p2p" }));
    await a.adapter.ingest(input("topic"));
    await b.adapter.ingest(input("topic"));
    expect(a.received).toHaveLength(2);
    expect(b.received).toHaveLength(1);
  });
});

it("coordinator leaves same-id dedup to runtime and isolates account keys", async () => {
  const gate = new FeishuDualDelivery("fixture");
  const event = mapFeishuEvent(input("first"), { accountId: "a" })[0]!;
  expect(await gate.accept(event)).toBe(true);
  expect(await gate.accept(event)).toBe(true);
  const other = mapFeishuEvent(input("second"), { accountId: "b" })[0]!;
  expect(await gate.accept(other)).toBe(true);
  gate.resetDualDeliveryForTest();
});

it("reset cancels timers, settles pending inputs and clears retained keys", async () => {
  const gate = new FeishuDualDelivery("fixture");
  const event = mapFeishuEvent(input("main", ""), { accountId: "a" })[0]!;
  const pending = gate.accept(event);
  gate.resetDualDeliveryForTest();
  expect(await pending).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  const topic = mapFeishuEvent(input("topic"), { accountId: "a" })[0]!;
  expect(await gate.accept(topic)).toBe(true);
});
