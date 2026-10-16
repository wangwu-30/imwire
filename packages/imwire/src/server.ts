import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { OutboxBridge, SessionGateway, type OutboxBridgeOptions } from "@imwire/session";
import { NoChatDriver } from "./hub/hub.js";
import type { Adapter, ChatRef, Inbound, Logger } from "@imwire/core";
import {
  MAX_RPC_BYTES,
  PROTOCOL_VERSION,
  asRecord,
  eventNote,
  parseRpc,
  rpcError,
  rpcResult,
  type ApprovalParams,
  type DraftParams,
  type DraftRecord,
  type EditParams,
  type JsonRpcMessage,
  type SendParams,
} from "./protocol.js";
import { RPC_APP, RPC_INVALID_PARAMS, RPC_METHOD_NOT_FOUND, RpcFail } from "./rpc.js";

export type RpcReply = (msg: JsonRpcMessage) => void;

export interface ServeOptions {
  adapters: Adapter[];
  outboxBridge?: OutboxBridgeOptions;
  /** Existing person/identity database; defaults to IMWIRE_DB or ~/.imwire/hub.sqlite. */
  dbPath?: string;
  preferredChannels?: Array<"telegram" | "feishu">;
  logger?: Logger;
  write?: RpcReply;
}

export interface ServeHost {
  handleLine: (line: string, reply?: RpcReply) => Promise<void>;
  addWriter: (write: RpcReply, opts?: { subscribe?: boolean }) => () => void;
  subscribe: (write: RpcReply) => void;
  unsubscribe: (write: RpcReply) => void;
  start: (signal: AbortSignal) => Promise<void>;
  stop: () => Promise<void>;
}

interface ClientState {
  write: RpcReply;
  subscribed: boolean;
  drafts: Set<string>;
}

