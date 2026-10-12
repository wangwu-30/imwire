import { randomBytes, randomInt } from "node:crypto";
import { SessionStore, TotpVerifier, type A2hScope, type TotpEnrollment } from "@imwire/session";
import {
  DEFAULT_TOKEN_TTL_MS,
  MAX_TOKEN_TTL_MS,
  ROTATE_OVERLAP_MS,
  hashToken,
  mintToken,
  tokenFingerprint,
} from "./tokens.js";

/**
 * Admin operations behind `imwire agent|owner|audit`. They work on the DB
 * directly (no adapters, no boot-time expiry), so they are safe to run next
 * to a live hub. Every state change is audited; no secret is ever audited.
 */
export class HubAdmin {
  constructor(
    readonly store: SessionStore,
    private readonly masterKey: Buffer | undefined,
    private readonly now: () => number = () => Date.now(),
  ) {}

  totp(): TotpVerifier {
    if (!this.masterKey) throw new Error("master key not available (run `imwire owner init` first or pass --master-key)");
    return new TotpVerifier({ store: this.store, masterKey: this.masterKey });
  }

  // ---- owner -------------------------------------------------------------

  /** Step 1: nothing stored yet. The caller shows secret/URL/recovery codes once. */
  prepareOwner(name: string, account?: string): TotpEnrollment & { secret: Buffer } {
    if (!name.trim()) throw new Error("owner name is required");
    return this.totp().prepareEnrollment(account ?? name);
  }

  /**
   * Step 2: the human typed one current code. Creates the person, stores the
   * sealed secret + recovery hashes, burns the confirming step and issues a
   * one-time claim code for `/claim <code> <totp>` in the IM DM.
   */
  commitOwner(
    name: string,
    prepared: TotpEnrollment & { secret: Buffer },
    code: string,
    claimTtlMs = 10 * 60_000,
  ): { personId: string; claimCode: string } {
    const v = this.totp();
    const now = this.now();
    if (!v.confirmEnrollmentCode(prepared, code, now)) {
      this.store.audit({ at: now, action: "owner_init", result: "bad_confirm_code", object: "owner" });
      throw new Error("code does not match; nothing was saved");
    }
    const person = this.store.createPerson(name.trim(), now);
    this.store.defaultConversation(person.id, now);
    v.commitEnrollment(person.id, prepared, now, code);
    const claimCode = String(randomInt(0, 100_000_000)).padStart(8, "0");
    this.store.createOwnerClaim(person.id, claimCode, now, claimTtlMs);
    this.store.audit({ at: now, action: "owner_init", result: "ok", personId: person.id, object: "owner" });
    return { personId: person.id, claimCode };
  }

  /** Re-enrol TOTP for an existing person; needs a current code (or recovery code) when one exists. */
  prepareReenroll(personId: string, proof: string | undefined): TotpEnrollment & { secret: Buffer } {
    const person = this.store.getPerson(personId);
    if (!person) throw new Error("no such person");
    if (this.store.totpCredential(personId)) this.requireOwnerProof(personId, proof, "enroll_totp");
    return this.totp().prepareEnrollment(person.name ?? personId);
  }

  commitReenroll(personId: string, prepared: TotpEnrollment & { secret: Buffer }, code: string): void {
    const v = this.totp();
    const now = this.now();
    if (!v.confirmEnrollmentCode(prepared, code, now)) {
      this.store.audit({ at: now, action: "enroll_totp", result: "bad_confirm_code", personId, object: "owner" });
      throw new Error("code does not match; nothing was saved");
    }
    v.commitEnrollment(personId, prepared, now, code);
    this.store.audit({ at: now, action: "enroll_totp", result: "ok", personId, object: "owner" });
  }

  /**
   * `imwire owner reset`: lost/compromised IM account. Unlinks every IM
   * identity, cancels the person's open requests (DB only; cards are edited
   * by the hub's sweeper/restart pass) and issues a fresh claim code.
   */
  resetOwner(personId: string, proof: string | undefined, claimTtlMs = 10 * 60_000): { claimCode: string; unlinked: number; cancelled: number } {
    if (!this.store.getPerson(personId)) throw new Error("no such person");
    this.requireOwnerProof(personId, proof, "owner_reset");
    const now = this.now();
    const unlinked = this.store.unlinkAllIdentities(personId);
    let cancelled = 0;
    for (const r of this.store.pendingA2hRequests().filter((x) => x.personId === personId)) {
      if (this.cancelInDb(r, "owner_reset", now)) cancelled += 1;
    }
    const claimCode = String(randomInt(0, 100_000_000)).padStart(8, "0");
    this.store.createOwnerClaim(personId, claimCode, now, claimTtlMs);
    this.store.audit({ at: now, action: "owner_reset", result: "ok", personId, object: "owner", detail: { unlinked, cancelled } });
    return { claimCode, unlinked, cancelled };
  }

  /** A current TOTP or an unused recovery code. Failures count towards lockout. */
  requireOwnerProof(personId: string, proof: string | undefined, action: string): void {
    const v = this.totp();
    const now = this.now();
    const p = (proof ?? "").trim();
    let ok = false;
    if (/^\d{6}$/.test(p)) ok = v.checkCode(personId, p, now).ok;
    else if (p) ok = v.useRecoveryCode(personId, p, now);
    if (!ok) {
      this.store.audit({ at: now, action, result: "denied:bad_proof", personId, object: "owner" });
      throw new Error("owner verification failed (TOTP or recovery code required)");
    }
  }

