// Real-path tests against @earendil-works/pi-agent-core + pi-ai 1.1.0 (faux provider, no network).
import { describe, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

const faux = fauxProvider({
  provider: "openai",
  models: [{ id: "gpt-4o-mini" }],
  tokensPerSecond: 40,
  tokenSize: { min: 2, max: 2 },
});
const contexts: unknown[] = [];
const models = createModels();
models.setProvider(faux.provider);
vi.mock("@earendil-works/pi-ai/providers/all", () => ({ builtinModels: () => models }));

import { PiAgentDriver } from "../src/index.js";
import type { TurnSink } from "@imwire/session";

const src = {
  chat: { platform: "telegram" as const, accountId: "bot", chatId: "1", kind: "dm" as const },
  from: { platform: "telegram" as const, accountId: "bot", userId: "u" },
};

describe("PI real-path (faux provider via real Models/Agent)", () => {
  it("P1: live token streaming, user message once, turn 2 works with pi assistant shape", async () => {
    faux.setResponses([
      (ctx) => {
        contexts.push(JSON.parse(JSON.stringify(ctx)));
        return fauxAssistantMessage("Hello there, this is a slowly streamed answer.");
      },
      (ctx) => {
        contexts.push(JSON.parse(JSON.stringify(ctx)));
        return fauxAssistantMessage("Second answer.");
      },
    ]);
    const driver = new PiAgentDriver({ usePi: true, models });
    const conv = {
      id: "c1",
      title: "default",
      isDefault: true,
      messages: [{ id: "m3", seq: 1, role: "user" as const, text: "hi", createdAt: 3 }],
    };
    const { agentSessionId } = await driver.ensureSession(conv);
    const t0 = Date.now();
    const stamps: number[] = [];
    const sink: TurnSink = {
      text: () => {
        stamps.push(Date.now() - t0);
      },
      status: () => {},
      requestApproval: async () => "approved",
    };
    const r = await driver.prompt(agentSessionId, { text: "hi", source: src }, sink);
    const total = Date.now() - t0;
    expect(r.text.length).toBeGreaterThan(0);
    expect(stamps.length).toBeGreaterThan(1);
    expect(stamps[0]!).toBeLessThan(Math.max(20, total * 0.8));
    const ctx = contexts[0] as { messages: Array<{ role: string; content: unknown }> };
    const userHi = ctx.messages.filter(
      (m) => m.role === "user" && (m.content === "hi" || JSON.stringify(m.content).includes("hi")),
    );
    expect(userHi.length).toBe(1);
    const r2 = await driver.prompt(agentSessionId, { text: "again", source: src }, sink);
    expect(r2.text).toMatch(/Second|answer/i);
    expect(r2.text.length).toBeGreaterThan(0);
  }, 30_000);

  it("P2: unknown model is surfaced to the user (not an empty reply)", async () => {
    const driver = new PiAgentDriver({ usePi: true, models, modelProvider: "openai", modelId: "does-not-exist" });
    const { agentSessionId } = await driver.ensureSession({ id: "c2", title: "d", isDefault: true, messages: [] });
    let err: unknown;
    let r: { text: string } | undefined;
    try {
      r = await driver.prompt(
        agentSessionId,
        { text: "hi", source: src },
        { text: () => {}, status: () => {}, requestApproval: async () => "approved" },
      );
    } catch (e) {
      err = e;
    }
    const surfaced = r?.text ?? String(err ?? "");
    expect(surfaced.length).toBeGreaterThan(0);
    expect(surfaced).toMatch(/model|does-not-exist|unknown/i);
  });
});
