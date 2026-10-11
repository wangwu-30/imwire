# imwire serve protocol

`imwire serve` runs every adapter you configured (env vars) as a standalone process. Clients talk **JSON-RPC 2.0**.

| Transport | Framing |
|---|---|
| **stdio** | One JSON-RPC object per line (UTF-8, `\n` delimited). Logs go to **stderr**. |
| **WebSocket** | One JSON-RPC object per text frame. `imwire serve --ws 8765` |

Protocol version: **`1.0`**.

Normalized events (the same `Inbound` model as `@imwire/core`) flow **out** as notifications. `send` / `edit` / `draft` / `approval` flow **in** as requests.

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

Parse errors use `-32700` / invalid request `-32600`.

## Python

```python
from imwire import ImwireClient

async with ImwireClient.stdio() as client:
    async for event in client.events():
        ...
```

The PyPI package `imwire` is a thin async client for this protocol (stdio or WebSocket).
