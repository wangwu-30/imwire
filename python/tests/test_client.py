import asyncio
import sys
import unittest
from pathlib import Path

from imwire.client import ImwireClient, ImwireError

PY = sys.executable
FAKE = str(Path(__file__).with_name("fake_serve.py"))


class ClientTransportTest(unittest.IsolatedAsyncioTestCase):
    async def _case(self, mode: str, fn):
        client = await ImwireClient.connect_stdio([PY, FAKE, mode])
        try:
            return await asyncio.wait_for(fn(client), 5)
        finally:
            pump = client._pump
            await asyncio.sleep(0.05)
            if pump and pump.done() and not pump.cancelled() and pump.exception():
                raise pump.exception()
            await client.aclose()

    async def test_late_response_after_timeout_is_ignored(self):
        async def cancel_then_next(c: ImwireClient):
            with self.assertRaises((TimeoutError, asyncio.TimeoutError)):
                await asyncio.wait_for(c.request("hello"), 0.1)
            await asyncio.sleep(0.6)
            return await asyncio.wait_for(c.request("hello"), 2)

        result = await self._case("slow", cancel_then_next)
        self.assertEqual(result, {"ok": True})

    async def test_non_json_stdout_is_skipped(self):
        result = await self._case("junk", lambda c: c.request("hello"))
        self.assertEqual(result, {"ok": True})

    async def test_large_event_line(self):
        result = await self._case("big", lambda c: c.request("hello"))
        self.assertEqual(result, {"ok": True})

    async def test_stderr_is_drained(self):
        result = await self._case("stderr", lambda c: c.request("hello"))
        self.assertEqual(result, {"ok": True})

    async def test_events_stop_after_aclose(self):
        client = await ImwireClient.connect_stdio([PY, FAKE, "junk"])
        await client.aclose()
        with self.assertRaises(StopAsyncIteration):
            await client.events().__anext__()

    def test_imwire_error_carries_code(self):
        err = ImwireError("nope", -32601)
        self.assertEqual(err.code, -32601)


if __name__ == "__main__":
    unittest.main()
