import { FeishuAdapter } from "@imwire/feishu";
import { TelegramAdapter } from "@imwire/telegram";
import { PiAgentDriver, createFakePiProvider } from "@imwire/agent-pi";
import { SessionGateway, type OwnerAllowlistEntry } from "@imwire/session";
import type { Adapter } from "@imwire/core";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

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

function allowlist(): OwnerAllowlistEntry[] {
  const raw = env("IMWIRE_ALLOWLIST");
  return raw ? parseAllowlist(raw) : [];
}

function inferProvider(): string {
  if (env("IMWIRE_PI_PROVIDER")) return env("IMWIRE_PI_PROVIDER")!;
  if (env("ANTHROPIC_API_KEY") && !env("OPENAI_API_KEY")) return "anthropic";
  if (env("OPENAI_API_KEY")) return "openai";
  return "openai";
}

function driver(): PiAgentDriver {
  const usePi = env("IMWIRE_USE_PI") === "1" || Boolean(env("OPENAI_API_KEY") || env("ANTHROPIC_API_KEY"));
  if (usePi) {
    return new PiAgentDriver({
      usePi: true,
      modelProvider: inferProvider(),
      modelId: env("IMWIRE_PI_MODEL"),
      systemPrompt: env("IMWIRE_SYSTEM_PROMPT"),
    });
  }
  return new PiAgentDriver({
    systemPrompt: env("IMWIRE_SYSTEM_PROMPT"),
    source: createFakePiProvider([
      { type: "text", delta: "(offline demo) " },
      { type: "text", delta: "I am the local fake provider. Set OPENAI_API_KEY or ANTHROPIC_API_KEY plus IMWIRE_USE_PI=1 for a real model." },
    ]),
  });
}

async function main(): Promise<void> {
  const adapters: Adapter[] = [];
  const telegramToken = env("TELEGRAM_BOT_TOKEN") ?? env("IMWIRE_TELEGRAM_BOT_TOKEN");
  const feishuAppId = env("FEISHU_APP_ID");
  const feishuAppSecret = env("FEISHU_APP_SECRET");

  if (telegramToken) {
    adapters.push(
      new TelegramAdapter({
        token: telegramToken,
        accountId: env("TELEGRAM_ACCOUNT_ID"),
      }),
    );
    console.log("telegram adapter enabled");
  }
  if (feishuAppId && feishuAppSecret) {
    adapters.push(
      new FeishuAdapter({
        appId: feishuAppId,
        appSecret: feishuAppSecret,
        domain: env("FEISHU_DOMAIN") === "lark" ? "lark" : "feishu",
      }),
    );
    console.log("feishu adapter enabled");
  }

  if (adapters.length === 0) {
    console.error(`imwire assistant

Set env vars (see .env.example):

  TELEGRAM_BOT_TOKEN / IMWIRE_TELEGRAM_BOT_TOKEN
  FEISHU_APP_ID + FEISHU_APP_SECRET
  IMWIRE_ALLOWLIST          platform:accountId:userId[,Name]  (comma or semicolon)
  IMWIRE_DB                 sqlite path (default ./imwire.sqlite)
  IMWIRE_USE_PI=1           + OPENAI_API_KEY or ANTHROPIC_API_KEY
`);
    process.exitCode = 1;
    return;
  }

  const gw = new SessionGateway({
    dbPath: env("IMWIRE_DB") ?? "./imwire.sqlite",
    driver: driver(),
    allowlist: allowlist(),
  });
  for (const adapter of adapters) gw.attach(adapter);

  const ac = new AbortController();
  const stop = (): void => {
    ac.abort();
    gw.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await Promise.all(adapters.map((a) => a.start(ac.signal)));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
