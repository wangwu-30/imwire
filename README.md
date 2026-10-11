# imwire

One adapter interface for Feishu, DingTalk, WeCom, Telegram, and Slack. Long-connection first — no public IP required. Built for agents: streaming replies, approval buttons, and (next) a person-scoped session layer that keeps one conversation as you switch IMs.

imwire is the IM layer only. It does not know about people or sessions. A later session package will sit on top; this layer must stay independently usable.

## Quickstart

```bash
pnpm install
pnpm build
cp .env.example .env
# fill TELEGRAM_BOT_TOKEN and/or FEISHU_APP_ID + FEISHU_APP_SECRET
pnpm --filter @imwire/example-echo start
```

The echo example starts every adapter you configured, prints normalized inbound events, streams the reply back, and attaches Approve / Deny buttons.

```ts
import { TelegramAdapter } from "@imwire/telegram";
import { FeishuAdapter } from "@imwire/feishu";
import type { Adapter, Inbound } from "imwire";

function attach(adapter: Adapter) {
  adapter.on(async (event: Inbound) => {
    if (event.type !== "message") return;
    const draft = await adapter.draft(event.chat, {
      replyTo: { chat: event.chat, messageId: event.messageId },
    });
    draft.append(event.text);
    await draft.finalize({
      blocks: [
        { kind: "markdown", text: event.text },
        {
          kind: "buttons",
          buttons: [
            { id: "approve", label: "Approve", style: "primary" },
            { id: "deny", label: "Deny", style: "danger" },
          ],
        },
      ],
    });
  });
}
```

Config is env vars only. Never commit tokens.

## Packages

| Package | Role |
|---|---|
| `imwire` | Normalized events, `Adapter`, capability table, dedup, rate limit, retry, reconnect, chunking, streaming-draft degrade |
| `@imwire/telegram` | Bot API long polling (`getUpdates`), edits, inline keyboards, typing, stream-via-`editMessageText` |
| `@imwire/feishu` | Official `@larksuiteoapi/node-sdk` WebSocket long connection, interactive cards, CardKit streaming with patch fallback |
| `@imwire/example-echo` | Tiny dual-adapter demo |

## Capability table

| | Telegram | Feishu | DingTalk | WeCom | Slack |
|---|---|---|---|---|---|
| Connection (v0) | long polling | WebSocket | Stream (week 3) | long connection (week 3) | Socket Mode (week 3) |
| `streaming` | `edit` | `card` | — | — | — |
| `streamingCard` | no | yes | — | — | — |
| `buttons` | inline keyboard | interactive card | — | — | — |
| `edit` | yes | card patch | — | — | — |
| `threads` | topics / reply | `thread_id` / reply | — | — | — |
| `typing` | `sendChatAction` | no | — | — | — |
| `maxTextLength` | 4096 | 8000 | — | — | — |
| `markdown` | subset | subset | — | — | — |

Streaming drafts degrade automatically: card update when the platform can, otherwise edit-in-place, otherwise buffered chunked sends.

## Roadmap

- **Week 1 (this PR)** — L1 core + Telegram + Feishu, contract tests against recorded fixtures.
- **Week 2** — session layer (`@imwire/session`): pairing, one conversation per person, follow-the-user streaming and approvals, plus pi / ACP integration. The IM layer will not import it.
- **Week 3** — DingTalk Stream, WeCom long connection, Slack Socket Mode, and a Python client via `imwire serve` (JSON-RPC).

## 中文

imwire 是给 agent 用的独立 IM SDK：一套 Adapter 接口接飞书 / 钉钉 / 企微 / Telegram / Slack，默认长连接，不需要公网 IP。面向 agent 的能力（流式回复、审批按钮、后续配对）是一等公民。第 2 周才会做「一个人在所有 IM 上只有一段对话」的会话层；IM 层不依赖它，可以单独引用。

```bash
pnpm install && pnpm build
# 在 .env 里填 TELEGRAM_BOT_TOKEN 或 FEISHU_APP_ID / FEISHU_APP_SECRET
pnpm --filter @imwire/example-echo start
```

## Develop

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

CI (GitHub Actions) runs the same three commands. Tests use recorded fixtures and a fake transport — no live Telegram or Feishu network calls.
