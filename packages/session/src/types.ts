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

/** Chosen button id. Only `approve` / `approved` count as an explicit approve. */
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
  createdAt?: number;
  cards: Array<{ chat: ChatRef; messageId: string }>;
}

export function isExplicitApprove(option: string): boolean {
  return /^(approve|approved)$/i.test(option.trim());
}

export function isDenyOption(option: string): boolean {
  return /^(deny|denied|reject|rejected|block|no)$/i.test(option.trim());
}
