import { DingTalkAdapter } from "@imwire/dingtalk";
import { FeishuAdapter } from "@imwire/feishu";
import { SlackAdapter } from "@imwire/slack";
import { TelegramAdapter } from "@imwire/telegram";
import { WecomAdapter } from "@imwire/wecom";
import type { Adapter, Logger } from "@imwire/core";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export const ADAPTER_NAMES = ["telegram", "feishu", "dingtalk", "wecom", "slack"] as const;
export type AdapterName = (typeof ADAPTER_NAMES)[number];

export function parseAdapterList(raw: string | undefined): AdapterName[] {
  if (!raw) return [];
  const out: AdapterName[] = [];
  for (const part of raw.split(/[,;\s]+/)) {
    const name = part.trim().toLowerCase();
    if (!name) continue;
    if (!(ADAPTER_NAMES as readonly string[]).includes(name)) {
      throw new Error(`unknown adapter ${name}; expected ${ADAPTER_NAMES.join("|")}`);
    }
    if (!out.includes(name as AdapterName)) out.push(name as AdapterName);
  }
  return out;
}

export interface LoadAdapterOptions {
  /** Explicit allow-list. Serve refuses to start without this. */
  enabled: AdapterName[];
  logger?: Logger;
}

/** Build only the adapters named in `enabled`. Tokens are never inferred as “start this bot”. */
export function loadAdaptersFromEnv(opts: LoadAdapterOptions): Adapter[] {
  const adapters: Adapter[] = [];
  const logger = opts.logger;

  for (const name of opts.enabled) {
    if (name === "telegram") {
      const telegramToken = env("TELEGRAM_BOT_TOKEN");
      if (!telegramToken) throw new Error("telegram enabled but TELEGRAM_BOT_TOKEN is empty");
      adapters.push(new TelegramAdapter({ token: telegramToken, accountId: env("TELEGRAM_ACCOUNT_ID"), logger }));
    }
    if (name === "feishu") {
      const feishuAppId = env("FEISHU_APP_ID");
      const feishuAppSecret = env("FEISHU_APP_SECRET");
      if (!feishuAppId || !feishuAppSecret) throw new Error("feishu enabled but FEISHU_APP_ID / FEISHU_APP_SECRET missing");
      adapters.push(
        new FeishuAdapter({
          appId: feishuAppId,
          appSecret: feishuAppSecret,
          domain: env("FEISHU_DOMAIN") === "lark" ? "lark" : "feishu",
          logger,
        }),
      );
    }
    if (name === "dingtalk") {
      const dtId = env("DINGTALK_CLIENT_ID") ?? env("DINGTALK_APP_KEY");
      const dtSecret = env("DINGTALK_CLIENT_SECRET") ?? env("DINGTALK_APP_SECRET");
      if (!dtId || !dtSecret) throw new Error("dingtalk enabled but DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET missing");
      adapters.push(
        new DingTalkAdapter({
          clientId: dtId,
          clientSecret: dtSecret,
          accountId: env("DINGTALK_ACCOUNT_ID"),
          robotCode: env("DINGTALK_ROBOT_CODE"),
          cardTemplateId: env("DINGTALK_CARD_TEMPLATE_ID"),
          streamKey: env("DINGTALK_CARD_STREAM_KEY"),
          logger,
        }),
      );
    }
    if (name === "wecom") {
      const wecomBot = env("WECOM_BOT_ID") ?? env("WECOM_AIBOT_ID");
      const wecomSecret = env("WECOM_SECRET") ?? env("WECOM_AIBOT_SECRET");
      if (!wecomBot || !wecomSecret) throw new Error("wecom enabled but WECOM_BOT_ID / WECOM_SECRET missing");
      adapters.push(new WecomAdapter({ botId: wecomBot, secret: wecomSecret, accountId: env("WECOM_ACCOUNT_ID"), logger }));
    }
    if (name === "slack") {
      const slackBot = env("SLACK_BOT_TOKEN");
      const slackApp = env("SLACK_APP_TOKEN");
      if (!slackBot || !slackApp) throw new Error("slack enabled but SLACK_BOT_TOKEN / SLACK_APP_TOKEN missing");
      adapters.push(
        new SlackAdapter({
          botToken: slackBot,
          appToken: slackApp,
          accountId: env("SLACK_ACCOUNT_ID"),
          logger,
        }),
      );
    }
  }

  return adapters;
}
