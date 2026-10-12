import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter, Clock, Logger } from "@imwire/core";
import {
  SessionGateway,
  TotpVerifier,
  type AgentDriver,
  type OwnerAllowlistEntry,
  type QuietHours,
  type TurnResult,
  type TurnSink,
  type UserTurn,
} from "@imwire/session";
import { A2hRpc } from "./a2h-rpc.js";
import { redactingLogger } from "./redact.js";
import { listenUnixRpc, type UnixRpcServer } from "./unix-server.js";
import type { PeerInfo } from "./tokens.js";
import type { Socket } from "node:net";

export function defaultHubDir(): string {
  return process.env.IMWIRE_HOME ?? join(homedir(), ".imwire");
}
export function defaultSocketPath(dir = defaultHubDir()): string {
  return join(dir, "run", "hub.sock");
}

/** Used when the hub runs without a chat agent: plain DMs get a fixed reply. */
export class NoChatDriver implements AgentDriver {
  async ensureSession(): Promise<{ agentSessionId: string }> {
    return { agentSessionId: "none" };
  }
  async prompt(_s: string, _i: UserTurn, sink: TurnSink): Promise<TurnResult> {
    const text = "这个 hub 没有接聊天 agent，只转发 agent 的消息和审批。";
    sink.text(text);
    return { text };
  }
  async cancel(): Promise<void> {}
}

export interface HubOptions {
  dbPath: string;
  socketPath: string;
  /** Adapters, or a factory that receives the gateway (e.g. for persistent callback stores). */
  adapters?: Adapter[] | ((gw: SessionGateway) => Adapter[]);
  allowlist?: OwnerAllowlistEntry[];
  /**
   * Hub default is "totp": every agent approval needs a TOTP step-up unless
   * the owner downgrades that agent (`imwire agent level NAME im_account`).
   * "legacy" keeps v1 binding; approvals still use TOTP when a key is set.
   */
  identityMode?: "totp" | "legacy";
  /** 32-byte credential master key. Required for "totp". */
  masterKey?: Buffer;
  /** Optional chat agent (pi). Default: NoChatDriver. */
  driver?: AgentDriver;
  logger?: Logger;
  clock?: Clock;
  quietHours?: QuietHours | null;
  sweepIntervalMs?: number;
  maxWaitS?: number;
  peerOf?: (socket: Socket) => PeerInfo;
}

export interface Hub {
  gw: SessionGateway;
  rpc: A2hRpc;
  server: UnixRpcServer;
  /** Start adapters (long-running); resolves when they stop. */
  run(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export async function startHub(opts: HubOptions): Promise<Hub> {
  const logger = redactingLogger(opts.logger ?? silentLogger);
  const mode = opts.identityMode ?? "totp";
  if (mode === "totp" && !opts.masterKey) throw new Error("identity mode totp needs a master key (imwire owner init)");
  const gw = new SessionGateway({
    dbPath: opts.dbPath,
    driver: opts.driver ?? new NoChatDriver(),
    allowlist: opts.allowlist,
    logger,
    clock: opts.clock,
    quietHours: opts.quietHours,
    sweepIntervalMs: opts.sweepIntervalMs,
    identityMode: mode,
    approverVerifier: opts.masterKey ? (store) => new TotpVerifier({ store, masterKey: opts.masterKey! }) : undefined,
  });
  const adapters = typeof opts.adapters === "function" ? opts.adapters(gw) : (opts.adapters ?? []);
  for (const a of adapters) gw.attach(a);
  const rpc = new A2hRpc(gw, { maxWaitS: opts.maxWaitS, now: () => (opts.clock ?? Date).now(), logger });
  let server: UnixRpcServer;
  try {
    server = await listenUnixRpc({
      path: opts.socketPath,
      handler: rpc.handle,
      peerOf: opts.peerOf,
      onError: (err) => logger.error("rpc handler failed", { err: String(err) }),
    });
  } catch (err) {
    gw.close();
    throw err;
  }
  logger.info("hub listening", { socket: opts.socketPath, identity: mode });
  return {
    gw,
    rpc,
    server,
    run: async (signal) => {
      await Promise.all(adapters.map((a) => a.start(signal)));
    },
    close: async () => {
      await server.close();
      gw.close();
    },
  };
}

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
