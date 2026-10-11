# 把 Telegram / 飞书机器人接到 pi

这份文档给**你自己的 coding agent**照着执行。只写本仓库代码里真实存在的命令、环境变量和报错原文。不要发明额外的配置项。

目标：用 imwire 把即时通讯机器人接到本地 agent（`@imwire/example-assistant` 走 session + pi；`imwire serve` 把适配器暴露成 JSON-RPC，由你自己的进程驱动）。

## 0. 先选一条路径

| 路径 | 代码入口 | 会启动谁 | 要不要 session / pi |
|---|---|---|---|
| **A. echo** | `pnpm --filter @imwire/example-echo start` | 环境里**有凭证的所有**适配器（Telegram / 飞书 / 钉钉 / 企微 / Slack） | 否。只回显 + Approve/Deny |
| **B. assistant** | `pnpm --filter @imwire/example-assistant start` | **仅** Telegram 和/或飞书 | 是。`@imwire/session` + `@imwire/agent-pi` |
| **C. serve** | `imwire serve` / `pnpm serve` | **只有** `IMWIRE_ADAPTERS` 或 `--adapter` 点名的适配器。环境里多出来的 token **不会**自动开 bot | 否。JSON-RPC，见 [`docs/protocol.md`](docs/protocol.md) |

三条路径都是 env-only，不要把 token 写进仓库。

## 1. 机器准备

```bash
# Node >= 20（assistant 的 SQLite：Node 20 需要能编译 better-sqlite3，或装预编译包；Node 22+ 可用 node:sqlite。better-sqlite3 是可选依赖，装不上不会让 pnpm install 失败）
pnpm install
pnpm build
cp .env.example .env
```

echo / assistant 的 `start` 脚本是：

```text
node --env-file=../../.env dist/index.js
```

**必须先有 `.env` 文件**（哪怕是空的）。Node ≥ 20.6 在文件不存在时会直接拒绝启动。也可以自己 `export` 同名变量，然后改用 `node dist/index.js`。

根目录等价命令：`pnpm example:echo`、`pnpm example:assistant`、`pnpm serve`。

## 2. 各 IM 要申请什么、填什么

下面「必填 / 可选」只列出**代码会读的名字**。括号里的是同一项的别名（代码用 `??` 接受）。

### Telegram（长轮询 `getUpdates`）

