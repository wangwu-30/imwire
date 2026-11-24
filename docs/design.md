# imwire design

## Positioning

**imwire connects agents to the IMs people already use. It does not build another IM.** Its edge is one identity and one continuous conversation across every IM.

- **Existing IMs first.** Telegram, Feishu, Slack, DingTalk, WeCom and others are the primary surfaces. imwire adapts to them; it does not ask people to install a new chat app.
- **Self-built endpoints are supplementary adapters.** Voice hardware or a passkey web confirmation page plug in through the same adapter interface, filling gaps the IMs cannot cover.
- **Differentiator: one person, one conversation, any IM.** Identity is person-centric. The model is *person → topic → message*: switch from Telegram to Feishu and the same person continues the same topic.
- **Bidirectional.** People reach agents through the gateway; agents reach people through the a2h hub and MCP. Both directions share the same adapters, identity and session layer.
- **Boundaries come from permissions and data isolation, not product lines.** Personal and team use run on the same imwire.

**Non-goal:** another chat app.

## Scope (2026-11)

Decided 2026-11-24: **imwire is maintained as L1, an IM wiring SDK.**

- **Maintained:** `@imwire/core` and the platform adapters. Feishu and Telegram are live-verified; DingTalk, WeCom and Slack are fixture-only.
- **Frozen:** `@imwire/session` (L2), `@imwire/agent-pi` (L3) and `imwire serve` (hub, a2h, outbox bridge). Security and bug fixes only; no new features and no refactor. They keep working as they do today.
- **Why:** sessions, approvals, receipts and delivery are what a work engine already owns. Building a second session engine inside the IM layer guarantees two diverging sources of truth. L1 never imports L2, so consumers can take L1 alone.
- **Cross-IM person is kept, not removed.** The person-centric differentiator above lives in the frozen L2. When a second IM or a second consumer actually needs cross-IM identity, extract only the identity slice (person / identity / pairing / TOTP, no conversation state) as a small package. Not before.

### Known L1 gaps (next work)

Feishu streaming in `packages/feishu/src/adapter.ts`:

1. `finishCard` clips the final text to about 25.9 KB (`clipToBytes`); anything longer is silently dropped. Overflow should go to extra cards or an attachment instead.
2. The CardKit `sequence` lives only in memory (`seq: 0` per card), so a restarted process cannot keep updating an open card. Needs an injectable sequence store.
3. Finalize is three calls (content, buttons, `streaming_mode=false`); a crash in between leaves the card streaming. A single `card.update` with `streaming_mode: false` closes it atomically.
4. Message create/reply sends no `uuid`, so retries can duplicate messages.
5. No outbound file upload (`media.file: false`).
6. Card markdown lacks the CJK bold-punctuation fix.

Packaging: nothing is on npm yet. `exports` point at the git-ignored `dist/` and `@imwire/feishu` depends on `@imwire/core` via `workspace:*`, so a consumer cannot import L1 straight from git without building it.
