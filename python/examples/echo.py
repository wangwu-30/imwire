"""Echo inbound messages back through `imwire serve`.

Start the Node side first (or let this spawn it):

    pnpm --filter imwire start
    python python/examples/echo.py

Or:

    python python/examples/echo.py --stdio -- imwire serve
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "python" / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "python" / "src"))

from imwire import Button, ImwireClient, OutMessage  # noqa: E402


async def run(command: list[str] | None, url: str | None) -> None:
    if url:
        ctx = ImwireClient.ws(url)
    else:
        ctx = ImwireClient.stdio(command)
    async with ctx as client:
        info = await client.hello()
        print("hello", info, file=sys.stderr)
        async for event in client.events():
            print(event, file=sys.stderr)
            if event.type == "action":
                verdict = "Approved." if event.action_id == "approve" else f"Recorded: {event.action_id}"
                await client.send(event.target.chat, OutMessage(markdown=verdict))
                continue
            if event.type not in ("message", "command"):
                continue
            text = event.text if event.type == "message" else f"/{event.name} {event.args}".strip()
            draft = await client.start_draft(event.chat)
            await draft.set_status("echoing…")
            await draft.append(text or "(empty)")
            await draft.finalize(
                OutMessage(
                    markdown=text or "(empty)",
                    buttons=[
                        Button(id="approve", label="Approve", style="primary"),
                        Button(id="deny", label="Deny", style="danger"),
                    ],
                )
            )


def main() -> None:
    parser = argparse.ArgumentParser(description="Python echo client for imwire serve")
    parser.add_argument("--ws", dest="url", help="WebSocket URL (ws://127.0.0.1:8765)")
    parser.add_argument("command", nargs="*", help="stdio command after `--` (default: imwire serve)")
    args = parser.parse_args()
    command = args.command or None
    asyncio.run(run(command, args.url))


if __name__ == "__main__":
    main()
