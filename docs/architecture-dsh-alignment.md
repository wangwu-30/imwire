# 对照 DeepSeek dsh-superagent-prototype 的架构对齐

> 2026-11-02（Asia/Shanghai）· 一页纸 · 只写设计，不改仓库代码  
> 对照对象：[dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（Source→Trigger→Eval→Ticket/Mandate→Assignment→Executor；人不是域概念；跨 Source 身份映射被拒绝）  
> imwire 定位：打通现有 IM；差异化是跨 IM 同一身份；非目标是又一个聊天 App / 又一个单仓 coding agent。

## 0. 结论先行

1. **硬约束：必须保留跨 IM Person**（配对码 + TOTP + 24h 冷静期）。dsh 刻意不做跨 Source 身份映射；那是他们的取舍，**不是我们的取舍**——砍掉 Person 等于砍掉开源差异化。
2. **边界一句：imwire = IM wiring；dsh 类系统 = work engine。** 不要在 L1（适配层）重建 Ticket / Eval。
3. **可借鉴**：注意力经济（少说话）、Ticket/Mandate 作为授权单位、Outbox、面板只展示「等人」、文档少概念。
4. **不照搬**：砍跨源身份、绑死 DeepSeek Harness、证据未齐前堆 Eval 复杂度、做成又一个单仓 coding agent。
5. **落地顺序**：P0 真机证据（#19 fake→#17→跨 IM）→ P0 本文档进仓库 `docs/` → P1 卡片字段+MCP → P2 TaskDriver(Codex)。

## 1. imwire 现有三层（保持）

| 层 | 职责 | 现状要点 |
|---|---|---|
| L1 IM 适配 | Telegram / 飞书 / WeCom… 入站出站、capabilities | 长连接/轮询；`proactiveSend` 等能力声明 |
| L2 跨 IM 身份与会话 | Person ↔ 多 surface；话题 `default` / `agent:<name>` / `task:<id>` | 配对码、TOTP、冷静期；消息带 `[via 平台]` |
| L3 AgentDriver + a2h | 会话型（pi/Claude/Codex app-server）与任务型（submit/status）；找人审批走 a2h | DriverContext 含 person、topic、a2h；工具审批全部经 a2h |

Hub 按 `kind` 路由；上下文在会话层，不在 driver。Harness 可替换——这与 dsh 的「Executor 可插拔」同构，但我们不绑死某一家。

## 2. Source-on-imwire 边界（写死）

dsh 的 Source 落在 imwire 上时，只做接线，不做工作引擎：

| dsh 概念 | 落在 imwire 的何处 | 说明 |
|---|---|---|
| Inbound → Trigger | L1 adapter 入站事件 → hub 归一化触发 | 适配层只产出规范化事件，不评判「该不该做」 |
| Adapter.send / draft → Channel | L1 出站 / 草稿投递 | Channel = 把已决定的话送到某个 surface |
| capabilities ↔ health | adapter 能力声明 ↔ 健康探测 | 如 `proactiveSend`；不可用则跳过或进 dead，不在 L1 重试业务语义 |

**禁止**：在 L1 重建 Ticket / Eval / Mandate 判定。授权与「要不要打扰人」属于 L2/L3（a2h、Driver、未来对齐 Mandate 的策略），或外挂 work engine。imwire 提供 Person、话题、出站通道与审批句柄；**工作编排留给 engine**。

## 3. 概念映射表

| dsh | imwire | 对齐说明 |
|---|---|---|
| Mandate | a2h grant / 审批（含 risk、TOTP `verified`） | 授权单位：对人发起的许可；critical 绑定动作对象哈希 |
| Ticket | topic / `task:<id>` | 工作焦点单位：会话挂话题，任务挂 `task:<id>` |
| Source / Trigger | IM adapter 入站事件 | 见 §2；Trigger 归一化后进 hub |
| Assignment | TaskDriver `submit` / `status` | 任务型 driver 承接；会话型不硬塞 |
| Outbox | imwire #18 outbox bridge | maildir 式投递；at-least-once + 幂等；默认关、按需开 |
| （无）跨 Source 人 | **Person**（配对码、TOTP、冷静期） | **dsh 拒绝映射；imwire 必须保留** |

面板侧对齐 dsh「只展示等人」：主动打扰走 outbox / a2h 卡片；闲聊不刷屏。

## 4. 该借鉴 / 不该照搬

**借鉴**

- 注意力经济：少说话；需要人时才出卡；面板偏「等人」队列。
- Ticket / Mandate 作清晰授权与焦点单位 → 映射到 topic/task 与 a2h，而不是另造一套名词淹没文档。
- Outbox 解耦「产生通知」与「送达 IM」（#18 已合，真机各推过 1 条）。
- 文档少概念：对外只讲「跨 IM 同一身份 + 可替换 agent + 找人审批」。

**不照搬**

- 砍跨源身份 / 把人从域里拿掉 → **否决**。
- 绑死 DeepSeek Harness → harness 可替换（pi → Codex / Claude / OpenClaw…）。
- 证据未齐前堆 Eval（自动裁判、复杂评分）→ P0 先真机证据包。
- 做成又一个单仓 coding agent / 又一个聊天 App → 违反仓库定位。

## 5. 建议落地顺序

| 优先级 | 项 | 验收口径 |
|---|---|---|
| **P0** | 真机证据：#19 fake 启用 → #17 飞书复验 → Telegram+飞书跨 IM 证据包 | 证据进 `/workspace/imwire-evidence/`；未齐前对外不说「换 IM 还记得我」 |
| **P0** | 本文档进仓库 `docs/architecture-dsh-alignment.md` | PR 仅文档；不改运行时行为 |
| **P1** | a2h 卡片字段 + MCP/skill | 字段草案已有；真发与 MCP 在证据包之后 |
| **P2** | TaskDriver(Codex) | Assignment ↔ submit/status；等 P0/P1 |

真模型（OpenAI/Anthropic）启用与生产 #19 真 key **等佳恒另说**；当前可用 fake 验通路。

## 6. 一句话给团队

> imwire 继续做 **IM wiring + 跨 IM Person + a2h**；把 dsh 的 Mandate/Ticket/Outbox/少说话吸收为对齐词汇与产品纪律；**绝不在适配层重做 work engine，也绝不砍 Person。**
