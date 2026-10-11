import { describe, expect, it } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ConversationSnapshot, TurnSink } from "@imwire/session";
import { CROSS_IM_NOTE, PiAgentDriver, platformTag, stripPlatformTag, toPiMessages } from "../src/index.js";

const surface = (platform: string) => ({ platform, accountId: "a", chatId: "c", kind: "dm" as const });
const turn = (platform: string, text: string) => ({
  text,
  source: { chat: surface(platform), from: { platform, accountId: "a", userId: "u" } },
});
const sink: TurnSink = { text: () => undefined, status: () => undefined, requestApproval: async () => "deny" };

describe("platform tags", () => {
  it("tags each user message with the IM it came from and leaves untagged ones alone", () => {
    const out = toPiMessages(
      [
        { id: "1", seq: 1, role: "user", text: "remember: blue whale 42", surface: surface("telegram"), createdAt: 1 },
        { id: "2", seq: 2, role: "assistant", text: "ok", surface: surface("telegram"), createdAt: 2 },
        { id: "3", seq: 3, role: "user", text: "what did I say?", surface: surface("feishu"), createdAt: 3 },
        { id: "4", seq: 4, role: "user", text: "no surface", createdAt: 4 },
      ],
      { systemPrompt: "S", provider: "openai", model: "m" },
    );
    expect(out.map((m) => (m.role === "user" ? m.content : m.role))).toEqual([
      "system",
      "[via Telegram] remember: blue whale 42",
      "assistant",
      "[via Feishu] what did I say?",
      "no surface",
    ]);
  });

  it("round-trips and keeps unknown platform ids readable", () => {
    expect(platformTag("matrix")).toBe("[via matrix] ");
    expect(platformTag(undefined)).toBe("");
    expect(stripPlatformTag("[via Feishu] hi [via x] y")).toBe("hi [via x] y");
    expect(stripPlatformTag("[not a tag] hi")).toBe("[not a tag] hi");
  });
});

describe("PiAgentDriver cross-IM context", () => {
  it("system prompt says it is one conversation across IMs; history and the new turn carry their platform", async () => {
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o-mini" }], tokensPerSecond: 1000 });
    const models = createModels();
    models.setProvider(faux.provider);
    const ctxs: Array<{ systemPrompt?: string; messages: Array<{ role: string; content: unknown }> }> = [];
    faux.setResponses([
      (ctx: unknown) => {
        ctxs.push(JSON.parse(JSON.stringify(ctx)));
        return fauxAssistantMessage("You said: blue whale 42");
      },
    ]);
    const driver = new PiAgentDriver({ models, systemPrompt: "You are Ada's assistant." });
    const conv: ConversationSnapshot = {
      id: "c1",
      title: "default",
      isDefault: true,
      messages: [
        { id: "1", seq: 1, role: "user", text: "remember: blue whale 42", surface: surface("telegram"), createdAt: 1 },
        { id: "2", seq: 2, role: "assistant", text: "Got it.", surface: surface("telegram"), createdAt: 2 },
        { id: "3", seq: 3, role: "user", text: "What did I just say on Telegram?", surface: surface("feishu"), createdAt: 3 },
      ],
    };
    const { agentSessionId } = await driver.ensureSession(conv);
    await driver.prompt(agentSessionId, turn("feishu", "What did I just say on Telegram?"), sink);

    const ctx = ctxs[0]!;
    const system = [ctx.systemPrompt ?? "", ...ctx.messages.filter((m) => m.role === "system").map((m) => String(m.content))].join("\n");
    expect(system).toContain("You are Ada's assistant.");
    expect(system).toContain(CROSS_IM_NOTE);
    const users = ctx.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
    // the current turn is already in the session log: sent once, tagged, not duplicated
    expect(users).toEqual(["[via Telegram] remember: blue whale 42", "[via Feishu] What did I just say on Telegram?"]);
  });

  it("tags a turn that is not in the snapshot yet", async () => {
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o-mini" }], tokensPerSecond: 1000 });
    const models = createModels();
    models.setProvider(faux.provider);
    const seen: string[] = [];
    faux.setResponses([
      (ctx: unknown) => {
        const c = ctx as { messages: Array<{ role: string; content: unknown }> };
        for (const m of c.messages) if (m.role === "user") seen.push(String(m.content));
        return fauxAssistantMessage("hi");
      },
    ]);
    const driver = new PiAgentDriver({ models });
    const { agentSessionId } = await driver.ensureSession({ id: "c2", title: "d", isDefault: true, messages: [] });
    await driver.prompt(agentSessionId, turn("telegram", "hello"), sink);
    expect(seen).toEqual(["[via Telegram] hello"]);
  });
});
