import type { Adapter } from "@imwire/core";
import { FeishuAdapter } from "@imwire/feishu";
import { TelegramAdapter } from "@imwire/telegram";
import { PiAgentDriver, createFakePiProvider } from "@imwire/agent-pi";
import type { AgentDriver, OwnerAllowlistEntry, SessionStore } from "@imwire/session";

type Env = Record<string, string | undefined>;
const get = (env: Env, k: string) => (env[k] && env[k]!.length > 0 ? env[k] : undefined);

/** Entries are `platform:accountId:userId` or `platform:accountId:userId,Name`, separated by comma, semicolon, or newline. */
export function parseAllowlist(raw: string): OwnerAllowlistEntry[] {
  const tokens = raw.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  const out: OwnerAllowlistEntry[] = [];
  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i] ?? "";
    const parts = t.split(":");
    if (parts.length >= 3) {
      const platform = parts[0] ?? "";
      const userId = parts[parts.length - 1] ?? "";
      const accountId = parts.slice(1, -1).join(":");
      const next = tokens[i + 1];
      const named = next && !next.includes(":");
      out.push({ platform, accountId, userId, name: named ? next : undefined });
      i += named ? 2 : 1;
    } else {
      i += 1;
    }
  }
  return out;
}

/** The former examples/assistant wiring: Telegram + Feishu from env, optional pi chat agent. */
export function assistantPreset(env: Env = process.env): {
  allowlist: OwnerAllowlistEntry[];
  driver?: AgentDriver;
  /** Adapters need the store for persistent Telegram callbacks, so they are built after the gateway opens the DB. */
  adapters(store: () => SessionStore): Adapter[];
  describe: string[];
} {
  const describe: string[] = [];
  const telegramToken = get(env, "TELEGRAM_BOT_TOKEN") ?? get(env, "IMWIRE_TELEGRAM_BOT_TOKEN");
  const feishuId = get(env, "FEISHU_APP_ID");
  const feishuSecret = get(env, "FEISHU_APP_SECRET");
  if (telegramToken) describe.push("telegram adapter enabled");
  if (feishuId && feishuSecret) describe.push("feishu adapter enabled");

  let driver: AgentDriver | undefined;
  const usePi = get(env, "IMWIRE_USE_PI") === "1" || Boolean(get(env, "OPENAI_API_KEY") || get(env, "ANTHROPIC_API_KEY"));
  if (get(env, "IMWIRE_CHAT") !== "off") {
    if (usePi) {
      const provider =
        get(env, "IMWIRE_PI_PROVIDER") ??
        (get(env, "ANTHROPIC_API_KEY") && !get(env, "OPENAI_API_KEY") ? "anthropic" : "openai");
      driver = new PiAgentDriver({
        usePi: true,
        modelProvider: provider,
        modelId: get(env, "IMWIRE_PI_MODEL"),
        systemPrompt: get(env, "IMWIRE_SYSTEM_PROMPT"),
      });
      describe.push(`pi chat agent (${provider})`);
    } else {
      driver = new PiAgentDriver({
        systemPrompt: get(env, "IMWIRE_SYSTEM_PROMPT"),
        source: createFakePiProvider([
          { type: "text", delta: "(offline demo) " },
          { type: "text", delta: "I am the local fake provider. Set OPENAI_API_KEY or ANTHROPIC_API_KEY plus IMWIRE_USE_PI=1 for a real model." },
        ]),
      });
      describe.push("pi chat agent (offline fake provider)");
    }
  }

  return {
    allowlist: get(env, "IMWIRE_ALLOWLIST") ? parseAllowlist(get(env, "IMWIRE_ALLOWLIST")!) : [],
    driver,
    describe,
    adapters: (store) => {
      const out: Adapter[] = [];
      if (telegramToken) {
        out.push(
          new TelegramAdapter({
            token: telegramToken,
            accountId: get(env, "TELEGRAM_ACCOUNT_ID"),
            callbackStore: { get: (k) => store().getCallback(k), set: (k, v) => store().setCallback(k, v) },
          }),
        );
      }
      if (feishuId && feishuSecret) {
        out.push(
          new FeishuAdapter({
            appId: feishuId,
            appSecret: feishuSecret,
            domain: get(env, "FEISHU_DOMAIN") === "lark" ? "lark" : "feishu",
          }),
        );
      }
      return out;
    },
  };
}
