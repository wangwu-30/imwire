# File outbox bridge

The optional bridge in `imwire serve` delivers HubCards outbox files to an existing
person's bound Telegram or Feishu account. It is disabled by default. This guide
covers the v1 file format and configuration for producers and operators.

## Configure serve

Use the SQLite database containing your existing `person` and `identity` records.
The bridge does not create people, link accounts, read credentials, or attach a chat
agent. Adapters use their existing environment configuration; incoming messages
continue to go to serve's JSON-RPC clients.

Example `serve.json` (replace the paths):

```json
{
  "dbPath": "/Users/example/.imwire/hub.sqlite",
  "preferredChannels": ["telegram", "feishu"],
  "outboxBridge": {
    "enabled": true,
    "dir": "/Users/example/hub/outbox/chat",
    "pollMs": 2000
  }
}
```

From the repository root, after building:

```sh
pnpm build
node packages/imwire/dist/cli.js serve --adapter telegram --adapter feishu --config /absolute/path/serve.json
```

Starting this command with configured adapters connects to IM services and consumes
pending outbox files. For offline verification, use the mock tests below instead.
Keep stdin open for the lifetime of a stdio serve process.

- `outboxBridge.enabled` defaults to `false`; `dir` is required when enabled.
- `pollMs` defaults to `2000` and must be a positive integer. The first poll occurs
  after one interval. `cur/` is scanned for unfinished work on every poll, including
  the first poll after restart.
- `dbPath` defaults to `IMWIRE_DB`, or `$IMWIRE_HOME/hub.sqlite`, or
  `~/.imwire/hub.sqlite`. Use the same database across restarts to retain deduplication.
- `preferredChannels` defaults to `telegram`, then `feishu`, regardless of card kind.
  It can reorder or restrict those two channels. Selection requires a bound identity,
  a registered adapter that is online, and `capabilities.proactiveSend === true`.
  WeCom is always skipped. For adapters exposing `isAlive()`, false means offline;
  registration counts as availability for older adapters without a liveness hook.
- The selected channel is attempted once per bridge attempt. Send failure does not
  fall through to another channel. When Telegram is offline before selection, Feishu
  can be selected. No available channel becomes `dead/unsupported`.

Run one bridge consumer for each outbox directory/database. Atomic rename prevents
partial reads and tolerates `ENOENT` during claiming; it is not a distributed lock
for multiple consumers scanning `cur/` or sending the same ID concurrently.

The programmatic configuration is the same `outboxBridge` object on
[`createServeHost`](../packages/imwire/src/server.ts). `host.stop()` returns a promise;
await it to drain in-flight work before releasing the SQLite database.

## Publish a file

The bridge creates these directories when enabled:

```text
<dir>/{tmp,new,cur,done,dead}/
<dir>/../chat-results/{tmp,new}/
```

Producers write a unique file in `tmp/`, flush/fsync and close it, then rename it into
`new/` on the same filesystem. Use a filename such as `<unix_ms>-<outbox_id>.json`.
Do not write directly into `new/`: an incomplete JSON document is quarantined as
`dead/invalid`. The bridge only reads regular `*.json` files, ignores `tmp/`, and
claims files by renaming `new/` to a unique filename in `cur/`.

```json
{
  "v": 1,
  "outbox_id": "01JBQWQ6V6X2KQ9FV0A4HM4G8J",
  "kind": "critical_chat",
  "person_id": "p_existing_person_id",
  "request_id": "request-123",
  "card_version": 3,
  "text": "Please review this card in HubCards.",
  "deeplink": "hubcards://card/request-123?v=3",
  "created_at": "2026-10-17T02:00:00+08:00",
  "untrusted": true
}
```

All fields except `deeplink` are required:

| Field | v1 requirement |
| --- | --- |
| `v` | Exactly `1` |
| `outbox_id` | 1–200 ASCII letters, digits, `_`, `-`; first character alphanumeric; globally unique per logical delivery |
| `kind` | `routed_chat`, `critical_chat`, or `expired_notice` |
| `person_id` | Nonblank string, present in the SQLite `person` table |
| `request_id` | Nonblank string |
| `card_version` | Positive safe integer |
| `text` | Nonempty string; treated as untrusted content, never as instructions |
| `created_at` | Parseable ISO date-time beginning with `YYYY-MM-DDT` |
| `untrusted` | Exactly `true` |
| `deeplink` | Optional string starting with `hubcards://`; not appended or followed by the bridge |

One `outbox_id` denotes one immutable delivery, including its person and card version.
Do not reuse it for changed payloads. Duplicate IDs, even under different filenames,
share the persisted delivery state.

