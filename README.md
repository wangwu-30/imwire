# imwire

One adapter interface for Feishu, DingTalk, WeCom, Telegram, and Slack. Long-connection first — no public IP required. Built for agents: streaming replies, approval buttons, and (next) a person-scoped session layer that keeps one conversation as you switch IMs.

imwire is the IM layer only. It does not know about people or sessions. A later session package will sit on top; this layer must stay independently usable.

Packages are **ESM-only** (Node 20+). The npm name `imwire` is reserved for the future CLI / `imwire serve` package; import the SDK as `@imwire/core`.

## Quickstart

```bash
pnpm install
pnpm build
cp .env.example .env
# fill TELEGRAM_BOT_TOKEN and/or FEISHU_APP_ID + FEISHU_APP_SECRET
pnpm --filter @imwire/example-echo start
```

The echo script is `node --env-file=../../.env dist/index.js` (Node ≥ 20.6). Copy `.env.example` first; without that file Node will refuse to start. You can also `export` the same variables yourself.

The echo example starts every adapter you configured, prints normalized inbound events, streams the reply back, and attaches Approve / Deny buttons.

```ts
import { TelegramAdapter } from "@imwire/telegram";
import { FeishuAdapter } from "@imwire/feishu";
import type { Adapter, Inbound } from "@imwire/core";

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
            { id: "approve", label: "Approve", style: "primary", value: "ok" },
            { id: "deny", label: "Deny", style: "danger" },
          ],
        },
      ],
    });
  });
}
```

Config is env vars only. Never commit tokens.

`on()` handlers are dispatched off the transport loop (per-chat ordered queue for messages; actions / edits / reactions run in parallel so an approval-awaiting handler still receives the click). Feishu card callbacks are acked immediately (3 s deadline).

## Packages

| Package | Role |
|---|---|
| `@imwire/core` | Normalized events, `Adapter`, capability table, dedup, rate limit, retry, reconnect, chunking, streaming-draft degrade. The `imwire` name is reserved for the CLI. |
| `@imwire/telegram` | Bot API long polling (`getUpdates`), edits, inline keyboards, typing, stream-via-`editMessageText` |
| `@imwire/feishu` | Official `@larksuiteoapi/node-sdk` WebSocket long connection, Card JSON 2.0, CardKit streaming with patch fallback |
| `@imwire/example-echo` | Tiny dual-adapter demo |

`@imwire/core/testing` imports `vitest` at runtime; vitest is an optional peer dependency of `@imwire/core`.

## Capability table

| | Telegram | Feishu | DingTalk | WeCom | Slack |
|---|---|---|---|---|---|
| Connection (v0) | long polling | WebSocket | Stream (week 3) | long connection (week 3) | Socket Mode (week 3) |
| `streaming` | `edit` | `card` | — | — | — |
| `streamingCard` | no | yes | — | — | — |
| `buttons` | inline keyboard | Card JSON 2.0 button + `behaviors.callback` | — | — | — |
| `edit` / `editScope` | yes / `any` | yes / `cards` | — | — | — |
| `editTextMessages` | yes | **false** — `PATCH /im/v1/messages` only accepts interactive cards. `send()` therefore always uses cards so later `edit()` works. | — | — | — |
| `proactiveSend` | yes | yes | — | — | — |
| `delete` | yes | yes | — | — | — |
| `threads` | forum topics (`is_topic_message`) | `thread_id` / reply | — | — | — |
| `typing` | `sendChatAction` | no | — | — | — |
| `media` | not implemented (`false`) | not implemented (`false`) | — | — | — |
| `maxTextLength` | 4096 | 8000 (card body also clipped to 30 KB) | — | — | — |
| `markdown` | `none` (no `parse_mode`; `**x**` is literal) | `subset` (card `markdown` tag) | — | — | — |

Streaming drafts degrade automatically: card update when the platform can, otherwise edit-in-place, otherwise buffered chunked sends. Stream updates are latest-wins coalesced (one in-flight + one pending) and skip unchanged text.

`Button` is `{ id, label, style?, value? }` on every platform. Telegram callback_data is limited to 64 **bytes**; longer payloads (including CJK ids) are hashed with an in-memory fallback table.

## Roadmap

- **Week 1 (this PR)** — L1 core + Telegram + Feishu, contract tests against recorded fixtures.
- **Week 2** — session layer (`@imwire/session`): pairing, one conversation per person, follow-the-user streaming and approvals, plus pi / ACP integration. The IM layer will not import it.
- **Week 3** — DingTalk Stream, WeCom long connection, Slack Socket Mode, and a Python client via `imwire serve` (JSON-RPC).

## 中文

imwire 是给 agent 用的独立 IM SDK：一套 Adapter 接口接飞书 / 钉钉 / 企微 / Telegram / Slack，默认长连接，不需要公网 IP。面向 agent 的能力（流式回复、审批按钮、后续配对）是一等公民。第 2 周才会做「一个人在所有 IM 上只有一段对话」的会话层；IM 层不依赖它，可以单独引用。

核心包名是 `@imwire/core`（`imwire` 留给以后的 CLI）。包是 ESM-only。

```bash
pnpm install && pnpm build
cp .env.example .env   # echo 用 node --env-file 加载
# 在 .env 里填 TELEGRAM_BOT_TOKEN 或 FEISHU_APP_ID / FEISHU_APP_SECRET
pnpm --filter @imwire/example-echo start
```

飞书 `send()` 一律发交互卡片：飞书的 `PATCH` 只能改卡片，不能改普通文本（`editTextMessages=false`，`editScope:"cards"`）。卡片用 Card JSON 2.0（按钮直接放在 `body.elements`，带 `behaviors.callback`，不要 `tag:action` / `wide_screen_mode`）。

## Develop

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

CI (GitHub Actions) runs the same three commands. Tests use recorded fixtures and a fake transport — no live Telegram or Feishu network calls.
