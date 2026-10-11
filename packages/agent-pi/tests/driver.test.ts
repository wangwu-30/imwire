import { describe, expect, it } from "vitest";
import { createFakePiProvider, PiAgentDriver } from "../src/index.js";
import type { ConversationSnapshot, TurnSink } from "@imwire/session";

const conv: ConversationSnapshot = {
  id: "c1",
  title: "default",
  isDefault: true,
  messages: [],
};

function collectSink() {
  let text = "";
  const approvals: string[] = [];
  const sink: TurnSink = {
    text: (d) => {
      text += d;
    },
    status: () => undefined,
    requestApproval: async (req) => {
      approvals.push(req.toolCallId);
      return "approve";
    },
  };
  return {
    sink,
    result: () => ({ text, approvals }),
  };
}

describe("PiAgentDriver + fake provider", () => {
  it("maps session history and streams tokens without network", async () => {
    const driver = new PiAgentDriver({
      source: createFakePiProvider([
        { type: "text", delta: "Hello" },
        { type: "text", delta: " world" },
        { type: "approval", req: { toolCallId: "t1", title: "Run?", options: ["approve", "deny"] } },
        { type: "text", delta: "!" },
      ]),
    });
    const { agentSessionId } = await driver.ensureSession(conv);
    const { sink, result } = collectSink();
    await driver.prompt(agentSessionId, { text: "hi", source: { chat: { platform: "telegram", accountId: "bot", chatId: "1", kind: "dm" }, from: { platform: "telegram", accountId: "bot", userId: "u" } } }, sink);
    expect(result().text).toBe("Hello world!");
    expect(result().approvals).toEqual(["t1"]);
  });
});
