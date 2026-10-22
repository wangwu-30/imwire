import { PiAgentDriver, createFakePiProvider } from "@imwire/agent-pi";
import type { AgentDriver } from "@imwire/session";

type Env = Record<string, string | undefined>;
const get = (env: Env, key: string) => env[key] || undefined;

/** Shared pi selection. Only the assistant demo opts into a no-key fake fallback. */
export function chatPreset(
  env: Env = process.env,
  opts: { offlineFallback?: boolean } = {},
): { driver?: AgentDriver; describe: string[] } {
  const usePi = get(env, "IMWIRE_USE_PI") === "1" || Boolean(get(env, "OPENAI_API_KEY") || get(env, "ANTHROPIC_API_KEY"));
  if (get(env, "IMWIRE_CHAT") === "off" || (!usePi && !opts.offlineFallback)) {
    return { describe: ["chat disabled"] };
  }
  const provider = get(env, "IMWIRE_PI_PROVIDER") ??
    (get(env, "ANTHROPIC_API_KEY") && !get(env, "OPENAI_API_KEY") ? "anthropic" : "openai");
  if (!usePi || provider === "fake") {
    return {
      driver: new PiAgentDriver({
        systemPrompt: get(env, "IMWIRE_SYSTEM_PROMPT"),
        source: createFakePiProvider([
          { type: "text", delta: "(offline demo) " },
          { type: "text", delta: "I am the local fake provider. Set OPENAI_API_KEY or ANTHROPIC_API_KEY plus IMWIRE_USE_PI=1 for a real model." },
        ]),
      }),
      describe: ["pi chat agent (offline fake provider)"],
    };
  }
  return {
    driver: new PiAgentDriver({
      usePi: true,
      modelProvider: provider,
      modelId: get(env, "IMWIRE_PI_MODEL"),
      systemPrompt: get(env, "IMWIRE_SYSTEM_PROMPT"),
    }),
    describe: [`pi chat agent (${provider})`],
  };
}
