import { createHash, randomBytes } from "node:crypto";
import { canonicalJson, isoLocal } from "./a2h.js";

/**
 * agent-protocol v0 §4.1 event envelope (CloudEvents 1.0 + extensions).
 * Unsigned in this version: `integrity` carries only a digest of `data`.
 */
export interface EventEnvelope {
  specversion: "1.0";
  /** Globally unique; a redelivery reuses it. */
  id: string;
  source: string;
  type: string;
  subject: string;
  /** occurred_at */
  time: string;
  /** when the hub appended it */
  recordedat: string;
  /** log position (cursor) */
  seq: number;
  attempt: number;
  idempotencykey?: string;
  correlationid?: string;
  causationid?: string;
  dataschema: string;
  datacontenttype: "application/json";
  /** imwire event-log schema version */
  v: number;
  integrity: { digest: string };
  data: Record<string, unknown>;
}

export const ENVELOPE_SCHEMA = "collab/v0";

/** `evt_` + 12 hex ms + 20 hex random: sortable, globally unique. */
export function newEventId(now: number): string {
  return `evt_${Math.max(0, now).toString(16).padStart(12, "0")}${randomBytes(10).toString("hex")}`;
}

export function dataDigest(data: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(data)).digest("hex")}`;
}

const TYPES: Record<string, { type: string; schema: string }> = {
  send: { type: "collab.message.sent.v0", schema: "collab/v0/message" },
  reply: { type: "collab.message.received.v0", schema: "collab/v0/message" },
  ask: { type: "collab.request.created.v0", schema: "collab/v0/request" },
  approve: { type: "collab.request.created.v0", schema: "collab/v0/request" },
  cancel: { type: "collab.request.cancelled.v0", schema: "collab/v0/request" },
  expire: { type: "collab.request.expired.v0", schema: "collab/v0/request" },
  decision: { type: "collab.decision.recorded.v0", schema: "collab/v0/decision" },
  answer: { type: "collab.decision.recorded.v0", schema: "collab/v0/decision" },
  receipt: { type: "collab.receipt.recorded.v0", schema: "collab/v0/receipt" },
};

/** Types outside v0 §3 live under the `imwire.a2h.*` namespace. */
export function eventType(action: string): { type: string; schema: string } {
  return TYPES[action] ?? { type: `imwire.a2h.${action.replace(/[^a-z0-9_]/gi, "_")}.v0`, schema: "imwire/a2h/v0/event" };
}

const SYSTEM_ACTIONS = new Set(["expire", "execution_unknown", "handoff", "auth", "tool_check", "action_verify_sweep"]);
const HUMAN_ACTIONS = new Set(["click", "answer", "decision", "step_up", "claim", "pair", "reply"]);

export function eventSource(hubId: string, e: { action: string; agentId?: string; personId?: string; source?: string }): string {
  if (e.source) return e.source;
  const system = `actor:system:hub-${hubId}`;
  if (SYSTEM_ACTIONS.has(e.action)) return system;
  if (HUMAN_ACTIONS.has(e.action) && e.personId) return `actor:person:${e.personId}`;
  if (e.agentId) return `actor:agent:${e.agentId}`;
  if (e.personId) return `actor:person:${e.personId}`;
  return system;
}

export function eventSubject(e: { requestId?: string; object?: string; agentId?: string; personId?: string }): string {
  if (e.requestId) return `request:${e.requestId}`;
  if (e.object) return e.object.includes(":") ? e.object : `object:${e.object}`;
  if (e.agentId) return `agent:${e.agentId}`;
  if (e.personId) return `person:${e.personId}`;
  return "hub";
}

export function isoTime(ms: number): string {
  return isoLocal(ms);
}
