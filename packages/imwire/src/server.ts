import type { Adapter, ChatRef, Inbound } from "@imwire/core";
import {
  PROTOCOL_VERSION,
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

export interface ServeOptions {
  adapters: Adapter[];
  write?: (msg: JsonRpcMessage) => void;
}

export interface ServeHost {
  handleLine: (line: string) => Promise<void>;
  addWriter: (write: (msg: JsonRpcMessage) => void) => () => void;
  start: (signal: AbortSignal) => Promise<void>;
  stop: () => void;
}

export function createServeHost(opts: ServeOptions): ServeHost {
  const drafts = new Map<string, DraftRecord>();
  let draftSeq = 0;
  const adapters = opts.adapters;
  const writers = new Set<(msg: JsonRpcMessage) => void>();
  if (opts.write) writers.add(opts.write);
  const emit = (msg: JsonRpcMessage): void => {
    for (const write of writers) write(msg);
  };

  const pick = (chat: ChatRef): Adapter => {
    const found = adapters.find((a) => a.platform === chat.platform && a.accountId === chat.accountId);
    if (found) return found;
    const byPlatform = adapters.find((a) => a.platform === chat.platform);
    if (byPlatform) return byPlatform;
    throw new Error(`no adapter for ${chat.platform}:${chat.accountId}`);
  };

  for (const adapter of adapters) {
    adapter.on(async (event: Inbound) => {
      emit(eventNote(event, adapter.platform, adapter.accountId));
    });
  }

  const handle = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try {
      req = parseRpc(trimmed);
    } catch (err) {
      emit(rpcError(-32700, err instanceof Error ? err.message : "parse error"));
      return;
    }
    const id = req.id ?? null;
    try {
      const result = await dispatch(req.method, req.params);
      if (req.id !== undefined) emit(rpcResult(id, result));
    } catch (err) {
      emit(rpcError(-32000, err instanceof Error ? err.message : String(err), undefined, id));
    }
  };

  const dispatch = async (method: string, params: unknown): Promise<unknown> => {
    switch (method) {
      case "hello":
      case "initialize":
        return {
          protocolVersion: PROTOCOL_VERSION,
          platforms: adapters.map((a) => ({
            platform: a.platform,
            accountId: a.accountId,
            capabilities: a.capabilities,
          })),
        };
      case "send": {
        const p = params as SendParams;
        const refs = await pick(p.chat).send(p.chat, p.msg);
        return { refs };
      }
      case "edit": {
        const p = params as EditParams;
        await pick(p.ref.chat).edit(p.ref, p.msg);
        return { ok: true };
      }
      case "draft":
        return handleDraft(params as DraftParams);
      case "approval": {
        const p = params as ApprovalParams;
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
        const p = params as { chat: ChatRef };
        await pick(p.chat).typing(p.chat);
        return { ok: true };
      }
      case "delete": {
        const p = params as EditParams;
        await pick(p.ref.chat).delete(p.ref);
        return { ok: true };
      }
      default:
        throw new Error(`unknown method ${method}`);
    }
  };

  const handleDraft = async (p: DraftParams): Promise<unknown> => {
    if (p.op === "start") {
      if (!p.chat) throw new Error("draft.start requires chat");
      const handle = await pick(p.chat).draft(p.chat, { replyTo: p.replyTo });
      draftSeq += 1;
      const id = `draft-${draftSeq}`;
      drafts.set(id, { id, handle });
      return { draftId: id };
    }
    const rec = p.draftId ? drafts.get(p.draftId) : undefined;
    if (!rec) throw new Error(`unknown draftId ${p.draftId ?? ""}`);
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
      return { refs };
    }
    if (p.op === "abort") {
      await rec.handle.abort(p.note);
      drafts.delete(rec.id);
      return { ok: true };
    }
    throw new Error(`unknown draft op ${p.op}`);
  };

  return {
    handleLine: handle,
    addWriter: (write: (msg: JsonRpcMessage) => void) => {
      writers.add(write);
      return () => {
        writers.delete(write);
      };
    },
    async start(signal) {
      await Promise.all(adapters.map((a) => a.start(signal)));
    },
    stop() {
      drafts.clear();
      writers.clear();
    },
  };
}
