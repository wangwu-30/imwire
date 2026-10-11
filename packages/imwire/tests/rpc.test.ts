import { expect, test } from "vitest";
import { parseRpc } from "../src/protocol.js";
import { RPC_INVALID_REQUEST, RPC_PARSE, RpcFail } from "../src/rpc.js";
import { createServeHost } from "../src/server.js";
import { stderrLogger, sdkStderrLogger } from "../src/logger.js";

test("parseRpc: JSON fail is -32700, batch is -32600", () => {
  try {
    parseRpc("{not json");
    expect.unreachable();
  } catch (err) {
    expect(err).toBeInstanceOf(RpcFail);
    expect((err as RpcFail).rpcCode).toBe(RPC_PARSE);
  }
  try {
    parseRpc(JSON.stringify([{ jsonrpc: "2.0", id: 9, method: "hello" }]));
    expect.unreachable();
  } catch (err) {
    expect(err).toBeInstanceOf(RpcFail);
    expect((err as RpcFail).rpcCode).toBe(RPC_INVALID_REQUEST);
  }
});

test("JSON-RPC method / params / notification codes", async () => {
  const out: unknown[] = [];
  const host = createServeHost({
    adapters: [],
    write: (m) => {
      out.push(m);
    },
  });
  const reply = (m: unknown) => {
    out.push(m);
  };

  await host.handleLine("{not json", reply);
  expect((out.at(-1) as { error: { code: number } }).error.code).toBe(-32700);

  out.length = 0;
  await host.handleLine(JSON.stringify([{ jsonrpc: "2.0", id: 9, method: "hello" }]), reply);
  expect((out.at(-1) as { error: { code: number } }).error.code).toBe(-32600);

  out.length = 0;
  await host.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "nope" }), reply);
  expect((out.at(-1) as { error: { code: number } }).error.code).toBe(-32601);

  const before = out.length;
  await host.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "nope" }), reply);
  expect(out.length).toBe(before);

  out.length = 0;
  await host.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 11, method: "send", params: null }),
    reply,
  );
  expect((out.at(-1) as { error: { code: number } }).error.code).toBe(-32602);
});

test("stderrLogger and sdkStderrLogger write to stderr", () => {
  const writes: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    stderrLogger.info("hello", { token: "xoxb-secret" });
    sdkStderrLogger().info("event-dispatch is ready");
  } finally {
    process.stderr.write = orig;
  }
  expect(writes.some((w) => w.includes("[imwire info] hello") && w.includes("[redacted]"))).toBe(
    true,
  );
  expect(writes.some((w) => w.includes("[info]:") && w.includes("event-dispatch"))).toBe(true);
});
