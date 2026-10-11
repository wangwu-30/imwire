import { describe, expect, it } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { toPiMessages } from "../src/messages.js";

describe("pi message shape", () => {
  it("string assistant content fails; mapped log works with a real Agent", async () => {
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o-mini" }], tokensPerSecond: 80 });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = models.getModel("openai", "gpt-4o-mini");
    if (!model) throw new Error("faux model missing");

    faux.setResponses([fauxAssistantMessage("Hello there friend")]);
    const broken = new Agent({
      initialState: {
        systemPrompt: "S",
        model,
        messages: [
          { role: "system", content: "S" },
          { role: "assistant", content: "earlier" },
          { role: "user", content: "hi" },
        ] as never,
      },
      streamFn: models.streamSimple.bind(models),
    });
    await broken.prompt("hi");
    expect(broken.state.errorMessage ?? "").toMatch(/content\.map|not a function|error/i);

    faux.setResponses([fauxAssistantMessage("Hello there friend")]);
    const mapped = toPiMessages(
      [
        { id: "a", seq: 1, role: "assistant", text: "earlier", createdAt: 1 },
        { id: "b", seq: 2, role: "user", text: "hi", createdAt: 2 },
      ],
      { systemPrompt: "S", provider: "openai", model: "gpt-4o-mini" },
    );
    const ok = new Agent({
      initialState: { systemPrompt: "S", model, messages: mapped },
      streamFn: models.streamSimple.bind(models),
    });
    await ok.continue();
    expect(ok.state.errorMessage).toBeFalsy();
    const last = ok.state.messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(Array.isArray((last as { content?: unknown }).content)).toBe(true);
  });
});
