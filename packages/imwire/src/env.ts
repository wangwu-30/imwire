import { DingTalkAdapter } from "@imwire/dingtalk";
import { FeishuAdapter } from "@imwire/feishu";
import { SlackAdapter } from "@imwire/slack";
import { TelegramAdapter } from "@imwire/telegram";
import { WecomAdapter } from "@imwire/wecom";
import type { Adapter } from "@imwire/core";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/** Build every adapter that has credentials in the environment. */
export function loadAdaptersFromEnv(): Adapter[] {
  const adapters: Adapter[] = [];

  const telegramToken = env("TELEGRAM_BOT_TOKEN") ?? env("IMWIRE_TELEGRAM_BOT_TOKEN");
  if (telegramToken) {
    adapters.push(
      new TelegramAdapter({
        token: telegramToken,
        accountId: env("TELEGRAM_ACCOUNT_ID"),
      }),
    );
  }

  const feishuAppId = env("FEISHU_APP_ID");
  const feishuAppSecret = env("FEISHU_APP_SECRET");
  if (feishuAppId && feishuAppSecret) {
    adapters.push(
      new FeishuAdapter({
        appId: feishuAppId,
        appSecret: feishuAppSecret,
        domain: env("FEISHU_DOMAIN") === "lark" ? "lark" : "feishu",
      }),
    );
  }

  const dtId = env("DINGTALK_CLIENT_ID") ?? env("DINGTALK_APP_KEY");
  const dtSecret = env("DINGTALK_CLIENT_SECRET") ?? env("DINGTALK_APP_SECRET");
  if (dtId && dtSecret) {
    adapters.push(
      new DingTalkAdapter({
        clientId: dtId,
        clientSecret: dtSecret,
        accountId: env("DINGTALK_ACCOUNT_ID"),
        robotCode: env("DINGTALK_ROBOT_CODE"),
        cardTemplateId: env("DINGTALK_CARD_TEMPLATE_ID"),
        streamKey: env("DINGTALK_CARD_STREAM_KEY"),
      }),
    );
  }

  const wecomBot = env("WECOM_BOT_ID") ?? env("WECOM_AIBOT_ID");
  const wecomSecret = env("WECOM_SECRET") ?? env("WECOM_AIBOT_SECRET");
  if (wecomBot && wecomSecret) {
    adapters.push(
      new WecomAdapter({
        botId: wecomBot,
        secret: wecomSecret,
        accountId: env("WECOM_ACCOUNT_ID"),
      }),
    );
  }

  const slackBot = env("SLACK_BOT_TOKEN");
  const slackApp = env("SLACK_APP_TOKEN");
  if (slackBot && slackApp) {
    adapters.push(
      new SlackAdapter({
        botToken: slackBot,
        appToken: slackApp,
        accountId: env("SLACK_ACCOUNT_ID"),
      }),
    );
  }

  return adapters;
}
