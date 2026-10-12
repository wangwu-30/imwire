import type { ChatRef, UserRef } from "@imwire/core";

export interface OwnerAllowlistEntry {
  platform: string;
  accountId: string;
  userId: string;
  name?: string;
}

export interface LogMessage {
  id: string;
  seq: number;
  role: "user" | "assistant" | "system";
  text: string;
  surface?: ChatRef;
  createdAt: number;
  /** a2h: `agent:<name>` for agent-authored messages; undefined for humans and pi. */
  author?: string;
  /** a2h: the request this message belongs to (prompt or answer). */
  requestId?: string;
}

export interface ConversationSnapshot {
  id: string;
  personId?: string;
  groupKey?: string;
  title: string;
  isDefault: boolean;
  messages: LogMessage[];
}

export interface ConversationMeta {
  id: string;
  personId?: string;
  groupKey?: string;
  title: string;
  isDefault: boolean;
}

/** Chosen button id. Allow-like options (`approve`, `allow_once`, …) grant; unknown ids deny. */
export type ApprovalDecision = string;

export interface UserTurn {
  text: string;
  source: { chat: ChatRef; from: UserRef };
}

export interface ApprovalRequest {
  toolCallId: string;
  title: string;
  options: string[];
}

export interface TurnSink {
  text(delta: string): void;
  status(s: string): void;
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface TurnResult {
  text: string;
}

export interface AgentDriver {
  ensureSession(conv: ConversationSnapshot): Promise<{ agentSessionId: string }>;
  prompt(sessionId: string, input: UserTurn, sink: TurnSink): Promise<TurnResult>;
  steer?(sessionId: string, input: UserTurn): Promise<boolean>;
  cancel(sessionId: string): Promise<void>;
}

export interface PersonRecord {
  id: string;
  name?: string;
}

export interface IdentityRecord {
  platform: string;
  accountId: string;
  userId: string;
  personId: string;
}

export interface PendingApproval {
  id: string;
  conversationId: string;
  toolCallId: string;
  title: string;
  options: string[];
  version: number;
  state: "pending" | "approved" | "denied";
  requestedBy?: string;
  chosen?: string;
  decidedBy?: string;
  decidedAt?: number;
  createdAt?: number;
  /** a2h: only this person may decide. Falls back to the conversation owner when unset. */
  targetPersonId?: string;
  /** Persisted TTL (epoch ms). The sweeper denies the approval once it passes. */
  expiresAt?: number;
  source?: "pi" | "agent";
  cards: Array<{ chat: ChatRef; messageId: string }>;
}

export type A2hScope = "send" | "ask" | "approve" | "read" | "read_all";
export type A2hRequestKind = "message" | "ask" | "approval";
export type A2hTerminalState =
  | "approved"
  | "denied"
  | "answered"
  | "delivered"
  | "expired"
  | "cancelled"
  | "failed";

export interface AgentRecord {
  id: string;
  name: string;
  createdAt: number;
  revokedAt?: number;
}

export interface A2hRequest {
  id: string;
  agentId: string;
  personId: string;
  conversationId: string;
  kind: A2hRequestKind;
  state: "pending" | A2hTerminalState;
  payload: unknown;
  answer?: unknown;
  approvalId?: string;
  idempotencyKey?: string;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  decidedBy?: string;
  version: number;
}

export function isExplicitApprove(option: string): boolean {
  return /^(approve|approved|allow|allow_once|allow_always|yes)$/i.test(option.trim());
}

export function isDenyOption(option: string): boolean {
  return /^(deny|denied|reject|rejected|block|no)$/i.test(option.trim());
}

/** What an agent sees for one of its requests. Human text is always `untrusted`. */
export interface A2hView {
  requestId: string;
  /** Short code shown on the card and used by `/answer`. Empty for one-way messages. */
  code: string;
  kind: A2hRequestKind;
  status: A2hRequest["state"];
  /** True only for an approval explicitly approved by the target person. */
  approved: boolean;
  conversationId: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: { personId: string; via: string } | null;
  answer: { choice: string | null; text: string; via: string; at: string; untrusted: true } | null;
  /** Created during quiet hours (Q5): delivered, but never nudged. */
  quiet: boolean;
}
