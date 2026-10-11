import { describe, expect, it } from "vitest";
import { createSdkRealtime, isWsConnectionAlive, readWsConnectionState } from "../src/realtime.js";

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

describe("Feishu SDK logger stays off stdout", () => {
  it("start() writes no stdout bytes (EventDispatcher + WSClient use stderr + numeric LoggerLevel)", async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (err?: Error) => void) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      if (typeof encoding === "function") (encoding as (err?: Error) => void)();
      else cb?.();
      return true;
    }) as typeof process.stdout.write;
    try {
      const Lark = await import("@larksuiteoapi/node-sdk");
      const level = Lark.LoggerLevel.warn;
      expect(typeof level).toBe("number");
      const rt = await createSdkRealtime({ appId: "cli_test", appSecret: "secret", loggerLevel: level });
      const ac = new AbortController();
      const started = rt.start({ onEvent: async () => undefined }, ac.signal);
      await new Promise((r) => setImmediate(r));
      ac.abort();
      await started;
    } finally {
      process.stdout.write = orig;
    }
    expect(chunks.join("")).not.toMatch(/event-dispatch|\[info\]/);
    expect(chunks.join("")).toBe("");
  });

  it("uses numeric Lark.LoggerLevel, not a string", async () => {
    const Lark = await import("@larksuiteoapi/node-sdk");
    const level = Lark.LoggerLevel?.warn ?? Lark.LoggerLevel?.error;
    expect(typeof level).toBe("number");
    expect(Lark.LoggerLevel.error).toBe(1);
  });
});