1. 打开 [@BotFather](https://t.me/BotFather)，`/newbot`，拿到 `123456:ABC...`。
2. 给 bot 发一条私聊，记下你的 user id（assistant 的 allowlist 要用）。
3. 写入 `.env`：

```bash
TELEGRAM_BOT_TOKEN=123456:ABC...
# 推荐显式设一个稳定 id。assistant 的 allowlist 必须写同一个值。
TELEGRAM_ACCOUNT_ID=mybot
```

不设、或设成 `telegram` 时，`adapter.start()` 里 `getMe` 成功后会把 `accountId` 改成 **bot 数字 id**（等于 token 冒号前那串，也等于 `getMe.id`）。已经设成别的值（例如 `mybot`）时 **不会**改。

群里使用时注意 privacy mode：在 [@BotFather](https://t.me/BotFather) 对这个 bot 发 `/setprivacy`。默认开启时 bot 只能看到 `/command@bot` 命令和回复它的消息。把 bot 设为群管理员后可以收到全部消息。改完 privacy 必须把 bot 从群里移除再加回来才会生效。

echo / assistant **另外**接受 `IMWIRE_TELEGRAM_BOT_TOKEN`（与 `TELEGRAM_BOT_TOKEN` 二选一）。`imwire serve` **只认** `TELEGRAM_BOT_TOKEN`。

能力：`streaming: edit`（`editMessageText`），inline keyboard，`sendChatAction` typing。没有 `parse_mode`，`**粗体**` 就是字面量。

### 飞书 / Lark（官方 SDK WebSocket 长连接）

1. [飞书开放平台](https://open.feishu.cn/app) 或 [Lark](https://open.larksuite.com/app) 创建企业自建应用。
2. 打开「机器人」能力；在权限管理里开通官方 scope：
   - `im:message`、`im:message:send_as_bot`（发消息）
   - `im:message.p2p_msg:readonly`（收私聊）
   - `im:message.group_at_msg:readonly`（群里 @机器人）
   - `cardkit:card:write`（流式卡片；没有时 `startCard` 会退回普通 PATCH 更新）
   只开 `im:message` **不会**投递 `im.message.receive_v1` 的私聊 / 群 @ 事件（见[接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)）。
3. 订阅事件 `im.message.receive_v1`、`card.action.trigger`（以及你要用的 reaction 事件）。
4. 拿到 App ID / App Secret。长连接不需要公网回调 URL。
5. 写入 `.env`：

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
# feishu（默认，open.feishu.cn）或 lark（open.larksuite.com）
FEISHU_DOMAIN=feishu
```

`accountId` 默认等于 `FEISHU_APP_ID`。`send()` 一律发 Card JSON 2.0 交互卡片（`editScope: "cards"`，飞书 `PATCH` 不能改普通文本）。

### 钉钉 Stream（本仓库**没有**在真实组织上跑过）

1. [钉钉开放平台](https://open-dev.dingtalk.com) 创建应用，打开机器人，使用 Stream 模式。
2. 写入 `.env`：

```bash
DINGTALK_CLIENT_ID=   # 别名 DINGTALK_APP_KEY
DINGTALK_CLIENT_SECRET=  # 别名 DINGTALK_APP_SECRET
# 可选
# DINGTALK_ACCOUNT_ID=          # 默认等于 clientId
# DINGTALK_ROBOT_CODE=          # 默认等于 clientId
# DINGTALK_CARD_TEMPLATE_ID=    # 不设则 streaming=buffer、buttons=false
# DINGTALK_CARD_STREAM_KEY=content
```

没有 `DINGTALK_CARD_TEMPLATE_ID` 时，适配器不会走 AI 卡片 / 流式 PUT / 按钮。

### 企业微信智能机器人（本仓库**没有**在真实企业上跑过）

1. 在[企业微信开发者文档 · 智能机器人](https://developer.work.weixin.qq.com/document/path/101463) 创建机器人。必须先开启 **API 模式** 并选择 **长连接**，才能拿到 Secret。
2. 写入 `.env`：

```bash
WECOM_BOT_ID=          # 别名 WECOM_AIBOT_ID
WECOM_SECRET=          # 别名 WECOM_AIBOT_SECRET
# 可选
# WECOM_ACCOUNT_ID=            # 默认等于 botId
# WECOM_REPLY_STORE=./wecom-reply.json   # 进程重启后仍能在 24h 窗口内回复
# WECOM_REPLY_MAX_BYTES=1048576
```

`proactiveSend=false`：出站只走 `aibot_respond_msg`，必须先有入站 `req_id`。没有入站就发会得到：`wecom: no req_id for <chatId> (reply-only; wait for inbound)`。进程重启若没设 `WECOM_REPLY_STORE`，要等到下一条入站才能再回。

### Slack Socket Mode（本仓库**没有**在真实 workspace 上跑过）

1. [Slack API](https://api.slack.com/apps) 创建应用。打开 Socket Mode。
2. Bot Token（`xoxb-`）需要 bot 权限 `chat:write`、`im:history`。适配器会加 reaction，还要 `reactions:write`。
3. Event Subscriptions 必须订阅 `message.im`（私聊）。群里 @bot 还要订阅 `app_mention` 事件，并开通 `app_mentions:read`。
4. 打开 Interactivity（按钮要用）；App Home 打开 Messages tab。
5. App-level Token（`xapp-`，scope 含 `connections:write`）。
6. 写入 `.env`：

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
# 可选。默认 accountId 是 "slack"
# SLACK_ACCOUNT_ID=
```

`imwire serve` 开 Slack 时两个 token 都要有。

## 3. 路径 A — echo（最快确认凭证）

最小 `.env`（只开 Telegram）：

```bash
TELEGRAM_BOT_TOKEN=123456:ABC...
```

或只开飞书：

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_DOMAIN=feishu
```

```bash
pnpm build
pnpm --filter @imwire/example-echo start
```

**接通了的样子：** stderr/stdout 出现 `telegram adapter enabled` 或 `feishu adapter enabled (feishu)`；你给 bot 发一句话，进程打印规范化后的 inbound JSON，消息被流式回显，末尾带 Approve / Deny。点按钮会再发 `Approved.` 或 `Recorded: <actionId>`。

一个凭证都没有时，进程打印 `imwire echo example` 帮助并 `exitCode = 1`。

## 4. 路径 B — assistant（接到 pi）

assistant **只接 Telegram 和飞书**（`examples/assistant/src/index.ts`）。钉钉 / 企微 / Slack 请用 echo 或 `imwire serve`。

### 4.1 最小配置

```bash
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_ACCOUNT_ID=mybot
# 和/或
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx

# accountId 必须和 adapter 运行时的值完全一致（gateway 三段全等）：
#   推荐：TELEGRAM_ACCOUNT_ID=mybot，allowlist 写 telegram:mybot:<uid>
#   另一种：不设 TELEGRAM_ACCOUNT_ID（或设成 telegram）。start()/getMe 后
#   accountId 变成 bot 数字 id，allowlist 写 telegram:<botId>:<uid>。
#   botId 就是 token 冒号前那串数字（也等于 getMe 的 id）。
#   飞书默认等于 FEISHU_APP_ID
# 格式：platform:accountId:userId 或 platform:accountId:userId,Name
# 分隔符：逗号 / 分号 / 换行。下一项若不含冒号，当作 Name。
IMWIRE_ALLOWLIST=telegram:mybot:111111111,Owner

# 可选
# IMWIRE_DB=./imwire.sqlite
# IMWIRE_SYSTEM_PROMPT=You are a helpful assistant.
```

不要写 `IMWIRE_ALLOWLIST=telegram:telegram:111111111,Owner`。真实 Telegram 上 `start()` 会把 `"telegram"` 改成 bot 数字 id，三段对不上，主人会一直收到 `This bot is private…`。

Telegram 的 user id 必须是 Bot API 里的数字 id（`from.id`），不是 @username。飞书是 `open_id`。

### 4.2 真模型还是本地假模型

`examples/assistant` 在下面任一条件为真时走真 pi：

- `IMWIRE_USE_PI=1`，或
- 存在 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`

```bash
IMWIRE_USE_PI=1
IMWIRE_PI_PROVIDER=openai          # 不设则：只有 ANTHROPIC_API_KEY 时用 anthropic，否则 openai
IMWIRE_PI_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...
# 或 ANTHROPIC_API_KEY=
```

`IMWIRE_PI_MODEL` 必须在 pi 内置模型清单里，否则回复 `Unknown model …`。新发布或预览版模型（例如 `minimax-cn` 的 `MiniMax-M3.1-Flash-Preview`）还没进清单时，可以打开：

```bash
IMWIRE_PI_ALLOW_UNLISTED_MODEL=1   # 默认关。provider 必须认识；借用同 provider 第一个模型的接口配置，只把模型 id 换掉
```

打开后启动日志会打一行 `pi: <provider>/<id> is not in the built-in catalog; using <base>'s settings`。这类模型不强制关 thinking（有些预览模型会拒绝 `thinking.type=disabled`），由 provider 默认决定。模型 id 拼错时，报错会变成 provider 返回的 4xx，而不是 `Unknown model`。

否则用内置 fake provider，回复会带 `(offline demo)`。

### 4.3 启动与验证

```bash
pnpm build
pnpm --filter @imwire/example-assistant start
```

按顺序做：

1. 用 allowlist 里的账号私聊 bot。应收到：`Welcome. You are the owner. Send /pair to link another IM.`
2. 发送 `/pair`。应收到：`Pairing code: <8 位数字> (valid 10 minutes, one use). Send it to this bot from the new IM.`
3. 在**另一个**已启用的 IM 上，把这 8 位数字原样发给 bot。应收到：`Linked. You share one conversation across IMs.` 原 IM 会收到 `Linked <platform> account <userId>.`
4. 之后在任一已绑定 IM 上说话，应是**同一段**对话。`/topic travel` 再 `/topics`，两个 IM 都应看到 `→ travel`。
5. 未绑定的人只会收到：`This bot is private. Ask someone already linked to send /pair, then send the 8-digit code here.` 不会进模型。

群聊单独成会话，不会并进个人对话；未绑定成员 @bot 会收到上面那句，同一群 24 小时内只说一次。

## 5. 路径 C — `imwire serve`

**token 单独存在不会启动任何 bot。** 必须显式点名：

```bash
IMWIRE_ADAPTERS=telegram,feishu
# 然后：
pnpm serve
# 或构建后：
imwire serve
# 或：
imwire serve --adapter telegram --adapter feishu
```

合法名字只有：`telegram` `feishu` `dingtalk` `wecom` `slack`（逗号 / 分号 / 空白分隔）。

WebSocket（可选）：

```bash
imwire serve --adapter telegram --ws
# 默认 127.0.0.1:8765。token = IMWIRE_WS_TOKEN 或 --ws-token；都不设则生成并打印到 stderr：
#   imwire serve ws token …
# 客户端只能带 Authorization: Bearer <token>（query / 子协议会被拒）。
# 非 loopback --ws-host 必须同时有 --ws-allow-remote 和 token。
```

**接通了的样子：** stderr 出现 `imwire serve telegram:<accountId>, feishu:<accountId>`。stdio 上发一行：

```json
{"jsonrpc":"2.0","id":1,"method":"hello","params":{}}
```

应返回 `protocolVersion: "1.0"` 和 `platforms[]`。方法列表见 [`docs/protocol.md`](docs/protocol.md)。Python 薄客户端：`python/examples/echo.py`（需要 `imwire` 在 `PATH`，或给 `ImwireClient` 传 `command=`）。

## 6. session 命令（仅 assistant / 你自己挂了 `@imwire/session` 时）

| 你发给 bot 的文本 | 代码里的效果 |
|---|---|
| `/pair` | 已绑定发送者拿到 8 位码（TTL 10 分钟、一次性、同一 identity 10 分钟最多 5 个） |
| 未绑定账号发送 8 位数字 | 绑定到出码的那个人；错码 5 次 / 10 分钟锁定 |
| `/stop` 或 `/cancel` | 取消进行中的 turn 和等待中的审批 |
| `/topic name` 或 `/topic new name` | 创建或切到命名话题；所有已绑定 IM 生效 |
| `/topic default` 或 `/topic` + `default` | 回到个人默认话题 |
| `/topics` 或 `/topic` / `/topic list` | 列出话题，当前行前缀 `→` |

## 7. 常见报错（原文 → 原因 / 做法）

| 你看到的原文 | 做法 |
|---|---|
| `imwire serve: set IMWIRE_ADAPTERS=telegram,feishu or pass --adapter telegram (tokens alone are ignored).` | serve 必须点名适配器 |
| `unknown adapter <name>; expected telegram\|feishu\|dingtalk\|wecom\|slack` | 名字拼错 |
| `telegram enabled but TELEGRAM_BOT_TOKEN is empty` | serve 开了 telegram 但没 token（serve 不认 `IMWIRE_TELEGRAM_BOT_TOKEN`） |
| `feishu enabled but FEISHU_APP_ID / FEISHU_APP_SECRET missing` | 两个都要有 |
| `dingtalk enabled but DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET missing` | 或改用 `DINGTALK_APP_KEY` / `DINGTALK_APP_SECRET` |
| `wecom enabled but WECOM_BOT_ID / WECOM_SECRET missing` | 或改用 `WECOM_AIBOT_ID` / `WECOM_AIBOT_SECRET` |
| `slack enabled but SLACK_BOT_TOKEN / SLACK_APP_TOKEN missing` | Socket Mode 两个都要 |
| `imwire serve: non-loopback --ws-host requires --ws-allow-remote and a token` | 绑 `0.0.0.0` 时补齐 |
| `unknown command <cmd>. Try: imwire serve` | CLI 只有 `serve`（以及 `help` / `--help` / `-h`） |
| `--env-file` 找不到 `.env` | `cp .env.example .env` |
| `This bot is private. Ask someone already linked to send /pair, then send the 8-digit code here.` | 发送者不在 allowlist，也不是有效配对码 |
| `Too many pairing codes. Try again later.` | 同一 identity 10 分钟内 `/pair` 超过 5 次 |
| `Too many pairing attempts. Try again later.` | 同一发送者 10 分钟内错码 5 次 |
| `Welcome. You are the owner. Send /pair to link another IM.` | 正常。allowlist 命中，还没 `/pair` |
| `feishu websocket failed (bad credentials or exhausted reconnect)` | App ID / Secret / 域名不对，或长连接一直失败 |
| Telegram HTTP 409（webhook 冲突） | 适配器会 `deleteWebhook` 一次再重试 `getUpdates`。不要同时开 Bot API webhook |
| `wecom: no req_id for <chatId> (reply-only; wait for inbound)` | 企微不能主动发；等用户先说话，或设 `WECOM_REPLY_STORE` 以免重启丢窗口 |
| `wecom disconnected_event: another instance took over` | 同一个机器人另有实例抢了长连接 |
| `slack link_disabled` | Slack 应用关了 Socket Mode / 链接被禁用，适配器不再重连 |
| `dingtalk AI card requires cardTemplateId` | 走了卡片发送但没设 `DINGTALK_CARD_TEMPLATE_ID` |
| `slack socket: apps.connections.open returned no url` | `SLACK_APP_TOKEN` 无效或没有 `connections:write` |
| assistant 启动打印 `Set env vars` 并退出 | Telegram token 和飞书 id+secret 都没配 |

## 8. 不要做的事

- 不要给 `imwire serve` 只塞 token、不写 `IMWIRE_ADAPTERS` / `--adapter`。
- 不要假设 echo 的 `IMWIRE_TELEGRAM_BOT_TOKEN` 对 serve 生效。
- 不要假设 assistant 会启动钉钉 / 企微 / Slack。
- 不要把 allowlist 写成 `telegram:telegram:<uid>`。`TELEGRAM_ACCOUNT_ID` 不设或等于 `telegram` 时，`start()` 里 `getMe` 会把适配器的 `accountId` 改成 bot 数字 id，三段对不上就永远匹配不到主人。推荐 `TELEGRAM_ACCOUNT_ID=mybot` + `telegram:mybot:<uid>`；或者 allowlist 用 token 冒号前那串数字作 accountId。
- 不要在飞书卡片里用 `tag:action` 或 `wide_screen_mode`（本仓库的卡片构造器也不会这么发）。

## 9. 做完怎么自检（给 agent 的验收清单）

1. `pnpm typecheck` 与 `pnpm test` 在本机通过（CI 同样跑这两项，外加 `pnpm lint` 和 Python unittest）。
2. echo：至少一个 IM 能回显并出现 Approve / Deny。
3. assistant：allowlist 用户收到 Welcome；`/pair` 出 8 位码；另一 IM 发送该码后两边共享对话。
4. serve：stderr 打出已启用的 `platform:accountId`；`hello` 返回这些 platform。
