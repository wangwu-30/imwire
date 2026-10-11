import { describe, expect, it } from "vitest";
import { DingTalkAdapter, createDingTalkHttp, DINGTALK_STREAM_CONTENT_LIMIT } from "@imwire/dingtalk";
import { FeishuAdapter, FEISHU_MAX_TEXT } from "@imwire/feishu";
import { SlackAdapter, createSlackWeb } from "@imwire/slack";
import { TelegramAdapter, TELEGRAM_MAX_TEXT } from "@imwire/telegram";
import { WecomAdapter, createRawWecomTransport, WECOM_MAX_TEXT } from "@imwire/wecom";
import type { ChatRef } from "@imwire/core";
import { startDingTalkMock } from "./mocks/dingtalk.js";
import { startFeishuMock } from "./mocks/feishu.js";
import { startSlackMock } from "./mocks/slack.js";
import { startTelegramMock } from "./mocks/telegram.js";
import { startWecomMock } from "./mocks/wecom.js";
import { noopRealtime, waitFor } from "./helpers.js";

const tgChat: ChatRef = { platform: "telegram", accountId: "telegram", chatId: "111", kind: "dm" };
const fsChat: ChatRef = { platform: "feishu", accountId: "cli_e2e", chatId: "oc_dm_1", kind: "dm" };
const slackChat: ChatRef = { platform: "slack", accountId: "slack", chatId: "D111", kind: "dm" };
const dtChat: ChatRef = { platform: "dingtalk", accountId: "ding-e2e", chatId: "staff_ada", kind: "dm" };
const wecomChat: ChatRef = { platform: "wecom", accountId: "bot-e2e", chatId: "CHATID_DM", kind: "dm" };

