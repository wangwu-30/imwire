import type { ChatRef, DraftHandle, Inbound, MsgRef, OutMessage } from "@imwire/core";
import { RPC_INVALID_REQUEST, RpcFail } from "./rpc.js";

export const PROTOCOL_VERSION = "1.0";
export const MAX_RPC_BYTES = 1_048_576;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcSuccess | JsonRpcError | JsonRpcNotification;

export function parseRpc(raw: string): JsonRpcRequest {
  let rec: unknown;
  try {
    rec = JSON.parse(raw);
  } catch {
    throw new RpcFail(-32700, "parse error");
  }
  if (Array.isArray(rec)) {
    throw new RpcFail(RPC_INVALID_REQUEST, "batch requests are not supported");
  }
  if (!rec || typeof rec !== "object") {
    throw new RpcFail(RPC_INVALID_REQUEST, "invalid JSON-RPC request");
  }
  const obj = rec as JsonRpcRequest;
  if (obj.jsonrpc !== "2.0" || typeof obj.method !== "string") {
    throw new RpcFail(RPC_INVALID_REQUEST, "invalid JSON-RPC request");
  }
  return obj;
}

export function rpcResult(id: string | number | null | undefined, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function rpcError(code: number, message: string, data?: unknown, id: string | number | null = null): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

export function eventNote(event: Inbound, platform: string, accountId: string): JsonRpcNotification {
  const { raw: _raw, ...rest } = event;
  return { jsonrpc: "2.0", method: "event", params: { platform, accountId, event: rest } };
}

export interface DraftRecord {
  id: string;
  handle: DraftHandle;
}

export interface SendParams {
  chat: ChatRef;
  msg: OutMessage;
}

export interface EditParams {
  ref: MsgRef;
  msg: OutMessage;
}

export interface DraftParams {
  op: "start" | "append" | "status" | "finalize" | "abort";
  chat?: ChatRef;
  replyTo?: MsgRef;
  draftId?: string;
  delta?: string;
  text?: string;
  msg?: OutMessage;
  note?: string;
}

export interface ApprovalParams {
  chat: ChatRef;
  text: string;
  requestId: string;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
