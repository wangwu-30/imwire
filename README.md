# imwire

One adapter interface for Feishu, DingTalk, WeCom, Telegram, and Slack. Long-connection first — no public IP required. Built for agents: streaming replies, approval buttons, and a person-scoped session layer that keeps one conversation as you switch IMs.

L1 (`@imwire/core` + platform adapters) does not know about people or sessions and stays independently usable. L2 (`@imwire/session`) sits on top of the adapter interface. L3 (`@imwire/agent-pi`) is one `AgentDriver` implementation; ACP drivers can be added later.

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

The echo example starts every adapter you configured, prints normalized inbound events, streams the reply back, and attaches Approve / Deny buttons. The assistant example wires Telegram + Feishu through `@imwire/session` and `@imwire/agent-pi` (env-config only):

```bash
# same .env; add IMWIRE_ALLOWLIST=telegram:telegram:<your user id>,Owner
pnpm --filter @imwire/example-assistant start
```

Owner bootstrap is the allowlist. From a linked IM send `/pair`, then paste the 6-digit code into the bot on a new IM. `/topic name` and `/topics` switch a named conversation across every linked IM. Group chats stay isolated.

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
| `@imwire/session` | Person identities, hashed `/pair` codes (lockout + one live code), default + named topics, group isolation, follow-the-user routing, mid-stream switch, first-click-wins + authorized + TTL approvals. SQLite WAL + `busy_timeout` (better-sqlite3, or `node:sqlite` on Node 22+). Depends only on `@imwire/core`. |
| `@imwire/agent-pi` | `AgentDriver` over `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` 1.1.0. One Agent per conversation; log → pi `Message` shapes; live `text_delta` streaming; `beforeToolCall` → imwire approvals. Tests use pi-ai `fauxProvider` (no network). |
| `@imwire/example-echo` | Tiny dual-adapter demo |
| `@imwire/example-assistant` | Telegram + Feishu + session + pi, env-config only |

`@imwire/core/testing` imports `vitest` at runtime; vitest is an optional peer dependency of `@imwire/core`.

## Capability table

| | Telegram | Feishu | DingTalk | WeCom | Slack |
|---|---|---|---|---|---|
| Connection (v0) | long polling | WebSocket | Stream (week 3) | long connection (week 3) | Socket Mode (week 3) |
| `streaming` | `edit` | `card` | — | — | — |
| `streamingCard` | no | yes | — | — | — |
| `buttons` | inline keyboard | Card JSON 2.0 button + `behaviors.callback` | — | — | — |
| `edit` / `editScope` | yes / `any` | yes / `cards` — `PATCH /im/v1/messages` only accepts interactive cards, so `send()` always uses cards. (`editTextMessages` was folded into `editScope`.) | — | — | — |
| `proactiveSend` | yes | yes | — | — | — |
| `delete` | yes | yes | — | — | — |
| `threads` | forum topics (`is_topic_message`) | `thread_id` / reply | — | — | — |
| `typing` | `sendChatAction` | no | — | — | — |
| `media` | not implemented (`false`) | not implemented (`false`) | — | — | — |
| `maxTextLength` | 4096 | 8000 (card body also clipped to 30 KB) | — | — | — |
| `markdown` | `none` (no `parse_mode`; `**x**` is literal) | `subset` (card `markdown` tag) | — | — | — |

Streaming drafts degrade automatically: card update when the platform can, otherwise edit-in-place, otherwise buffered chunked sends. Stream updates are latest-wins coalesced (one in-flight + one pending) and skip unchanged text.

`Button` is `{ id, label, style?, value? }` on every platform. Telegram callback_data is limited to 64 **bytes**; longer payloads (including CJK ids) are hashed (`h:<16 hex>`) into a bounded LRU table (256). After a process restart the table is empty, so those clicks arrive as unresolved `actionId: "h:…"`.

## Roadmap

- **Week 1** — L1 core + Telegram + Feishu, contract tests against recorded fixtures.
- **Week 2 (this PR)** — L2 session (`@imwire/session`) + L3 pi driver (`@imwire/agent-pi`). Pairing, one conversation per person, follow-the-user streaming and approvals. The IM layer does not import the session package.
- **Week 3** — DingTalk Stream, WeCom long connection, Slack Socket Mode, and a Python client via `imwire serve` (JSON-RPC).

### Session commands and routing

| Command | Effect |
|---|---|
| `/pair` | Linked sender gets a 6-digit code (TTL 10 min, single use, rate-limited). Send the code to the bot from a new IM to link that account. |
| `/topic name` | Create or switch to a named topic. Applies on every linked IM. `/topic default` returns to the personal default. |
| `/topics` | List topics; the active one is marked `→`. |

Unpaired senders get a short instruction and nothing else. Owner allowlist is `IMWIRE_ALLOWLIST=platform:accountId:userId[,name]`.

Replies go to the IM that triggered the turn. Proactive messages go to the person's most recently active IM. Concurrent inbound is a single ordered queue per conversation. If the user speaks from IM B while a reply is streaming on IM A, A is finalized with `→ continued in B`, the already-generated text is replayed on B, and the stream continues there. Pending approval cards follow the user; the first click wins and the other cards become `_handled_`.

## 中文

imwire 是给 agent 用的独立 IM SDK：一套 Adapter 接口接飞书 / 钉钉 / 企微 / Telegram / Slack，默认长连接，不需要公网 IP。面向 agent 的能力（流式回复、审批按钮、配对）是一等公民。L2 `@imwire/session` 让一个人在所有 IM 上共享一段对话；IM 层不依赖它，可以单独引用。`/pair` 出 6 位码，在新 IM 发给 bot 即完成绑定。群聊单独成会话，不会并进个人对话。中途换 IM 时，原侧草稿会标「continued in …」，已生成的文字在新侧续上。

核心包名是 `@imwire/core`（`imwire` 留给以后的 CLI）。包是 ESM-only。

```bash
pnpm install && pnpm build
cp .env.example .env   # echo 用 node --env-file 加载
# 在 .env 里填 TELEGRAM_BOT_TOKEN 或 FEISHU_APP_ID / FEISHU_APP_SECRET
pnpm --filter @imwire/example-echo start
```

飞书 `send()` 一律发交互卡片：飞书的 `PATCH` 只能改卡片，不能改普通文本（`editScope:"cards"`）。卡片用 Card JSON 2.0（按钮直接放在 `body.elements`，带 `behaviors.callback`，不要 `tag:action` / `wide_screen_mode`）。`element_id` 必须字母开头、≤20 字符、卡内唯一。

## Develop

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

CI (GitHub Actions) runs the same three commands on Node 20 and Node 22. Adapter tests use recorded fixtures and a fake transport. Session / pi tests use `FakeAdapter` plus pi-ai `fauxProvider` — no live Telegram, Feishu, or model network calls. On Node 20, `better-sqlite3` must compile (or install a prebuild); without a compiler the session package throws a clear error instead of `ERR_UNKNOWN_BUILTIN_MODULE`.

```bash
# acceptance demo (fake adapters): ask on TG, switch to Feishu mid-stream, approve on Feishu
pnpm exec vitest run packages/session/tests/demo.test.ts
```
