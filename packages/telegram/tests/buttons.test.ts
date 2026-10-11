import { describe, expect, it } from "vitest";
import {
  createCallbackTable,
  decodeCallbackData,
  encodeCallbackData,
} from "../src/buttons.js";

describe("telegram callback_data", () => {
  it("keeps short id:value payloads under 64 bytes", () => {
    const table = new Map<string, { id: string; value?: string }>();
    const data = encodeCallbackData({ id: "approve", label: "OK", value: "call_42" }, table);
    expect(data).toBe("approve:call_42");
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    expect(decodeCallbackData(data, table)).toEqual({ actionId: "approve", value: "call_42" });
  });

  it("hashes CJK ids that exceed the 64-byte limit", () => {
    const table = new Map<string, { id: string; value?: string }>();
    const id = "审批通过请确认这是一个很长的按钮标识需要超过六十四字节";
    const value = "call_42";
    const data = encodeCallbackData({ id, label: "OK", value }, table);
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    expect(data.startsWith("h:")).toBe(true);
    expect(decodeCallbackData(data, table)).toEqual({ actionId: id, value });
  });

  it("evicts the oldest hashed entry from the LRU and leaves restarts unresolved", () => {
    const table = createCallbackTable(2);
    const long = (n: string) =>
      encodeCallbackData(
        { id: `审批通过请确认这是一个很长的按钮标识需要超过六十四字节${n}`, label: "OK" },
        table,
      );
    const a = long("a");
    const b = long("b");
    const c = long("c");
    expect(a.startsWith("h:")).toBe(true);
    expect(table.size).toBe(2);
    expect(decodeCallbackData(a, table)).toEqual({ actionId: a });
    expect(decodeCallbackData(b, table).actionId).not.toBe(b);
    expect(decodeCallbackData(c, table).actionId).not.toBe(c);
    expect(decodeCallbackData("h:deadbeefdeadbeef", createCallbackTable())).toEqual({
      actionId: "h:deadbeefdeadbeef",
    });
  });

  it("resolves hashed callbacks after a restart when persist (SQLite) is wired", () => {
    const durable = new Map<string, { id: string; value?: string }>();
    const persist = {
      get: (k: string) => durable.get(k),
      set: (k: string, v: { id: string; value?: string }) => {
        durable.set(k, v);
      },
    };
    const first = createCallbackTable(2, persist);
    const id = "审批通过请确认这是一个很长的按钮标识需要超过六十四字节";
    const data = encodeCallbackData({ id, label: "OK", value: "call_99" }, first);
    expect(data.startsWith("h:")).toBe(true);
    const restarted = createCallbackTable(2, persist);
    expect(decodeCallbackData(data, restarted)).toEqual({ actionId: id, value: "call_99" });
  });
});
