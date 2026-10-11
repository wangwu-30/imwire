import { createInterface } from "node:readline";
import type { JsonRpcMessage } from "./protocol.js";
import { createServeHost } from "./server.js";
import type { Adapter } from "@imwire/core";

export function serveStdio(adapters: Adapter[], stdin = process.stdin, stdout = process.stdout): { host: ReturnType<typeof createServeHost> } {
  const write = (msg: JsonRpcMessage): void => {
    stdout.write(`${JSON.stringify(msg)}\n`);
  };
  const host = createServeHost({ adapters, write });
  const rl = createInterface({ input: stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    void host.handleLine(line);
  });
  return { host };
}
