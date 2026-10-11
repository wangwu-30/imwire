import { FeishuAdapter } from "@imwire/feishu";
import { TelegramAdapter } from "@imwire/telegram";
import type { Adapter, Inbound } from "@imwire/core";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function summarize(event: Inbound): unknown {
  const { raw: _raw, ...rest } = event;
  return rest;
}

async function handle(adapter: Adapter, event: Inbound): Promise<void> {
  console.log(
    JSON.stringify(
      { platform: adapter.platform, accountId: adapter.accountId, event: summarize(event) },
      null,
      2,
    ),
  );

  if (event.type === "action") {
    const verdict = event.actionId === "approve" ? "Approved." : `Recorded: ${event.actionId}`;
    await adapter.send(event.target.chat, {
      blocks: [{ kind: "markdown", text: verdict }],
    });
    return;
  }

  if (event.type !== "message" && event.type !== "command") return;

  const text = event.type === "command" ? `/${event.name} ${event.args}`.trim() : event.text;
  const chat = event.chat;
  const messageId = event.type === "message" ? event.messageId : event.messageId;

  await adapter.typing(chat);
  const draft = await adapter.draft(chat, {
    replyTo: messageId ? { chat, messageId } : undefined,
  });
  draft.setStatus("echoing…");
  const chunks = text.length > 0 ? text.split(/(\s+)/) : ["(empty)"];
  for (const chunk of chunks) {
    draft.append(chunk);
    await sleep(40);
  }
  await draft.finalize({
    blocks: [
      { kind: "markdown", text: text.length > 0 ? text : "(empty)" },
      {
        kind: "buttons",
        buttons: [
          { id: "approve", label: "Approve", style: "primary" },
          { id: "deny", label: "Deny", style: "danger" },
        ],
      },
    ],
  });
}

function attach(adapter: Adapter): void {
  adapter.on((event) => handle(adapter, event));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const adapters: Adapter[] = [];
  const telegramToken = env("TELEGRAM_BOT_TOKEN");
  const feishuAppId = env("FEISHU_APP_ID");
  const feishuAppSecret = env("FEISHU_APP_SECRET");

  if (telegramToken) {
    const telegram = new TelegramAdapter({
      token: telegramToken,
      accountId: env("TELEGRAM_ACCOUNT_ID"),
    });
    attach(telegram);
    adapters.push(telegram);
    console.log("telegram adapter enabled");
  }

  if (feishuAppId && feishuAppSecret) {
    const domain = env("FEISHU_DOMAIN") === "lark" ? "lark" : "feishu";
    const feishu = new FeishuAdapter({
      appId: feishuAppId,
      appSecret: feishuAppSecret,
      domain,
    });
    attach(feishu);
    adapters.push(feishu);
    console.log(`feishu adapter enabled (${domain})`);
  }

  if (adapters.length === 0) {
    console.error(`imwire echo example

Set env vars (see .env.example) and re-run:

  TELEGRAM_BOT_TOKEN          Telegram bot token (long polling)
  TELEGRAM_ACCOUNT_ID         optional override for the bot id
  FEISHU_APP_ID               Feishu / Lark app id
  FEISHU_APP_SECRET           Feishu / Lark app secret
  FEISHU_DOMAIN               feishu | lark  (default feishu)

You can enable one or both adapters. They share the same handler.`);
    process.exitCode = 1;
    return;
  }

  const ac = new AbortController();
  const stop = (): void => ac.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await Promise.all(adapters.map((adapter) => adapter.start(ac.signal)));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
