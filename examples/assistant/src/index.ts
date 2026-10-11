import { FeishuAdapter } from "@imwire/feishu";
import { TelegramAdapter } from "@imwire/telegram";
import { PiAgentDriver, createFakePiProvider } from "@imwire/agent-pi";
import { SessionGateway, type OwnerAllowlistEntry } from "@imwire/session";
import type { Adapter } from "@imwire/core";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function allowlist(): OwnerAllowlistEntry[] {
  const raw = env("IMWIRE_ALLOWLIST");
  if (!raw) return [];
  // platform:accountId:userId[,name]
  return raw.split(/[;\n]/).flatMap((part) => {
    const [triple, name] = part.trim().split(",", 2);
    const [platform, accountId, userId] = (triple ?? "").split(":");
    if (!platform || !accountId || !userId) return [];
    return [{ platform, accountId, userId, name }];
  });
}

function driver(): PiAgentDriver {
  const usePi = env("IMWIRE_USE_PI") === "1" || Boolean(env("OPENAI_API_KEY") || env("ANTHROPIC_API_KEY"));
  if (usePi) {
    return new PiAgentDriver({
      usePi: true,
      modelProvider: env("IMWIRE_PI_PROVIDER"),
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
  IMWIRE_ALLOWLIST          platform:accountId:userId  (comma-separated)
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
