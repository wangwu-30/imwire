import { describe, expect, it } from "vitest";
import { decodeCallbackData, encodeCallbackData } from "../src/buttons.js";

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
});