export function createServeHost(opts: ServeOptions): ServeHost {
  let gateway: SessionGateway | undefined;
  let bridge: OutboxBridge | undefined;
  if (opts.outboxBridge?.enabled) {
    if (!opts.outboxBridge.dir) throw new Error("outboxBridge.dir is required when enabled");
    const dbPath = opts.dbPath ?? process.env.IMWIRE_DB ?? join(process.env.IMWIRE_HOME ?? join(homedir(), ".imwire"), "hub.sqlite");
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    gateway = new SessionGateway({ dbPath, driver: new NoChatDriver(), logger: opts.logger,
      preferredChannels: opts.preferredChannels, bootExpiry: false, sweepIntervalMs: 0 });
    try { bridge = new OutboxBridge(gateway, opts.outboxBridge, opts.logger); }
    catch (err) { gateway.close(); throw err; }
    // Serve continues broadcasting inbound events to RPC clients; no chat driver is attached.
    for (const adapter of opts.adapters) gateway.registerAdapter(adapter);
  }
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => stopping ??= (async () => {
    await bridge?.stop();
    gateway?.close();
    drafts.clear();
    clients.clear();
  })();
  const drafts = new Map<string, DraftRecord>();
  let draftSeq = 0;
  const adapters = opts.adapters;
  const clients = new Map<RpcReply, ClientState>();

  const addClient = (write: RpcReply, subscribe: boolean): ClientState => {
    const existing = clients.get(write);
    if (existing) {
      if (subscribe) existing.subscribed = true;
      return existing;
    }
    const state: ClientState = { write, subscribed: subscribe, drafts: new Set() };
    clients.set(write, state);
    return state;
  };

  if (opts.write) addClient(opts.write, true);

  const broadcastEvent = (msg: JsonRpcMessage): void => {
    for (const c of clients.values()) {
      if (c.subscribed) c.write(msg);
    }
  };

  const pick = (chat: ChatRef): Adapter => {
    if (!chat || typeof chat.platform !== "string" || typeof chat.accountId !== "string") {
      throw new RpcFail(RPC_INVALID_PARAMS, "chat.platform and chat.accountId are required");
    }
    const found = adapters.find((a) => a.platform === chat.platform && a.accountId === chat.accountId);
    if (found) return found;
    throw new RpcFail(RPC_APP, `no adapter for ${chat.platform}:${chat.accountId}`);
  };

  for (const adapter of adapters) {
    adapter.on(async (event: Inbound) => {
      broadcastEvent(eventNote(event, adapter.platform, adapter.accountId));
    });
  }

  const requireParams = (params: unknown): Record<string, unknown> => {
    const rec = asRecord(params);
    if (!rec) throw new RpcFail(RPC_INVALID_PARAMS, "params must be an object");
    return rec;
  };

  const handle = async (line: string, reply?: RpcReply): Promise<void> => {
    const respond: RpcReply = reply ?? opts.write ?? (() => undefined);
    if (line.length > MAX_RPC_BYTES) {
      respond(rpcError(-32600, `request exceeds ${MAX_RPC_BYTES} bytes`));
      return;
    }
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try {
      req = parseRpc(trimmed);
    } catch (err) {
      const code = err instanceof RpcFail ? err.rpcCode : -32700;
      respond(rpcError(code, err instanceof Error ? err.message : "parse error"));
      return;
    }
    const isNotification = req.id === undefined;
    const id = req.id ?? null;
    const client = addClient(respond, false);
    try {
      const result = await dispatch(req.method, req.params, client);
      if (!isNotification) respond(rpcResult(id, result));
    } catch (err) {
      if (isNotification) return;
      const code = err instanceof RpcFail ? err.rpcCode : RPC_APP;
      respond(rpcError(code, err instanceof Error ? err.message : String(err), err instanceof RpcFail ? err.data : undefined, id));
    }
  };

  const dispatch = async (method: string, params: unknown, client: ClientState): Promise<unknown> => {
    switch (method) {
      case "hello":
      case "initialize":
        client.subscribed = true;
        return {
          protocolVersion: PROTOCOL_VERSION,
          platforms: adapters.map((a) => ({
            platform: a.platform,
            accountId: a.accountId,
            capabilities: a.capabilities,
          })),
        };
      case "subscribe":
        client.subscribed = true;
        return { ok: true };
      case "unsubscribe":
        client.subscribed = false;
        return { ok: true };
      case "send": {
        const p = requireParams(params) as unknown as SendParams;
        if (!p.chat || !p.msg) throw new RpcFail(RPC_INVALID_PARAMS, "send requires chat and msg");
        const refs = await pick(p.chat).send(p.chat, p.msg);
        return { refs };
      }
      case "edit": {
        const p = requireParams(params) as unknown as EditParams;
        if (!p.ref || !p.msg) throw new RpcFail(RPC_INVALID_PARAMS, "edit requires ref and msg");
        await pick(p.ref.chat).edit(p.ref, p.msg);
        return { ok: true };
      }
      case "draft":
        return handleDraft(requireParams(params) as unknown as DraftParams, client);
      case "approval": {
        const p = requireParams(params) as unknown as ApprovalParams;
        if (!p.chat || typeof p.text !== "string" || typeof p.requestId !== "string") {
          throw new RpcFail(RPC_INVALID_PARAMS, "approval requires chat, text, requestId");
        }
        const refs = await pick(p.chat).send(p.chat, {
          blocks: [
            { kind: "markdown", text: p.text },
            {
              kind: "buttons",
              buttons: [
                { id: "approve", label: "Approve", style: "primary", value: p.requestId },
                { id: "deny", label: "Deny", style: "danger", value: p.requestId },
              ],
            },
          ],
        });
        return { refs };
      }
      case "typing": {
        const p = requireParams(params) as { chat: ChatRef };
        if (!p.chat) throw new RpcFail(RPC_INVALID_PARAMS, "typing requires chat");
        await pick(p.chat).typing(p.chat);
        return { ok: true };
      }
      case "delete": {
        const p = requireParams(params) as unknown as EditParams;
        if (!p.ref) throw new RpcFail(RPC_INVALID_PARAMS, "delete requires ref");
        await pick(p.ref.chat).delete(p.ref);
        return { ok: true };
      }
      default:
        throw new RpcFail(RPC_METHOD_NOT_FOUND, `unknown method ${method}`);
    }
  };

  const handleDraft = async (p: DraftParams, client: ClientState): Promise<unknown> => {
    if (p.op === "start") {
      if (!p.chat) throw new RpcFail(RPC_INVALID_PARAMS, "draft.start requires chat");
      const handle = await pick(p.chat).draft(p.chat, { replyTo: p.replyTo });
      draftSeq += 1;
      const id = `draft-${draftSeq}`;
      drafts.set(id, { id, handle });
      client.drafts.add(id);
      return { draftId: id };
    }
    const rec = p.draftId ? drafts.get(p.draftId) : undefined;
    if (!rec || !client.drafts.has(rec.id)) throw new RpcFail(RPC_APP, `unknown draftId ${p.draftId ?? ""}`);
    if (p.op === "append") {
      rec.handle.append(p.delta ?? "");
      return { ok: true };
    }
    if (p.op === "status") {
      rec.handle.setStatus(p.text ?? "");
      return { ok: true };
    }
    if (p.op === "finalize") {
      const refs = await rec.handle.finalize(p.msg);
      drafts.delete(rec.id);
      client.drafts.delete(rec.id);
      return { refs };
    }
    if (p.op === "abort") {
      await rec.handle.abort(p.note);
      drafts.delete(rec.id);
      client.drafts.delete(rec.id);
      return { ok: true };
    }
    throw new RpcFail(RPC_INVALID_PARAMS, `unknown draft op ${p.op}`);
  };

  return {
    handleLine: handle,
    addWriter: (write, opts) => {
      addClient(write, opts?.subscribe === true);
      return () => {
        const state = clients.get(write);
        if (state) {
          for (const id of state.drafts) drafts.delete(id);
        }
        clients.delete(write);
      };
    },
    subscribe: (write) => {
      addClient(write, true).subscribed = true;
    },
    unsubscribe: (write) => {
      const c = clients.get(write);
      if (c) c.subscribed = false;
    },
    async start(signal) {
      if (signal.aborted) { await stop(); return; }
      const onAbort = () => { void stop(); };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await bridge?.start();
        if (!signal.aborted) await Promise.all(adapters.map((a) => a.start(signal)));
      } finally {
        signal.removeEventListener("abort", onAbort);
        await stop();
      }
    },
    stop,
  };
}
