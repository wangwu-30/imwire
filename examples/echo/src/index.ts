import { DingTalkAdapter } from "@imwire/dingtalk";
import { FeishuAdapter } from "@imwire/feishu";
import { SlackAdapter } from "@imwire/slack";
import { TelegramAdapter } from "@imwire/telegram";
import { WecomAdapter } from "@imwire/wecom";
import { onShutdownSignal, type Adapter, type Inbound } from "@imwire/core";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function summarize(event: Inbound): unknown {
  const { raw: _raw, ...rest } = event;
  return rest;
}

const handledActions = new Set<string>();

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
    // Replace the card so its buttons disappear and a second click has nothing to hit.
    if (handledActions.has(event.target.messageId)) return;
    handledActions.add(event.target.messageId);
    try {
      await adapter.edit(event.target, { blocks: [{ kind: "markdown", text: `_handled: ${verdict}_` }] });
    } catch {
      await adapter.send(event.target.chat, { blocks: [{ kind: "markdown", text: verdict }] });
    }
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
  // CJK has no whitespace. Finish any message within ~8 s: ≤40 chunks × 200 ms.
  const chunks = visibleChunks(text);
  for (const chunk of chunks) {
    draft.append(chunk);
    await sleep(200);
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

/** Character groups so CJK streams visibly. Size = ceil(len/40) → ≤8 s at 200 ms. */
export function visibleChunks(text: string): string[] {
  if (!text) return ["(empty)"];
  const chars = [...text];
  const size = Math.max(1, Math.ceil(chars.length / 40));
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) {
    out.push(chars.slice(i, i + size).join(""));
  }
  return out;
}

async function main(): Promise<void> {
  const adapters: Adapter[] = [];
  const telegramToken = env("TELEGRAM_BOT_TOKEN") ?? env("IMWIRE_TELEGRAM_BOT_TOKEN");
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

  const dingClientId = env("DINGTALK_CLIENT_ID") ?? env("DINGTALK_APP_KEY");
  const dingSecret = env("DINGTALK_CLIENT_SECRET") ?? env("DINGTALK_APP_SECRET");
  if (dingClientId && dingSecret) {
    const dingtalk = new DingTalkAdapter({
      clientId: dingClientId,
      clientSecret: dingSecret,
      accountId: env("DINGTALK_ACCOUNT_ID"),
      robotCode: env("DINGTALK_ROBOT_CODE"),
      cardTemplateId: env("DINGTALK_CARD_TEMPLATE_ID"),
      streamKey: env("DINGTALK_CARD_STREAM_KEY"),
    });
    attach(dingtalk);
    adapters.push(dingtalk);
    console.log("dingtalk adapter enabled (Stream; live org unverified)");
  }

  const wecomBot = env("WECOM_BOT_ID") ?? env("WECOM_AIBOT_ID");
  const wecomSecret = env("WECOM_SECRET") ?? env("WECOM_AIBOT_SECRET");
  if (wecomBot && wecomSecret) {
    const wecom = new WecomAdapter({
      botId: wecomBot,
      secret: wecomSecret,
      accountId: env("WECOM_ACCOUNT_ID"),
      replyStorePath: env("WECOM_REPLY_STORE"),
    });
    attach(wecom);
    adapters.push(wecom);
    console.log("wecom adapter enabled (智能机器人 long-conn; live unverified)");
  }

  const slackBot = env("SLACK_BOT_TOKEN");
  const slackApp = env("SLACK_APP_TOKEN");
  if (slackBot && slackApp) {
    const slack = new SlackAdapter({
      botToken: slackBot,
      appToken: slackApp,
      accountId: env("SLACK_ACCOUNT_ID"),
    });
    attach(slack);
    adapters.push(slack);
    console.log("slack adapter enabled (Socket Mode; live unverified)");
  }

  if (adapters.length === 0) {
    console.error(`imwire echo example

Set env vars (see .env.example) and re-run:

  TELEGRAM_BOT_TOKEN          Telegram bot token (long polling)
  IMWIRE_TELEGRAM_BOT_TOKEN   alias of TELEGRAM_BOT_TOKEN
  TELEGRAM_ACCOUNT_ID         optional override for the bot id
  FEISHU_APP_ID               Feishu / Lark app id
  FEISHU_APP_SECRET           Feishu / Lark app secret
  FEISHU_DOMAIN               feishu | lark  (default feishu)
  DINGTALK_CLIENT_ID          DingTalk Stream client id / app key
  DINGTALK_CLIENT_SECRET      DingTalk client secret
  DINGTALK_CARD_TEMPLATE_ID   AI card template (streaming + callbacks)
  WECOM_BOT_ID / WECOM_SECRET WeCom 智能机器人 long-connection
  SLACK_BOT_TOKEN             xoxb- bot token
  SLACK_APP_TOKEN             xapp- app-level token (connections:write)

You can enable any combination. They share the same handler.`);
    process.exitCode = 1;
    return;
  }

  const ac = new AbortController();
  onShutdownSignal(() => ac.abort());

  await Promise.all(adapters.map((adapter) => adapter.start(ac.signal)));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
