import { FakeAdapter } from "@imwire/core/testing";
import type { Capabilities, Inbound } from "@imwire/core";
import { PassThrough } from "node:stream";
import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";
import { createServeHost } from "../src/server.js";
import { serveStdio } from "../src/stdio.js";
import {
  attachWebSocket,
  generateWsToken,
  isLoopbackHost,
  tokensEqual,
  type WsServeHandle,
} from "../src/ws-server.js";

const caps: Capabilities = {
  streaming: "edit",
  streamingCard: false,
  edit: true,
  editScope: "any",
  proactiveSend: true,
  delete: true,
  buttons: true,
  reactions: false,
  threads: false,
  typing: true,
  media: { image: false, file: false },
  maxTextLength: 1000,
  markdown: "none",
};

const handles: WsServeHandle[] = [];

afterEach(async () => {
  while (handles.length) {
    await handles.pop()?.close();
  }
});

function fake() {
  return new FakeAdapter({ platform: "telegram", accountId: "acc1", capabilities: caps });
}

function hostOf(adapter = fake()) {
  const stdout: unknown[] = [];
  const host = createServeHost({
    adapters: [adapter],
    write: (m) => {
      stdout.push(m);
    },
  });
  return { adapter, host, stdout };
}

async function listen(host: ReturnType<typeof createServeHost>, token = "test-token") {
  const ws = await attachWebSocket(host, { port: 0, host: "127.0.0.1", token });
  handles.push(ws);
  return ws;
}

function open(
  url: string,
  headers?: Record<string, string>,
): Promise<{ socket: WebSocket; got: unknown[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const got: unknown[] = [];
    socket.on("message", (d) => {
      got.push(JSON.parse(String(d)));
    });
    socket.on("open", () => resolve({ socket, got }));
    socket.on("unexpected-response", (_req, res) => {
      reject(Object.assign(new Error(`http ${res.statusCode}`), { statusCode: res.statusCode }));
    });
    socket.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("isLoopbackHost and tokensEqual", () => {
  expect(isLoopbackHost("127.0.0.1")).toBe(true);
  expect(isLoopbackHost("0.0.0.0")).toBe(false);
  expect(tokensEqual("abc", "abc")).toBe(true);
  expect(tokensEqual("abc", "abd")).toBe(false);
  expect(generateWsToken().length).toBeGreaterThan(16);
});

test("WS rejects browser Origin even with a valid token", async () => {
  const { host } = hostOf();
  const ws = await listen(host);
  await expect(
    open(ws.url, { Authorization: `Bearer ${ws.token}`, Origin: "https://evil.example" }),
  ).rejects.toThrow(/http 401|Unexpected server response/);
});

test("WS rejects a missing / wrong token", async () => {
  const { host } = hostOf();
  const ws = await listen(host);
  await expect(open(ws.url)).rejects.toThrow(/http 401|Unexpected server response/);
  await expect(open(ws.url, { Authorization: "Bearer wrong-token-value" })).rejects.toThrow(
    /http 401|Unexpected server response/,
  );
});

test("RPC responses stay on the originating client; events only go to subscribers", async () => {
  const { adapter, host, stdout } = hostOf();
  const ws = await listen(host);
  const auth = { Authorization: `Bearer ${ws.token}` };
  const a = await open(ws.url, auth);
  const b = await open(ws.url, auth);
  const chat = { platform: "telegram", accountId: "acc1", chatId: "42", kind: "dm" };
  a.socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "send",
      params: { chat, msg: { blocks: [{ kind: "markdown", text: "fromA" }] } },
    }),
  );
  await sleep(80);
  expect(b.got.some((m) => (m as { id?: number }).id === 1)).toBe(false);
  expect(stdout.some((m) => (m as { id?: number }).id === 1)).toBe(false);
  expect(a.got.some((m) => (m as { id?: number }).id === 1 && "result" in (m as object))).toBe(true);

  await adapter.ingest({
    type: "message",
    id: "e1",
    ts: 1,
    chat,
    from: { platform: "telegram", accountId: "acc1", userId: "u" },
    messageId: "m1",
    text: "secret dm",
    mentionsBot: true,
  } satisfies Inbound);
  await sleep(40);
  expect(a.got.some((m) => (m as { method?: string }).method === "event")).toBe(false);
  expect(b.got.some((m) => (m as { method?: string }).method === "event")).toBe(false);

  a.socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "hello" }));
  await sleep(40);
  await adapter.ingest({
    type: "message",
    id: "e2",
    ts: 2,
    chat,
    from: { platform: "telegram", accountId: "acc1", userId: "u" },
    messageId: "m2",
    text: "after hello",
    mentionsBot: true,
  } satisfies Inbound);
  await sleep(40);
  expect(a.got.some((m) => (m as { method?: string }).method === "event")).toBe(true);
  expect(b.got.some((m) => (m as { method?: string }).method === "event")).toBe(false);
  expect(stdout.some((m) => (m as { method?: string }).method === "event")).toBe(true);
  a.socket.close();
  b.socket.close();
});

test("unknown accountId is an error, not a silent fallback", async () => {
  const { host } = hostOf();
  const ws = await listen(host);
  const b = await open(ws.url, { Authorization: `Bearer ${ws.token}` });
  b.socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "send",
      params: {
        chat: { platform: "telegram", accountId: "OTHER", chatId: "42", kind: "dm" },
        msg: { blocks: [{ kind: "markdown", text: "x" }] },
      },
    }),
  );
  await sleep(80);
  const reply = b.got.find((m) => (m as { id?: number }).id === 7) as {
    error?: { code: number; message: string };
  };
  expect(reply.error?.code).toBe(-32000);
  expect(reply.error?.message).toMatch(/OTHER/);
  b.socket.close();
});

test("oversized WS frame is rejected (maxPayload 1 MiB)", async () => {
  const { host } = hostOf();
  const ws = await listen(host);
  const b = await open(ws.url, { Authorization: `Bearer ${ws.token}` });
  b.socket.on("error", () => undefined);
  const closed = new Promise<void>((resolve) => b.socket.on("close", () => resolve()));
  b.socket.send(
    JSON.stringify({ jsonrpc: "2.0", id: 12, method: "hello", pad: "z".repeat(2 * 1024 * 1024) }),
  );
  await Promise.race([closed, sleep(1500)]);
  expect(b.socket.readyState).not.toBe(WebSocket.OPEN);
});

test("refuses non-loopback host without --ws-allow-remote", async () => {
  const { host } = hostOf();
  await expect(attachWebSocket(host, { port: 0, host: "0.0.0.0", token: "t" })).rejects.toThrow(
    /allow-remote/,
  );
});

test("stdio closes the host when stdin ends", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let closed = false;
  serveStdio([], stdin, stdout, () => {
    closed = true;
  });
  stdin.end();
  await sleep(30);
  expect(closed).toBe(true);
});