describe("e2e streaming + chunking + rate limit against platform mocks", () => {
  it(
    "Telegram: chunks over 4096 and coalesces draft edits; outbound is 1/s burst 3",
    async () => {
    const mock = await startTelegramMock();
    try {
      const adapter = new TelegramAdapter({
        token: mock.token,
        accountId: "telegram",
        baseUrl: mock.url,
        draftThrottleMs: 40,
      });

      const long = "T".repeat(TELEGRAM_MAX_TEXT + 200);
      await adapter.send(tgChat, { blocks: [{ kind: "markdown", text: long }] });
      const sends = mock.requests.filter((r) => r.path.endsWith("/sendMessage"));
      expect(sends.length).toBeGreaterThanOrEqual(2);
      expect((sends[0]?.body as { text?: string }).text?.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);

      const sendCount = () => mock.requests.filter((r) => r.path.endsWith("/sendMessage")).length;
      const editCount = () => mock.requests.filter((r) => r.path.endsWith("/editMessageText")).length;
      const beforeDraft = sendCount();
      const draft = await adapter.draft(tgChat);
      draft.append("alpha ");
      await waitFor(() => sendCount() > beforeDraft);
      draft.append("beta ");
      draft.append("gamma ");
      draft.append("delta");
      await waitFor(() => editCount() > 0);
      await draft.finalize({ blocks: [{ kind: "markdown", text: "alpha beta gamma delta" }] });
      expect(editCount()).toBeGreaterThan(0);
      expect(editCount()).toBeLessThan(8);
      expect(mock.texts().some((t) => t.includes("alpha beta gamma delta"))).toBe(true);

      const before = mock.requests.filter((r) => r.path.endsWith("/sendMessage")).length;
      const t0 = Date.now();
      for (let i = 0; i < 4; i += 1) {
        await adapter.send(tgChat, { blocks: [{ kind: "markdown", text: `burst-${i}` }] });
      }
      const elapsed = Date.now() - t0;
      const after = mock.requests.filter((r) => r.path.endsWith("/sendMessage")).length;
      expect(after - before).toBe(4);
      expect(elapsed).toBeGreaterThanOrEqual(700);
    } finally {
      await mock.close();
    }
    },
    15_000,
  );

  it("Feishu: chunks over 8000 and streams via CardKit against a local Open API", async () => {
    const mock = await startFeishuMock();
    try {
      const adapter = new FeishuAdapter({
        appId: "cli_e2e",
        appSecret: "secret",
        accountId: "cli_e2e",
        apiBase: mock.url,
        realtime: noopRealtime(),
        draftThrottleMs: 20,
      });

      const long = "F".repeat(FEISHU_MAX_TEXT + 300);
      await adapter.send(fsChat, { blocks: [{ kind: "markdown", text: long }] });
      const creates = mock.requests.filter((r) => r.method === "POST" && r.path === "/open-apis/im/v1/messages");
      expect(creates.length).toBeGreaterThanOrEqual(2);

      const draft = await adapter.draft(fsChat);
      draft.append("hello ");
      draft.append("card stream");
      await draft.finalize({
        blocks: [
          { kind: "markdown", text: "hello card stream" },
          { kind: "buttons", buttons: [{ id: "approve", label: "Approve", style: "primary" }] },
        ],
      });
      expect(mock.requests.some((r) => r.path.includes("/cardkit/v1/cards"))).toBe(true);
      expect(mock.texts().some((t) => t.includes("hello card stream"))).toBe(true);
    } finally {
      await mock.close();
    }
  });

  it("Slack: streams by editing chat.update and chunks over 40000", async () => {
    const mock = await startSlackMock();
    try {
      const adapter = new SlackAdapter({
        botToken: "xoxb-e2e",
        accountId: "slack",
        web: createSlackWeb({ botToken: "xoxb-e2e", apiBase: mock.url }),
        draftThrottleMs: 20,
      });

      const long = "S".repeat(40_000 + 50);
      await adapter.send(slackChat, { blocks: [{ kind: "markdown", text: long }] });
      const chunkPosts = mock.requests.filter((r) => r.path.endsWith("/chat.postMessage"));
      expect(chunkPosts.length).toBeGreaterThanOrEqual(2);

      const postCount = () => mock.requests.filter((r) => r.path.endsWith("/chat.postMessage")).length;
      const updates = () => mock.requests.filter((r) => r.path.endsWith("/chat.update")).length;
      const beforeDraft = postCount();
      const draft = await adapter.draft(slackChat);
      draft.append("one ");
      await waitFor(() => postCount() > beforeDraft);
      draft.append("two");
      await waitFor(() => updates() > 0);
      await draft.finalize({ blocks: [{ kind: "markdown", text: "one two" }] });
      expect(updates()).toBeGreaterThan(0);
      expect(mock.texts().some((t) => t.includes("one two"))).toBe(true);
    } finally {
      await mock.close();
    }
  });

  it("DingTalk: AI card stream PUTs stay within the 1 KB content cap", async () => {
    const mock = await startDingTalkMock();
    try {
      const adapter = new DingTalkAdapter({
        clientId: "ding-e2e",
        clientSecret: "secret",
        accountId: "ding-e2e",
        cardTemplateId: "tpl-e2e",
        http: createDingTalkHttp({
          clientId: "ding-e2e",
          clientSecret: "secret",
          apiBase: mock.url,
        }),
        stream: { start: async () => undefined, isAlive: () => false, stop() {} },
        draftThrottleMs: 0,
      });

      const long = "D".repeat(2400);
      const draft = await adapter.draft(dtChat);
      draft.append(long);
      await draft.finalize({
        blocks: [
          { kind: "markdown", text: long },
          {
            kind: "buttons",
            buttons: [
              { id: "approve", label: "Approve", style: "primary" },
              { id: "deny", label: "Deny", style: "danger" },
            ],
          },
        ],
      });

      const streamed = mock.streamContents();
      expect(streamed.length).toBeGreaterThan(0);
      for (const chunk of streamed) {
        expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(DINGTALK_STREAM_CONTENT_LIMIT);
      }
      expect(mock.requests.some((r) => r.path === "/v1.0/card/instances/createAndDeliver")).toBe(true);
    } finally {
      await mock.close();
    }
  });

  it("WeCom: streams aibot_respond_msg over a local WS and chunks over 4096", async () => {
    const mock = await startWecomMock();
    const ac = new AbortController();
    try {
      const adapter = new WecomAdapter({
        botId: "bot-e2e",
        secret: "secret",
        accountId: "bot-e2e",
        transport: createRawWecomTransport({
          botId: "bot-e2e",
          secret: "secret",
          url: mock.url,
          pingMs: 60_000,
        }),
        draftThrottleMs: 20,
      });
      const started = adapter.start(ac.signal);
      await waitFor(() => mock.frames.some((f) => f.cmd === "aibot_subscribe"));
      adapter.rememberReply(wecomChat.chatId, "req-e2e", "MSGID_E2E");

      const long = "W".repeat(WECOM_MAX_TEXT + 80);
      await adapter.send(wecomChat, { blocks: [{ kind: "markdown", text: long }] });
      const responds = mock.frames.filter((f) => f.cmd === "aibot_respond_msg");
      expect(responds.length).toBeGreaterThanOrEqual(2);

      const draft = await adapter.draft(wecomChat);
      draft.append("stream ");
      draft.append("ok");
      await draft.finalize({ blocks: [{ kind: "markdown", text: "stream ok" }] });
      expect(mock.streamContents().some((t) => t.includes("stream"))).toBe(true);

      ac.abort();
      await started;
    } finally {
      ac.abort();
      await mock.close();
    }
  });
});
