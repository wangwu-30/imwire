# Changelog

## Unreleased

### Outbox delivery bridge

- Added an opt-in `outboxBridge` to `imwire serve --config`: atomic file claiming,
  SQLite delivery deduplication, bounded durable retries, crash recovery and atomic
  `chat-results` receipts. See [the configuration and file format](docs/outbox-bridge.md).
- Added `SessionGateway.sendProactiveTo()` with explicit delivered/retrying/dead results,
  configurable Telegram → Feishu preference, online/capability checks, and WeCom exclusion.
- Fixed legacy `sendProactive()` silently dropping messages without a surface: it now
  delegates, returns a result and warns on failure.
- Added literal text blocks for Telegram and Feishu so untrusted outbox text bypasses
  Markdown rendering; bridge retries are not multiplied by adapter retries.
- `delivered` means IM delivery acknowledgment, never a2h `received` or human acknowledgment.

### a2h: agent-protocol v0 (PR 4)

- Event log rows written before v0 envelopes existed have no stored event id. Their id is derived as
  `evt_legacy_<hub_id>_<seq>` (`hub_id` is the per-database id in `hub_meta`, `seq` the log position),
  and their `integrity.digest` is computed at read time from the reconstructed `data`. The log is
  append-only, so these rows are never backfilled.
- `grant` is now mandatory on `a2h.approve` / `a2h.ask`. Existing requests are migrated to
  `{"kind":"once"}` when the database is opened. In-process session-layer calls that omit `grant`
  are also defaulted to `once` and log a `console.warn` naming the request id and agent.
- The three per-reader cursors of v0 §4.3 (`captured` / `handled` / `published`) are not
  implemented yet; readers have a single `seq` cursor.