  /** The single owner person the CLI acts for (first TOTP-enrolled person, or --person). */
  ownerId(explicit?: string): string {
    if (explicit) return explicit;
    const row = this.store.db
      .prepare<{ person_id: string }>("SELECT person_id FROM person_credential WHERE kind = 'totp' AND revoked_at IS NULL ORDER BY created_at LIMIT 1")
      .get();
    if (!row) throw new Error("no owner enrolled; run `imwire owner init`");
    return row.person_id;
  }

  // ---- agents ------------------------------------------------------------

  addAgent(opts: {
    name: string;
    grantTo: string;
    scopes: A2hScope[];
    ttlMs?: number;
    bindUid?: number;
    ownerProof: string | undefined;
  }): { agentId: string; token: string; expiresAt: number } {
    this.requireOwnerProof(opts.grantTo, opts.ownerProof, "agent_add");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(opts.name)) throw new Error("agent name: 1-40 chars [A-Za-z0-9_.-]");
    if (this.store.agentByName(opts.name)) throw new Error(`agent ${opts.name} already exists`);
    const ttl = Math.min(opts.ttlMs ?? DEFAULT_TOKEN_TTL_MS, MAX_TOKEN_TTL_MS);
    const now = this.now();
    const agent = this.store.createAgent(opts.name, `unset:${randomBytes(16).toString("hex")}`, now);
    const token = mintToken(agent.id);
    this.store.setAgentToken(agent.id, hashToken(token), now + ttl);
    if (opts.bindUid !== undefined) this.store.setAgentLifecycle(agent.id, { bind: `unix:uid=${opts.bindUid}` });
    this.store.setAgentGrant(agent.id, opts.grantTo, opts.scopes);
    this.store.audit({
      at: now,
      action: "agent_add",
      result: "ok",
      agentId: agent.id,
      personId: opts.grantTo,
      object: `agent:${opts.name}`,
      detail: { fingerprint: tokenFingerprint(token), scopes: opts.scopes, expires_at: now + ttl },
    });
    return { agentId: agent.id, token, expiresAt: now + ttl };
  }

  rotateAgent(nameOrId: string, ownerProof: string | undefined, ttlMs?: number): { token: string; expiresAt: number; previousValidUntil: number } {
    const agent = this.resolveAgent(nameOrId);
    this.requireOwnerProof(this.ownerId(), ownerProof, "agent_rotate");
    const now = this.now();
    const ttl = Math.min(ttlMs ?? DEFAULT_TOKEN_TTL_MS, MAX_TOKEN_TTL_MS);
    const token = mintToken(agent.id);
    const prevUntil = now + ROTATE_OVERLAP_MS;
    if (!this.store.rotateAgentToken(agent.id, hashToken(token), now + ttl, prevUntil)) {
      throw new Error("agent is revoked");
    }
    this.store.audit({
      at: now,
      action: "agent_rotate",
      result: "ok",
      agentId: agent.id,
      object: `agent:${agent.name}`,
      detail: { fingerprint: tokenFingerprint(token), previous_valid_until: prevUntil },
    });
    return { token, expiresAt: now + ttl, previousValidUntil: prevUntil };
  }

  /** Immediate: the hub re-checks the token on every call. Open requests are cancelled. */
  revokeAgent(nameOrId: string): { cancelled: number } {
    const agent = this.resolveAgent(nameOrId);
    const now = this.now();
    this.store.revokeAgent(agent.id, now);
    let cancelled = 0;
    for (const r of this.store.pendingA2hRequests().filter((x) => x.agentId === agent.id)) {
      if (this.cancelInDb(r, "agent_revoked", now)) cancelled += 1;
    }
    this.store.audit({ at: now, action: "agent_revoke", result: "ok", agentId: agent.id, object: `agent:${agent.name}`, detail: { cancelled } });
    return { cancelled };
  }

  /** Per-agent downgrade (`im_account`) or reset to default (`verified`). */
  setAgentLevel(nameOrId: string, level: "im_account" | "verified", ownerProof: string | undefined): void {
    const agent = this.resolveAgent(nameOrId);
    this.requireOwnerProof(this.ownerId(), ownerProof, "agent_level");
    this.store.setAgentApprovalLevel(agent.id, level === "verified" ? null : level);
    this.store.audit({ at: this.now(), action: "agent_level", result: level, agentId: agent.id, object: `agent:${agent.name}` });
  }

  listAgents(): ReturnType<SessionStore["listAgents"]> {
    return this.store.listAgents();
  }

  /**
   * Fail-closed cancel from a process without adapters: approvals are denied
   * (a later click loses the version CAS), asks are cancelled. Cards on IM
   * keep their buttons until the hub next edits them.
   */
  private cancelInDb(r: { id: string; kind: string; approvalId?: string }, why: string, now: number): boolean {
    if (r.kind === "approval" && r.approvalId) {
      const d = this.store.decideApproval(r.approvalId, "denied", why, now, "deny");
      this.store.decideA2hRequest(r.id, "cancelled", why, now);
      return Boolean(d);
    }
    return Boolean(this.store.decideA2hRequest(r.id, "cancelled", why, now));
  }

  resolveAgent(nameOrId: string): { id: string; name: string } {
    const a = this.store.agentByName(nameOrId) ?? this.store.getAgent(nameOrId);
    if (!a) throw new Error(`no such agent: ${nameOrId}`);
    return a;
  }
}
