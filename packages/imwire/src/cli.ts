import { readFile } from "node:fs/promises";
import type { ServeOptions } from "./server.js";
import { onShutdownSignal } from "@imwire/core";
import { loadAdaptersFromEnv, parseAdapterList, type AdapterName } from "./env.js";
import { chatPreset } from "./chat.js";
import { parseAllowlist } from "./hub/preset.js";
import { runHubCli } from "./hub/commands.js";
import { stderrLogger } from "./logger.js";
import { serveStdio } from "./stdio.js";
import { attachWebSocket, generateWsToken, isLoopbackHost } from "./ws-server.js";

function flagValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const next = process.argv[idx + 1];
  if (!next || next.startsWith("-")) return "";
  return next;
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

function collectAdapters(): AdapterName[] {
  const fromFlags: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === "--adapter" || process.argv[i] === "-a") {
      const v = process.argv[i + 1];
      if (v && !v.startsWith("-")) fromFlags.push(v);
    }
  }
  const listed = [...parseAdapterList(fromFlags.join(",")), ...parseAdapterList(process.env.IMWIRE_ADAPTERS)];
  return [...new Set(listed)];
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "serve";
  if (cmd === "hub" || cmd === "owner" || cmd === "agent" || cmd === "audit" || cmd === "policy") {
    process.exitCode = await runHubCli(process.argv.slice(2));
    return;
  }
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.error(`imwire hub|owner|agent|policy|audit ...   (a2h hub; run: imwire help)
imwire serve --adapter NAME ... [--config PATH] [--ws [port]] [--ws-host host] [--ws-token TOKEN] [--ws-allow-remote]

Runs named IM adapters and speaks JSON-RPC 2.0 over stdio (newline-delimited).
Adapters are NEVER inferred from leftover tokens — pass --adapter / IMWIRE_ADAPTERS.
--ws binds 127.0.0.1 (default port 8765). A token is required (IMWIRE_WS_TOKEN /
--ws-token, or generated and printed to stderr). Browser Origin is rejected.
Optional pi chat: IMWIRE_USE_PI=1 + model key (IMWIRE_CHAT=off disables).
See docs/protocol.md and docs/serve-chat.md.`);
    return;
  }
  if (cmd !== "serve") {
    console.error(`unknown command ${cmd}. Try: imwire serve | imwire hub`);
    process.exitCode = 1;
    return;
  }

  const configPath = flagValue("--config");
  const config: Pick<ServeOptions, "outboxBridge" | "dbPath" | "preferredChannels"> = configPath
    ? JSON.parse(await readFile(configPath, "utf8")) : {};
  const enabled = collectAdapters();
  if (enabled.length === 0) {
    console.error("imwire serve: set IMWIRE_ADAPTERS=telegram,feishu or pass --adapter telegram (tokens alone are ignored).");
    process.exitCode = 1;
    return;
  }

  let adapters;
  try {
    adapters = loadAdaptersFromEnv({ enabled, logger: stderrLogger });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
    return;
  }

  const wantWs = has("--ws") || has("--ws-host") || has("--ws-token") || has("--ws-allow-remote");
  if (has("--ws-host") && !has("--ws") && flagValue("--ws") === undefined) {
    // --ws-host implies --ws
  }
  const wsPortRaw = flagValue("--ws");
  const wsPort = wantWs ? (wsPortRaw && Number.isFinite(Number(wsPortRaw)) ? Number(wsPortRaw) : 8765) : undefined;
  const wsHost = flagValue("--ws-host") || "127.0.0.1";
  const suppliedToken = flagValue("--ws-token") || process.env.IMWIRE_WS_TOKEN;
  const wsToken = suppliedToken || (wantWs ? generateWsToken() : undefined);
  const allowRemote = has("--ws-allow-remote");

  if (wantWs && wsPort !== undefined && !Number.isFinite(wsPort)) {
    console.error("imwire serve: --ws requires a port number (default 8765)");
    process.exitCode = 1;
    return;
  }
  if (wantWs && !isLoopbackHost(wsHost) && !allowRemote) {
    console.error("imwire serve: non-loopback --ws-host requires --ws-allow-remote and a token");
    process.exitCode = 1;
    return;
  }

  const ac = new AbortController();
  onShutdownSignal(() => ac.abort(), { log: (msg) => process.stderr.write(`imwire serve: ${msg}\n`) });

  const chat = chatPreset();
  const { host } = serveStdio(adapters, process.stdin, process.stdout, () => {
    process.stderr.write("imwire serve: stdin closed, exiting\n");
    ac.abort();
    process.exit(0); // serveStdio has already drained the bridge and closed its store.
  }, {
    outboxBridge: config.outboxBridge,
    dbPath: config.dbPath,
    preferredChannels: config.preferredChannels,
    driver: chat.driver,
    allowlist: parseAllowlist(process.env.IMWIRE_ALLOWLIST ?? ""),
    logger: stderrLogger,
  });
  for (const description of chat.describe) process.stderr.write(`imwire serve: ${description}\n`);

  if (wsPort !== undefined) {
    const ws = await attachWebSocket(host, {
      port: wsPort,
      host: wsHost,
      token: wsToken,
      allowRemote,
    });
    process.stderr.write(`imwire serve websocket ${ws.url}\n`);
    if (!suppliedToken) process.stderr.write(`imwire serve ws token ${ws.token}\n`);
  }

  process.stderr.write(`imwire serve ${adapters.map((a) => `${a.platform}:${a.accountId}`).join(", ")}\n`);
  await host.start(ac.signal);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
