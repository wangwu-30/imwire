import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { PeerInfo } from "./tokens.js";

export const MAX_LINE_BYTES = 1024 * 1024;

export interface RpcConnection {
  readonly id: number;
  readonly peer: PeerInfo;
  /** Present only after a successful a2h.auth; kept in memory, never logged. */
  token?: string;
  agentId?: string;
  authFailures: number;
  notify(method: string, params: unknown): void;
  close(): void;
  onClose(fn: () => void): void;
}

export type RpcHandler = (conn: RpcConnection, method: string, params: unknown) => Promise<unknown>;

export interface UnixRpcServer {
  path: string;
  close(): Promise<void>;
}

/**
 * Peer identity. Node has no portable SO_PEERCRED / getpeereid, so the uid
 * is established by the filesystem: the socket lives in a 0700 directory we
 * own and is itself 0600, so only our uid (or root) can connect. A native
 * peer-credential lookup can be plugged in via `peerOf`.
 */
export function defaultPeerOf(): PeerInfo {
  return { uid: typeof process.getuid === "function" ? process.getuid() : undefined };
}

function ensurePrivateDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`socket directory ${dir} is not owned by the current user`);
  }
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`socket directory ${dir} must be private (chmod 700), is ${(st.mode & 0o777).toString(8)}`);
  }
}

async function isLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(path);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

export async function listenUnixRpc(opts: {
  path: string;
  handler: RpcHandler;
  peerOf?: (socket: Socket) => PeerInfo;
  onError?: (err: unknown) => void;
}): Promise<UnixRpcServer> {
  ensurePrivateDir(dirname(opts.path));
  if (existsSync(opts.path)) {
    if (!lstatSync(opts.path).isSocket()) throw new Error(`${opts.path} exists and is not a socket`);
    if (await isLive(opts.path)) throw new Error(`a hub is already listening on ${opts.path}`);
    unlinkSync(opts.path);
  }
  let nextId = 1;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    const closers: Array<() => void> = [];
    const conn: RpcConnection = {
      id: nextId++,
      peer: (opts.peerOf ?? defaultPeerOf)(socket),
      authFailures: 0,
      notify: (method, params) => {
        if (!socket.destroyed) socket.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
      },
      close: () => socket.end(),
      onClose: (fn) => closers.push(fn),
    };
    socket.on("close", () => {
      sockets.delete(socket);
      conn.token = undefined;
      for (const fn of closers) fn();
    });
    socket.on("error", () => undefined);
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE_BYTES && !buf.includes("\n")) {
        socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "frame too large" } })}\n`);
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) void dispatch(conn, socket, line, opts.handler, opts.onError);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.path, () => resolve());
  });
  chmodSync(opts.path, 0o600);
  return {
    path: opts.path,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          try {
            unlinkSync(opts.path);
          } catch {
            // already gone
          }
          resolve();
        });
      }),
  };
}

async function dispatch(
  conn: RpcConnection,
  socket: Socket,
  line: string,
  handler: RpcHandler,
  onError?: (err: unknown) => void,
): Promise<void> {
  let msg: { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch {
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
    return;
  }
  const id = msg.id ?? null;
  if (typeof msg.method !== "string") {
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } })}\n`);
    return;
  }
  try {
    const result = await handler(conn, msg.method, msg.params ?? {});
    if (msg.id !== undefined && !socket.destroyed) socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  } catch (err) {
    const e = err as { rpcCode?: number; message?: string; data?: unknown };
    if (e.rpcCode === undefined) onError?.(err);
    const error = { code: e.rpcCode ?? -32603, message: e.rpcCode !== undefined ? (e.message ?? "error") : "internal error", data: e.data };
    if (msg.id !== undefined && !socket.destroyed) socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, error })}\n`);
  }
}

/** Minimal client used by tests, `imwire mcp` (PR 4) and admin tooling. */
export class UnixRpcClient {
  private socket?: Socket;
  private seq = 1;
  private buf = "";
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  private readonly listeners = new Set<(n: { method: string; params: unknown }) => void>();

  constructor(private readonly path: string) {}

  async connect(): Promise<this> {
    this.socket = createConnection(this.path);
    this.socket.setEncoding("utf8");
    await new Promise<void>((resolve, reject) => {
      this.socket!.once("connect", () => resolve());
      this.socket!.once("error", reject);
    });
    this.socket.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { code: number; message: string; data?: unknown }; method?: string; params?: unknown };
        if (msg.method) {
          const n = { method: msg.method, params: msg.params };
          this.notifications.push(n);
          for (const l of this.listeners) l(n);
          continue;
        }
        const p = this.pending.get(msg.id as number);
        if (!p) continue;
        this.pending.delete(msg.id as number);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, data: msg.error.data }));
        else p.resolve(msg.result);
      }
    });
    this.socket.on("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("connection closed"));
      this.pending.clear();
    });
    return this;
  }

  onNotification(fn: (n: { method: string; params: unknown }) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const id = this.seq++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close(): void {
    this.socket?.destroy();
  }
}
