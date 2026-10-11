import { describe, expect, it } from "vitest";
import { isWsConnectionAlive, readWsConnectionState } from "../src/realtime.js";

describe("Feishu WS connection status", () => {
  it("reads state from the SDK object, not String(status)", () => {
    expect(readWsConnectionState({ state: "failed", reconnectAttempts: 3 })).toBe("failed");
    expect(readWsConnectionState({ state: "connected" })).toBe("connected");
    expect(readWsConnectionState("[object Object]")).toBe("[object object]");
    expect(isWsConnectionAlive({ state: "failed" }, false)).toBe(false);
    expect(isWsConnectionAlive({ state: "connected" }, false)).toBe(true);
    expect(isWsConnectionAlive({ state: "connecting" }, false)).toBe(true);
    expect(isWsConnectionAlive({ state: "connected" }, true)).toBe(false);
  });
});
