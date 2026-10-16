import { createInterface } from "node:readline";
import { MAX_RPC_BYTES, type JsonRpcMessage } from "./protocol.js";
import { createServeHost, type ServeHost, type ServeOptions } from "./server.js";
import type { Adapter } from "@imwire/core";

export function serveStdio(
  adapters: Adapter[],
  stdin = process.stdin,
  stdout = process.stdout,
  onClose?: () => void,
  options: Omit<ServeOptions, "adapters" | "write"> = {},
): { host: ServeHost } {
  const write = (msg: JsonRpcMessage): void => {
    stdout.write(`${JSON.stringify(msg)}\n`);
  };
  const host = createServeHost({ ...options, adapters, write });
  const rl = createInterface({ input: stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (line.length > MAX_RPC_BYTES) {
      write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `line exceeds ${MAX_RPC_BYTES} bytes` } });
      return;
    }
    void host.handleLine(line, write);
  });
  rl.on("close", () => {
    void host.stop().then(() => onClose?.());
  });
  return { host };
}