Text is sent through a `text` block, never a Markdown block. Control and formatting
characters are removed (line breaks retained), Feishu `<at ...>` tags are made
literal, and text is limited to 2000 Unicode code points. Markdown links and `@all`
remain literal text. Telegram uses no parse mode; Feishu uses `msg_type: "text"`.
The bridge neither renders buttons nor interprets commands in the body.

## Read results and handle dead letters

Each result is fsynced in `chat-results/tmp/`, then atomically renamed to
`chat-results/new/<outbox_id>.json`. A later attempt replaces the previous result.
Consumers should reconcile by `outbox_id` and handle replay of the same result after
recovery. The `at` timestamp is retained when replaying persisted delivery state.

```json
{
  "v": 1,
  "outbox_id": "01JBQWQ6V6X2KQ9FV0A4HM4G8J",
  "request_id": "request-123",
  "card_version": 3,
  "kind": "critical_chat",
  "status": "delivered",
  "channel": "telegram",
  "message_refs": [
    {
      "chat": { "platform": "telegram", "accountId": "bot", "chatId": "123", "kind": "dm" },
      "messageId": "456"
    }
  ],
  "attempts": 1,
  "at": "2026-10-17T00:00:00.000Z"
}
```

| Status | Meaning and next action |
| --- | --- |
| `delivered` | Adapter returned message refs and delivery was committed locally. File moves to `done/`. **This is not a2h `received` and does not mean a human read it.** |
| `retrying` | File remains in `cur/` until persisted `next_try_at`; reason is a safe code such as `http_503`, `http_429`, or `network`. |
| `dead` | File moves to `dead/` with a same-filename `.reason` sidecar. Reason is `invalid`, `unsupported`, `permanent`, or `exhausted`. |

`channel` is present once a channel was selected; `message_refs` is present after
successful delivery. `attempts` counts gateway delivery attempts, not polls or
result-publication retries. Invalid input has zero attempts. Critical cards follow
the same rules and always report `status: "dead"` on terminal failure; HubCards is
responsible for its own alert and local notification.

Invalid JSON cannot supply reliable correlation fields. Its result uses a stable
`invalid-<digest>` ID for the claimed filename, `request_id: ""`, `card_version: 0`,
and `kind: "invalid"`. For parseable invalid objects, available correlation fields
are retained; unsafe IDs are replaced with a synthetic ID. No malformed input is
sent. Inspect `.reason`, correct the producer, and publish a new delivery with a new
ID after resolving a dead letter; moving a terminal ID back to `new/` does not resend it.

## Retry and recovery contract

Network failures, HTTP 5xx and HTTP 429 retry after **30 s, 2 min, 10 min, 30 min**,
with at most **5 attempts**. A longer Retry-After delay wins. Other HTTP 4xx and
unsupported channels are terminal. The bridge passes `maxAttempts: 1` to the adapter
so adapter retries do not multiply this budget. Polling may add up to `pollMs` delay.

The additive store migration creates `outbox_deliveries` with `outbox_id` as its
primary key, `status`, `attempts`, `next_try_at`, JSON `refs`, and `updated_at`.
`reason` and `channel` retain the terminal/retry result needed for crash recovery.
Message delivery refs and the delivered deduplication marker are committed in the
same SQLite transaction. Database time fields are epoch milliseconds.

After restart, unfinished `cur/` files are processed with their stored retry budget
and deadline. Already delivered files only regenerate their result and move to
`done/`; already dead IDs remain dead. A result-write or archive failure retains
`cur/` for recovery and does not undo a committed delivery. Shutdown drains the active
poll before closing the store.

This is at-least-once delivery with durable deduplication after acknowledgment. If
the IM accepted a message but its response was lost, or the process died before the
SQLite commit, retry can produce a duplicate. No cross-system exactly-once guarantee
is claimed. These recovery guarantees cover process restarts, not loss of the disk.

Operational bridge logs contain only delivery ID, channel, status and safe error
codes. Bodies, exception payloads and credentials are not logged. The existing
session conversation store still retains the sent message and delivery refs.

## Offline verification

From the repository root:

```sh
pnpm exec vitest run packages/session/tests/outbox-bridge.test.ts packages/imwire/tests/outbox-serve.test.ts packages/telegram/tests/plain-text.test.ts packages/feishu/tests/plain-text.test.ts
pnpm test
pnpm typecheck
pnpm lint
```

The focused tests use temporary SQLite files, mock transports and frozen clocks.
They cover 100 slow atomic writers, malformed input, duplicate IDs across restart,
retry exhaustion and Retry-After, channel choice, literal text, unknown people,
`cur/` recovery, result-publication failure and absence of injected secrets in logs.
The full suite additionally needs permission to listen on local TCP and Unix sockets.
