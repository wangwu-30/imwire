import { expect, it, vi } from "vitest";
import { PiAgentDriver, type PiAgentDriverOptions } from "@imwire/agent-pi";
import { chatPreset } from "../src/chat.js";
import { assistantPreset } from "../src/hub/preset.js";

vi.mock("@imwire/agent-pi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@imwire/agent-pi")>();
  return { ...actual, PiAgentDriver: vi.fn(function (opts: PiAgentDriverOptions) {
    return new actual.PiAgentDriver(opts);
  }) };
});

it.each([
  [{ OPENAI_API_KEY: "test-only-placeholder" }, "openai"],
  [{ ANTHROPIC_API_KEY: "test-only-placeholder" }, "anthropic"],
  [{ OPENAI_API_KEY: "test-only-placeholder", ANTHROPIC_API_KEY: "test-only-placeholder" }, "openai"],
  [{ IMWIRE_USE_PI: "1" }, "openai"],
  [{ IMWIRE_USE_PI: "1", IMWIRE_PI_PROVIDER: "anthropic" }, "anthropic"],
] as const)("selects real pi without calling the provider: %j", (env, provider) => {
  const { driver } = chatPreset({ ...env, IMWIRE_PI_MODEL: "chosen-model", IMWIRE_SYSTEM_PROMPT: "chosen prompt" });
  expect(driver).toBeDefined();
  expect(PiAgentDriver).toHaveBeenLastCalledWith({
    usePi: true, modelProvider: provider, modelId: "chosen-model", systemPrompt: "chosen prompt",
  });
});

it("fake explicitly overrides a model key and passes the system prompt", () => {
  const { describe } = chatPreset({ OPENAI_API_KEY: "test-only-placeholder", IMWIRE_PI_PROVIDER: "fake", IMWIRE_SYSTEM_PROMPT: "demo" });
  expect(PiAgentDriver).toHaveBeenLastCalledWith({ systemPrompt: "demo", source: expect.any(Function) });
  expect(describe).toEqual(["pi chat agent (offline fake provider)"]);
});

it("preserves assistant's no-key demo fallback and chat-off override", () => {
  expect(assistantPreset({}).describe).toContain("pi chat agent (offline fake provider)");
  expect(assistantPreset({}).driver).toBeDefined();
  expect(assistantPreset({ IMWIRE_CHAT: "off" }).driver).toBeUndefined();
  expect(chatPreset({}).driver).toBeUndefined();
});
