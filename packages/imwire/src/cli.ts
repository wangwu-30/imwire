import { loadAdaptersFromEnv } from "./env.js";
import { serveStdio } from "./stdio.js";
import { attachWebSocket } from "./ws-server.js";

function arg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "serve";
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.error(`imwire serve [--ws [port]] [--ws-host host]

Runs configured IM adapters and speaks JSON-RPC 2.0 over stdio
(newline-delimited). Pass --ws to also listen on a WebSocket
(default port 8765). See docs/protocol.md.
Enable adapters via env (see .env.example).`);
    return;
  }
  if (cmd !== "serve") {
    console.error(`unknown command ${cmd}. Try: imwire serve`);
    process.exitCode = 1;
    return;
  }

  const adapters = loadAdaptersFromEnv();
  if (adapters.length === 0) {
    console.error("imwire serve: no adapters configured. Set tokens in the environment (.env.example).");
    process.exitCode = 1;
    return;
  }

  const wsPortRaw = arg("--ws");
  const wsPort = wsPortRaw ? Number(wsPortRaw) : has("--ws") ? 8765 : undefined;
  const wsHost = arg("--ws-host") ?? "127.0.0.1";

  const ac = new AbortController();
  const stop = (): void => ac.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const { host } = serveStdio(adapters);

  if (wsPort !== undefined && Number.isFinite(wsPort)) {
    const ws = await attachWebSocket(host, wsPort, wsHost);
    process.stderr.write(`imwire serve websocket ${ws.url}\n`);
  }

  process.stderr.write(`imwire serve ${adapters.map((a) => `${a.platform}:${a.accountId}`).join(", ")}\n`);
  await host.start(ac.signal);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
