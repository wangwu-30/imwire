from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Sequence
from typing import Any

from .types import Button, ChatRef, InboundEvent, MsgRef, OutMessage, inbound_from_rpc, refs_from_rpc


class ImwireError(RuntimeError):
    def __init__(self, message: str, code: int | None = None):
        super().__init__(message)
        self.code = code


class Draft:
    def __init__(self, client: ImwireClient, draft_id: str):
        self._client = client
        self.draft_id = draft_id

    async def append(self, delta: str) -> None:
        await self._client.request("draft", {"op": "append", "draftId": self.draft_id, "delta": delta})

    async def set_status(self, text: str) -> None:
        await self._client.request("draft", {"op": "status", "draftId": self.draft_id, "text": text})

    async def finalize(self, msg: OutMessage | None = None, text: str | None = None) -> list[MsgRef]:
        body: dict[str, Any] = {"op": "finalize", "draftId": self.draft_id}
        if msg is not None:
            body["msg"] = msg.to_rpc()
        elif text is not None:
            body["msg"] = OutMessage(markdown=text).to_rpc()
        result = await self._client.request("draft", body)
        return refs_from_rpc(result)

    async def abort(self, note: str | None = None) -> None:
        await self._client.request("draft", {"op": "abort", "draftId": self.draft_id, "note": note})


class ImwireClient:
    """Async JSON-RPC client for `imwire serve` (stdio or WebSocket)."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self._reader = reader
        self._writer = writer
        self._next_id = 1
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._events: asyncio.Queue[InboundEvent] = asyncio.Queue()
        self._pump: asyncio.Task[None] | None = None
        self._closed = False

    @classmethod
    async def connect_stdio(
        cls,
        command: Sequence[str] | None = None,
    ) -> ImwireClient:
        argv = list(command) if command else ["imwire", "serve"]
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        if proc.stdin is None or proc.stdout is None:
            raise ImwireError("failed to open stdio pipes to imwire serve")
        client = cls(proc.stdout, proc.stdin)  # type: ignore[arg-type]
        client._proc = proc  # type: ignore[attr-defined]
        client._start_pump()
        return client

    @classmethod
    def stdio(cls, command: Sequence[str] | None = None) -> _StdioCtx:
        return _StdioCtx(cls, command)

    @classmethod
    def ws(cls, url: str) -> _WsCtx:
        return _WsCtx(cls, url)

    @classmethod
    async def connect_ws(cls, url: str) -> ImwireClient:
        try:
            import websockets  # type: ignore
        except ImportError as exc:
            raise ImwireError("WebSocket support requires `pip install imwire[ws]`") from exc
        sock = await websockets.connect(url)
        reader: asyncio.StreamReader = asyncio.StreamReader()  # placeholder unused
        client = object.__new__(cls)
        client._ws = sock
        client._reader = reader
        client._writer = None
        client._next_id = 1
        client._pending = {}
        client._events = asyncio.Queue()
        client._pump = None
        client._closed = False
        client._start_ws_pump()
        return client

    def _start_pump(self) -> None:
        self._pump = asyncio.create_task(self._read_loop())

    def _start_ws_pump(self) -> None:
        self._pump = asyncio.create_task(self._ws_loop())

    async def _read_loop(self) -> None:
        try:
            while not self._closed:
                line = await self._reader.readline()
                if not line:
                    break
                self._dispatch(line.decode("utf-8"))
        finally:
            self._fail_pending("stdio closed")

    async def _ws_loop(self) -> None:
        sock = getattr(self, "_ws", None)
        try:
            async for raw in sock:
                self._dispatch(str(raw))
        finally:
            self._fail_pending("websocket closed")

    def _fail_pending(self, message: str) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(ImwireError(message))
        self._pending.clear()

    def _dispatch(self, raw: str) -> None:
        raw = raw.strip()
        if not raw:
            return
        msg = json.loads(raw)
        if msg.get("method") == "event":
            params = msg.get("params") or {}
            event = inbound_from_rpc(params.get("event") or {})
            self._events.put_nowait(event)
            return
        rpc_id = msg.get("id")
        if rpc_id in self._pending:
            fut = self._pending.pop(rpc_id)
            if "error" in msg:
                err = msg["error"]
                fut.set_exception(ImwireError(str(err.get("message", "rpc error")), err.get("code")))
            else:
                fut.set_result(msg.get("result"))

    async def request(self, method: str, params: dict[str, Any] | None = None) -> Any:
        rpc_id = self._next_id
        self._next_id += 1
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[rpc_id] = fut
        payload = json.dumps({"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params or {}})
        await self._send(payload)
        return await fut

    async def _send(self, payload: str) -> None:
        sock = getattr(self, "_ws", None)
        if sock is not None:
            await sock.send(payload)
            return
        writer = self._writer
        if writer is None:
            raise ImwireError("client is closed")
        writer.write((payload + "\n").encode("utf-8"))
        await writer.drain()

    async def hello(self) -> Any:
        return await self.request("hello")

    async def send(self, chat: ChatRef, msg: OutMessage) -> list[MsgRef]:
        result = await self.request("send", {"chat": chat.to_rpc(), "msg": msg.to_rpc()})
        return refs_from_rpc(result)

    async def edit(self, ref: MsgRef, msg: OutMessage) -> None:
        await self.request("edit", {"ref": ref.to_rpc(), "msg": msg.to_rpc()})

    async def start_draft(self, chat: ChatRef, reply_to: MsgRef | None = None) -> Draft:
        params: dict[str, Any] = {"op": "start", "chat": chat.to_rpc()}
        if reply_to:
            params["replyTo"] = reply_to.to_rpc()
        result = await self.request("draft", params)
        return Draft(self, str(result["draftId"]))

    async def approval(self, chat: ChatRef, text: str, request_id: str) -> list[MsgRef]:
        result = await self.request("approval", {"chat": chat.to_rpc(), "text": text, "requestId": request_id})
        return refs_from_rpc(result)

    def events(self) -> AsyncIterator[InboundEvent]:
        return _EventIter(self._events)

    async def aclose(self) -> None:
        self._closed = True
        if self._pump:
            self._pump.cancel()
        sock = getattr(self, "_ws", None)
        if sock is not None:
            await sock.close()
        writer = self._writer
        if writer is not None:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
        proc = getattr(self, "_proc", None)
        if proc is not None and proc.returncode is None:
            proc.terminate()


class _EventIter:
    def __init__(self, queue: asyncio.Queue[InboundEvent]):
        self._queue = queue

    def __aiter__(self) -> _EventIter:
        return self

    async def __anext__(self) -> InboundEvent:
        return await self._queue.get()


class _StdioCtx:
    def __init__(self, cls: type[ImwireClient], command: Sequence[str] | None):
        self._cls = cls
        self._command = command
        self._client: ImwireClient | None = None

    async def __aenter__(self) -> ImwireClient:
        self._client = await self._cls.connect_stdio(self._command)
        return self._client

    async def __aexit__(self, *exc: object) -> None:
        if self._client:
            await self._client.aclose()


class _WsCtx:
    def __init__(self, cls: type[ImwireClient], url: str):
        self._cls = cls
        self._url = url
        self._client: ImwireClient | None = None

    async def __aenter__(self) -> ImwireClient:
        self._client = await self._cls.connect_ws(self._url)
        return self._client

    async def __aexit__(self, *exc: object) -> None:
        if self._client:
            await self._client.aclose()
