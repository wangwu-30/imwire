# imwire serve protocol

`imwire serve` runs the adapters you **explicitly** enable and speaks **JSON-RPC 2.0**. Tokens in the environment are never enough on their own — leftover `TELEGRAM_BOT_TOKEN` / Feishu / Slack secrets will not start a bot.

```bash
imwire serve --adapter telegram --adapter slack
# or
IMWIRE_ADAPTERS=telegram,feishu imwire serve
```

| Transport | Framing |
|---|---|
| **stdio** | One JSON-RPC object per line (UTF-8, `\n` delimited). **Stdout is JSON-RPC only.** Logs (including the Feishu SDK logger) go to **stderr**. Stdin EOF exits the process. |
| **WebSocket** | One JSON-RPC object per text frame. `imwire serve --ws [port]` (default `8765`). `--ws-host` implies `--ws`. |

Max line / frame size: **1 MiB**. Protocol version: **`1.0`**.

Normalized events (the same `Inbound` model as `@imwire/core`) flow **out** as notifications. `send` / `edit` / `draft` / `approval` flow **in** as requests. Each client has its own request-id namespace; a response is written only to the client that sent the request.

## Security (WebSocket)

`--ws` binds **`127.0.0.1`** by default. A token is **required**:

- `IMWIRE_WS_TOKEN` or `--ws-token TOKEN`
- if neither is set, serve generates one and prints `imwire serve ws token …` to **stderr**

Clients must present the token as `Authorization: Bearer <token>` only (query-string and `Sec-WebSocket-Protocol` are rejected). Comparison is constant-time. A generated token is printed to stderr; a user-supplied token is not.

- Any request that carries a browser `Origin` header is **rejected** (this is not a browser API).
- Non-loopback `--ws-host` (e.g. `0.0.0.0`) is refused unless `--ws-allow-remote` **and** a token are both set.
- `maxPayload` is 1 MiB.

## subscribe

`hello` / `initialize` automatically subscribe that client to inbound `event` notifications. Additional clients (especially WebSocket) start **unsubscribed** until they call `hello` or `subscribe`.

```json
{"jsonrpc":"2.0","id":1,"method":"subscribe","params":{}}
{"jsonrpc":"2.0","id":2,"method":"unsubscribe","params":{}}
```

Events are broadcast only to subscribed writers. Draft ids are scoped to the client that called `draft.start`.

## Hello

```json
{"jsonrpc":"2.0","id":1,"method":"hello","params":{}}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "1.0",
    "platforms": [
      {
        "platform": "telegram",
        "accountId": "999",
        "capabilities": { "streaming": "edit", "proactiveSend": true }
      }
    ]
  }
}
```

`initialize` is an alias of `hello`.

## Events (server → client)

No `id` — this is a notification.

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "platform": "slack",
    "accountId": "slack",
    "event": {
      "type": "message",
      "id": "msg:1710000000.000100",
      "ts": 1710000000000,
      "chat": { "platform": "slack", "accountId": "slack", "chatId": "D111", "kind": "dm" },
      "from": { "platform": "slack", "accountId": "slack", "userId": "U111" },
      "messageId": "1710000000.000100",
      "text": "hello",
      "mentionsBot": true
    }
  }
}
```

`event` is the `@imwire/core` `Inbound` union (`message` | `command` | `edit` | `action` | `reaction`) with `raw` stripped.

## send

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "send",
  "params": {
    "chat": { "platform": "telegram", "accountId": "999", "chatId": "111", "kind": "dm" },
    "msg": {
      "blocks": [
        { "kind": "markdown", "text": "hello" },
        { "kind": "buttons", "buttons": [{ "id": "approve", "label": "Approve", "style": "primary" }] }
      ]
    }
  }
}
```

Result: `{ "refs": [{ "chat": {…}, "messageId": "…" }] }`.

## edit

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "edit",
  "params": {
    "ref": { "chat": { "platform": "slack", "accountId": "slack", "chatId": "D111", "kind": "dm" }, "messageId": "1710000000.000100" },
    "msg": { "blocks": [{ "kind": "markdown", "text": "updated" }] }
  }
}
```

Result: `{ "ok": true }`. Honors each adapter's `editScope` (`any` / `cards` / `none`).

## draft

Streaming draft as a small state machine. `op` is required.

```json
{"jsonrpc":"2.0","id":4,"method":"draft","params":{"op":"start","chat":{…},"replyTo":{…}}}
```

Result: `{ "draftId": "draft-1" }`.

```json
{"jsonrpc":"2.0","id":5,"method":"draft","params":{"op":"append","draftId":"draft-1","delta":"Hel"}}
{"jsonrpc":"2.0","id":6,"method":"draft","params":{"op":"status","draftId":"draft-1","text":"thinking"}}
{"jsonrpc":"2.0","id":7,"method":"draft","params":{"op":"finalize","draftId":"draft-1","msg":{"blocks":[{"kind":"markdown","text":"Hello"}]}}}
```

`finalize` result: `{ "refs": […] }`. `abort` takes `{ "op":"abort","draftId":"…","note":"cancelled" }`.

The adapter degrades the stream using its capability table (card / edit / buffer).

## approval

Convenience for an Approve / Deny card. `requestId` is placed on both button `value`s so the later `action` event can be correlated.

```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "approval",
  "params": {
    "chat": { "platform": "feishu", "accountId": "cli_xxx", "chatId": "oc_dm_1", "kind": "dm" },
    "text": "Deploy prod?",
    "requestId": "deploy-42"
  }
}
```

Result: `{ "refs": […] }`.

Also available: `typing` `{ chat }` and `delete` `{ ref }`.

## Errors

```json
{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"no adapter for wecom:missing"}}
```

| Code | Meaning |
|---|---|
| `-32700` | Parse error (invalid JSON) |
| `-32600` | Invalid request (batch, missing `method`, oversized line) |
| `-32601` | Method not found |
| `-32602` | Invalid params (`params` not an object; missing `chat` / `msg`; unknown `accountId` is **not** this — see `-32000`) |
| `-32603` | Internal error |
| `-32000` | Application error (unknown `platform:accountId`, unknown `draftId`, adapter throw) |

An unknown `accountId` is an error — serve will not silently route to another account of the same platform. Notifications (`id` omitted) never receive an error response.

## Python

```python
from imwire import ImwireClient

async with ImwireClient.stdio() as client:
    async for event in client.events():
        ...
```

The PyPI package `imwire` is a thin async client for this protocol (stdio or WebSocket).
