# imwire (Python)

Thin async client for [`imwire serve`](../docs/protocol.md). Speaks JSON-RPC 2.0 over stdio or WebSocket. Typed dataclasses mirror `@imwire/core` inbound / outbound shapes.

```bash
pip install imwire
# WebSocket extra
pip install "imwire[ws]"
```

```python
from imwire import ImwireClient

async with ImwireClient.stdio() as client:  # or ImwireClient.ws("ws://127.0.0.1:8765")
    info = await client.hello()
    async for event in client.events():
        if event.type == "message":
            draft = await client.start_draft(event.chat)
            await draft.append(event.text)
            await draft.finalize(text=event.text)
```

See `examples/echo.py`. The Node process (`imwire serve`) must be on `PATH` or passed as `command=`.
