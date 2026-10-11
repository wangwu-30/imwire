import { describe, expect, it } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ConversationSnapshot, TurnSink } from "@imwire/session";
import { PiAgentDriver } from "../src/index.js";
import { resolveModel } from "../src/driver.js";

const conv: ConversationSnapshot = { id: "c1", title: "default", isDefault: true, messages: [] };
const turn = (text: string) => ({
  text,
  source: {
    chat: { platform: "telegram" as const, accountId: "bot", chatId: "1", kind: "dm" as const },
    from: { platform: "telegram" as const, accountId: "bot", userId: "u" },
  },
});
const sink = (): TurnSink & { out: string } => {
  const s = {
    out: "",
    text: (d: string) => {
      s.out += d;
    },
    status: () => undefined,
    requestApproval: async () => "deny" as const,
  };
  return s;
};

const catalog = {
  getModel: (provider: string, id: string) =>
    provider === "minimax-cn" && id === "MiniMax-M2.7"
      ? { id: "MiniMax-M2.7", name: "MiniMax M2.7", provider, api: "anthropic-messages", thinkingLevelMap: { off: "disabled", high: "high" } }
      : undefined,
  getModels: (provider: string) =>
    provider === "minimax-cn" ? [{ id: "MiniMax-M2.7", name: "MiniMax M2.7", provider, api: "anthropic-messages", thinkingLevelMap: { off: "disabled", high: "high" } }] : [],
};

describe("resolveModel (unlisted model ids)", () => {
  it("returns listed models unchanged regardless of the switch", () => {
    expect(resolveModel(catalog as never, "minimax-cn", "MiniMax-M2.7")?.id).toBe("MiniMax-M2.7");
    expect(resolveModel(catalog as never, "minimax-cn", "MiniMax-M2.7", { allowUnlisted: true })?.thinkingLevelMap).toEqual({
      off: "disabled",
      high: "high",
    });
  });

  it("switch off: an unlisted id stays unknown", () => {
    expect(resolveModel(catalog as never, "minimax-cn", "MiniMax-M3.1-Flash-Preview")).toBeUndefined();
  });

  it("switch on: borrows a sibling's settings under the requested id and leaves thinking at the provider default", () => {
    const warnings: string[] = [];
    const model = resolveModel(catalog as never, "minimax-cn", "MiniMax-M3.1-Flash-Preview", {
      allowUnlisted: true,
      warn: (m) => warnings.push(m),
    });
    expect(model).toMatchObject({ id: "MiniMax-M3.1-Flash-Preview", name: "MiniMax-M3.1-Flash-Preview", provider: "minimax-cn", api: "anthropic-messages" });
    expect(model?.thinkingLevelMap).toEqual({ off: null, high: "high" });
    expect(warnings[0]).toMatch(/not in the built-in catalog; using MiniMax-M2\.7/);
  });

  it("switch on: an unknown provider is still unknown", () => {
    expect(resolveModel(catalog as never, "nope", "x", { allowUnlisted: true, warn: () => undefined })).toBeUndefined();
  });
});

describe("PiAgentDriver with an unlisted model", () => {
  function models() {
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o-mini" }], tokensPerSecond: 1000 });
    const m = createModels();
    m.setProvider(faux.provider);
    return { faux, m };
  }

  it("reports Unknown model when the switch is off", async () => {
    const { m } = models();
    const driver = new PiAgentDriver({ models: m, modelProvider: "openai", modelId: "gpt-9-preview", allowUnlistedModel: false });
    const { agentSessionId } = await driver.ensureSession(conv);
    const s = sink();
    const res = await driver.prompt(agentSessionId, turn("hi"), s);
    expect(res.text).toMatch(/Unknown model openai\/gpt-9-preview/);
  });

  it("answers through the provider when the switch is on", async () => {
    const { faux, m } = models();
    faux.setResponses([fauxAssistantMessage("hello from preview")]);
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const driver = new PiAgentDriver({ models: m, modelProvider: "openai", modelId: "gpt-9-preview", allowUnlistedModel: true });
      const { agentSessionId } = await driver.ensureSession(conv);
      const s = sink();
      const res = await driver.prompt(agentSessionId, turn("hi"), s);
      expect(res.text).toBe("hello from preview");
    } finally {
      console.warn = warn;
    }
  });
});
