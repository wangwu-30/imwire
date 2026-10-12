import type { Logger } from "@imwire/core";
import { A2hError, type A2hView, type SessionGateway } from "@imwire/session";
import { RpcFail, RPC_APP, RPC_INVALID_PARAMS, RPC_METHOD_NOT_FOUND } from "../rpc.js";
import { authenticateAgent, tokenFingerprint } from "./tokens.js";
import type { RpcConnection } from "./unix-server.js";

export const RPC_UNAUTHORIZED = -32001;
export const DEFAULT_MAX_WAIT_S = 50;
export const DEFAULT_WAIT_S = 45;
const MAX_AUTH_FAILURES = 3;
const EVENT_POLL_MS = 250;

type P = Record<string, unknown>;

function str(p: P, k: string, required = true): string | undefined {
  const v = p[k];
  if (v === undefined || v === null) {
    if (required) throw new RpcFail(RPC_INVALID_PARAMS, `${k} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new RpcFail(RPC_INVALID_PARAMS, `${k} must be a string`);
  return v;
}
function num(p: P, k: string): number | undefined {
  const v = p[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new RpcFail(RPC_INVALID_PARAMS, `${k} must be a number`);
  return v;
}

/** snake_case wire shape of a request (design §2). */
export function wireView(v: A2hView): Record<string, unknown> {
  return {
    request_id: v.requestId,
    code: v.code,
    kind: v.kind,
    status: v.status,
    approved: v.approved,
    conversation_id: v.conversationId,
    expires_at: v.expiresAt,
    decided_at: v.decidedAt,
    decided_by: v.decidedBy ? { person_id: v.decidedBy.personId, via: v.decidedBy.via } : null,
    answer: v.answer,
    quiet: v.quiet,
    required_level: v.requiredLevel,
    decided_level: v.decidedLevel,
    step_up_required: v.stepUpRequired,
    ...(v.status === "pending"
      ? { next: "NOT approved. Do not proceed. Call a2h.wait with this request_id until a final status." }
      : {}),
  };
}

/**
 * `a2h.*` JSON-RPC methods. The agent identity comes only from the token
 * (re-validated against the DB on every call), never from params.
 */
export class A2hRpc {
  private readonly maxWaitS: number;
  private readonly now: () => number;
  private readonly logger?: Logger;
  private readonly extra = new Map<string, (conn: RpcConnection, agentId: string, p: P) => Promise<unknown>>();

  constructor(
    readonly gw: SessionGateway,
    opts: { maxWaitS?: number; now?: () => number; logger?: Logger } = {},
  ) {
    this.maxWaitS = opts.maxWaitS ?? DEFAULT_MAX_WAIT_S;
    this.now = opts.now ?? (() => Date.now());
    this.logger = opts.logger;
  }

  /** Extension point (PR 3b registers tool-policy / action methods). */
  register(method: string, fn: (conn: RpcConnection, agentId: string, p: P) => Promise<unknown>): void {
    this.extra.set(method, fn);
  }

  handle = async (conn: RpcConnection, method: string, params: unknown): Promise<unknown> => {
    const p = (params && typeof params === "object" ? params : {}) as P;
    if (method === "a2h.auth") return this.auth(conn, p);
    const agentId = this.requireAgent(conn, method);
    try {
      return await this.dispatch(conn, agentId, method, p);
    } catch (err) {
      if (err instanceof A2hError) throw new RpcFail(RPC_APP, err.message, { code: err.code });
      throw err;
    }
  };

  private auth(conn: RpcConnection, p: P): unknown {
    const token = str(p, "token")!;
    const res = authenticateAgent(this.gw.store, token, this.now(), conn.peer);
    if (!res.ok) {
      conn.authFailures += 1;
      this.gw.store.audit({
        at: this.now(),
        action: "auth",
        result: `auth_failed:${res.reason}`,
        agentId: res.agentId,
        object: "agent_token",
        detail: { fingerprint: tokenFingerprint(token), peer_uid: conn.peer.uid ?? null },
      });
      if (conn.authFailures >= MAX_AUTH_FAILURES) setImmediate(() => conn.close());
      throw new RpcFail(RPC_UNAUTHORIZED, "unauthorized", { reason: res.reason });
    }
    conn.token = token;
    conn.agentId = res.agentId;
    this.gw.store.audit({
      at: this.now(),
      action: "auth",
      result: res.via === "previous" ? "ok_previous_token" : "ok",
      agentId: res.agentId,
      object: "agent_token",
      detail: { fingerprint: tokenFingerprint(token) },
    });
    return { agent: res.name, agent_id: res.agentId, via: res.via };
  }

  /** Re-check on every call so revoke/expiry are immediate. */
  private requireAgent(conn: RpcConnection, method: string): string {
    if (!conn.token) throw new RpcFail(RPC_UNAUTHORIZED, "unauthorized", { reason: "call a2h.auth first" });
    const res = authenticateAgent(this.gw.store, conn.token, this.now(), conn.peer);
    if (!res.ok) {
      this.gw.store.audit({
        at: this.now(),
        action: "auth",
        result: `auth_failed:${res.reason}`,
        agentId: res.agentId,
        object: "agent_token",
        detail: { method, fingerprint: tokenFingerprint(conn.token) },
      });
      conn.token = undefined;
      conn.agentId = undefined;
      throw new RpcFail(RPC_UNAUTHORIZED, "unauthorized", { reason: res.reason });
    }
    return res.agentId;
  }

  private waitMs(p: P): number {
    const w = num(p, "wait_s") ?? DEFAULT_WAIT_S;
    return Math.max(0, Math.min(w, this.maxWaitS)) * 1000;
  }

  /** Record the moment a final result is handed to the agent (once per request). */
  private handoff(agentId: string, views: A2hView[]): void {
    for (const v of views) {
      if (v.status === "pending") continue;
      const seen = this.gw.store.db
        .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE request_id = ? AND action = 'handoff'")
        .get(v.requestId)!.n;
      if (seen > 0) continue;
      this.gw.store.audit({
        at: this.now(),
        action: "handoff",
        result: v.status,
        agentId,
        requestId: v.requestId,
        detail: { decided_level: v.decidedLevel },
      });
    }
  }

  private async settle(agentId: string, v: A2hView, p: P): Promise<Record<string, unknown>> {
    const ms = this.waitMs(p);
    const [out] = v.status === "pending" && ms > 0 ? await this.gw.waitForRequests(agentId, [v.requestId], ms) : [v];
    this.handoff(agentId, [out!]);
    return wireView(out!);
  }

  private async dispatch(conn: RpcConnection, agentId: string, method: string, p: P): Promise<unknown> {
    const gw = this.gw;
    switch (method) {
      case "a2h.findPerson":
        return {
          people: gw.findPeople(agentId, str(p, "query", false)).map((x) => ({
            person_id: x.personId,
            name: x.name ?? null,
            reachable_via: x.reachableVia,
            allowed: x.allowed,
          })),
        };
      case "a2h.send": {
        const r = await gw.sendToPerson({
          agentId,
          to: str(p, "to")!,
          text: str(p, "text")!,
          route: str(p, "route", false),
          idempotencyKey: str(p, "idempotency_key", false),
        });
        return { ...wireView(r), message_id: r.messageId ?? null, delivered: r.delivered };
      }
      case "a2h.ask": {
        const choices = p.choices;
        if (choices !== undefined && (!Array.isArray(choices) || choices.some((c) => typeof c !== "string"))) {
          throw new RpcFail(RPC_INVALID_PARAMS, "choices must be an array of strings");
        }
        const v = await gw.askPerson({
          agentId,
          to: str(p, "to")!,
          question: str(p, "question")!,
          choices: choices as string[] | undefined,
          allowFreeText: typeof p.allow_free_text === "boolean" ? p.allow_free_text : undefined,
          expiresInS: num(p, "expires_in_s"),
          route: str(p, "route", false),
          idempotencyKey: str(p, "idempotency_key", false),
        });
        return this.settle(agentId, v, p);
      }
      case "a2h.approve": {
        const extraHandler = this.extra.get("a2h.approve");
        if (extraHandler) return extraHandler(conn, agentId, p);
        const v = await gw.createAgentApproval({
          agentId,
          to: str(p, "to")!,
          title: str(p, "title")!,
          details: str(p, "details", false),
          risk: str(p, "risk", false) as "low" | "medium" | "high" | undefined,
          expiresInS: num(p, "expires_in_s"),
          route: str(p, "route", false),
          idempotencyKey: str(p, "idempotency_key", false),
        });
        return this.settle(agentId, v, p);
      }
      case "a2h.wait": {
        const ids = p.request_ids;
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20 || ids.some((x) => typeof x !== "string")) {
          throw new RpcFail(RPC_INVALID_PARAMS, "request_ids must be 1..20 strings");
        }
        const views = await gw.waitForRequests(agentId, ids as string[], this.waitMs(p));
        this.handoff(agentId, views);
        return { results: views.map(wireView) };
      }
      case "a2h.cancel":
        return wireView(
          await gw.cancelRequest({ agentId, requestId: str(p, "request_id")!, reason: str(p, "reason", false) }),
        );
      case "a2h.readContext":
        return gw.readAgentContext({
          agentId,
          to: str(p, "to")!,
          sinceSeq: num(p, "since_seq"),
          limit: num(p, "limit"),
        });
      case "a2h.events.read": {
        const events = gw.store.eventsAfter(num(p, "cursor") ?? 0, { agentId, limit: num(p, "limit") });
        return { events: events.map(wireEvent), cursor: events.at(-1)?.id ?? num(p, "cursor") ?? 0 };
      }
      case "a2h.events.subscribe":
        return this.subscribe(conn, agentId, num(p, "cursor") ?? 0);
      default: {
        const fn = this.extra.get(method);
        if (fn) return fn(conn, agentId, p);
        throw new RpcFail(RPC_METHOD_NOT_FOUND, `unknown method ${method}`);
      }
    }
  }

  /**
   * Push `a2h.event` notifications for this agent's events after `cursor`.
   * Polls the DB so events written by other processes (CLI) are included.
   */
  private subscribe(conn: RpcConnection, agentId: string, cursor: number): unknown {
    let last = cursor;
    const tick = () => {
      if (!conn.token) return; // revoked/expired: stop pushing
      try {
        for (;;) {
          const batch = this.gw.store.eventsAfter(last, { agentId, limit: 200 });
          if (batch.length === 0) break;
          for (const e of batch) conn.notify("a2h.event", wireEvent(e));
          last = batch.at(-1)!.id;
        }
      } catch (err) {
        this.logger?.warn("event subscription tick failed", { err: String(err) });
      }
    };
    const timer = setInterval(tick, EVENT_POLL_MS);
    timer.unref?.();
    conn.onClose(() => clearInterval(timer));
    setImmediate(tick);
    return { subscribed: true, cursor };
  }
}

/** Neutral event wire shape (schema v1). */
export function wireEvent(e: import("@imwire/session").A2hEvent): Record<string, unknown> {
  return {
    v: e.v,
    cursor: e.id,
    at: e.at,
    agent_id: e.agentId ?? null,
    action: e.action,
    person_id: e.personId ?? null,
    request_id: e.requestId ?? null,
    object: e.object ?? null,
    binding_hash: e.bindingHash ?? null,
    decision: e.decision,
    detail: e.detail ?? null,
  };
}
