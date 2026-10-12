import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionStore, canonicalJson, type EventEnvelope } from "@imwire/session";
import { action, cmd } from "../../session/tests/helpers.js";
import { addAgent, client, dump, rpcError, world, type World } from "./hub-world.js";

const DEPLOY = { op: "deploy", service: "api", commit: "3360b9a" };

async function approve(w: World, requestId: string, code: string): Promise<void> {
  const approvalId = w.hub.gw.store.getA2hRequest(requestId)!.approvalId!;
  await w.tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: approvalId }));
  await w.tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "approve", args: `${code} ${w.code()}` }));
  await w.hub.gw.waitForIdle();
  w.next();
}

function eventsOf(w: World, requestId: string): EventEnvelope[] {
  return w.hub.gw.store.envelopesAfter(0, { limit: 500 }).filter((e) => e.data.request === requestId);
}

describe("v0 envelope export", () => {
  it("every event is a CloudEvents 1.0 envelope with unique id, source, type, subject, digest and a causation chain", async () => {
    const w = await world();
    const { token, agentId } = addAgent(w);
    const c = await client(w, token);
    const r = await c.call<Record<string, string>>("a2h.approve", {
      to: w.ownerId,
      title: "deploy api",
      grant: "once",
      object: { ref: "git:imwire@3360b9a", digest: "3360b9a0c5e1f2d3a4b5c6d7e8f9a0b1c2d3e4f5" },
      state_version: "17",
      action_name: "deploy",
      consequences: { approve: "部署到 prod", deny: "保持现状" },
      wait_s: 0,
    });
    await approve(w, r.request_id!, r.code!);
    await c.call("a2h.wait", { request_ids: [r.request_id], wait_s: 0 });

    const all = w.hub.gw.store.envelopesAfter(0, { limit: 500 });
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    for (const e of all) {
      expect(e).toMatchObject({ specversion: "1.0", attempt: 1, datacontenttype: "application/json", v: 1 });
      expect(e.id).toMatch(/^evt_[0-9a-f]{32}$/);
      expect(e.source).toMatch(/^actor:(agent|person|system):/);
      expect(e.type).toMatch(/^(collab|imwire\.a2h)\.[a-z_.]+\.v0$/);
      expect(e.subject.length).toBeGreaterThan(0);
      expect(e.time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+08:00$/);
      expect(e.recordedat).toMatch(/\+08:00$/);
      expect(e.integrity.digest).toBe(`sha256:${createHash("sha256").update(canonicalJson(e.data)).digest("hex")}`);
      expect(e).not.toHaveProperty("integrity.sig");
    }

    const mine = eventsOf(w, r.request_id!);
    for (const e of mine) {
      expect(e.subject).toBe(`request:${r.request_id}`);
      expect(e.correlationid).toBe(`req:${r.request_id}`);
    }
    // each event of the request points at the previous one
    for (let i = 1; i < mine.length; i += 1) expect(mine[i]!.causationid).toBe(mine[i - 1]!.id);

    const created = mine.find((e) => e.type === "collab.request.created.v0")!;
    expect(created.source).toBe(`actor:agent:${agentId}`);
    expect(created.idempotencykey).toBeUndefined();
    expect(created.data).toMatchObject({
      kind: "approval",
      to: `person:${w.ownerId}`,
      object: { ref: "git:imwire@3360b9a", digest: "digest:3360b9a0c5e1f2d3a4b5c6d7e8f9a0b1c2d3e4f5" },
      state_version: "17",
      action: "deploy",
      grant: { kind: "once" },
      options: [
        { id: "approve", label: "批准", consequence: "部署到 prod" },
        { id: "deny", label: "拒绝", consequence: "保持现状" },
      ],
    });

    const decision = mine.find((e) => e.type === "collab.decision.recorded.v0")!;
    expect(decision.source).toBe(`actor:person:${w.ownerId}`);
    expect(decision.idempotencykey).toBe(`dec:${r.request_id}`);
    expect(decision.data).toMatchObject({
      decision: "approved",
      decided_by: `person:${w.ownerId}`,
      channel: "telegram:dm",
      scope: { object: "git:imwire@3360b9a", action: "deploy" },
      state_version: "17",
      grant: { kind: "once" },
    });
    // quote is recorded with the TOTP masked
    expect(String(decision.data.quote)).toContain(`/approve ${r.code}`);
    expect(String(decision.data.quote)).not.toMatch(/\d{6}/);

    // RPC read and subscribe emit the same envelopes
    const viaRpc = await c.call<{ events: EventEnvelope[] }>("a2h.events.read", { cursor: 0, limit: 500 });
    expect(viaRpc.events.map((e) => e.id)).toEqual(all.filter((e) => e.data.agent === `agent:${agentId}`).map((e) => e.id));
    expect(viaRpc.events[0]).toEqual(all.find((e) => e.id === viaRpc.events[0]!.id));
  });

  it("legacy rows (pre-v0) get a deterministic id and digest; reads are stable", async () => {
    const w = await world();
    w.hub.gw.store.db
      .prepare("INSERT INTO audit_log(at, action, result, detail) VALUES (?, 'grant', 'ok', NULL)")
      .run(w.clock.now());
    const read = () => w.hub.gw.store.envelopesAfter(0, { limit: 500 }).at(-1)!;
    const a = read();
    const b = read();
    expect(a.id).toMatch(new RegExp(`^evt_legacy_${w.hub.gw.store.hubId}_${a.seq}$`));
    expect(a).toEqual(b);
    expect(a.type).toBe("imwire.a2h.grant.v0");
  });

  it("time (occurred) and recordedat are separate", async () => {
    const w = await world();
    const { token } = addAgent(w);
    const c = await client(w, token);
    const r = await c.call<Record<string, string>>("a2h.approve", { to: w.ownerId, title: "x", grant: "once", wait_s: 0 });
    await approve(w, r.request_id!, r.code!);
    const ranAt = new Date(w.clock.now() - 10 * 60_000).toISOString();
    await c.call("a2h.receipt", { request_id: r.request_id, level: "executed", result: { exit_code: 0 }, at: ranAt });
    const e = eventsOf(w, r.request_id!).find((x) => x.type === "collab.receipt.recorded.v0")!;
    expect(Date.parse(e.time)).toBe(Date.parse(ranAt));
    expect(Date.parse(e.recordedat)).toBe(Math.floor(w.clock.now() / 1000) * 1000);
    expect(e.time).not.toBe(e.recordedat);
  });
});

describe("v0 grant", () => {
  it("is required over RPC and validated", async () => {
    const w = await world();
    const { token } = addAgent(w);
    const c = await client(w, token);
    expect((await rpcError(c.call("a2h.approve", { to: w.ownerId, title: "x", wait_s: 0 }))).code).toBe(-32602);
    expect((await rpcError(c.call("a2h.ask", { to: w.ownerId, question: "q", wait_s: 0 }))).code).toBe(-32602);
    expect((await rpcError(c.call("a2h.approve", { to: w.ownerId, title: "x", grant: "forever", wait_s: 0 }))).code).toBe(-32602);
    expect((await rpcError(c.call("a2h.approve", { to: w.ownerId, title: "x", grant: { kind: "task" }, wait_s: 0 }))).data?.code).toBe("invalid");
    const past = new Date(w.clock.now() - 1000).toISOString();
    expect((await rpcError(c.call("a2h.approve", { to: w.ownerId, title: "x", grant: { kind: "until", until: past }, wait_s: 0 }))).data?.code).toBe("invalid");
    expect(
      (await rpcError(c.call("a2h.approve", { to: w.ownerId, title: "x", risk: "critical", action: DEPLOY, grant: { kind: "task", task_id: "t1" }, wait_s: 0 })))
        .data?.code,
    ).toBe("invalid");
    const t = await c.call<Record<string, unknown>>("a2h.approve", { to: w.ownerId, title: "x", grant: { kind: "task", task_id: "T-42" }, wait_s: 0 });
    expect(t.grant).toEqual({ kind: "task", task_id: "T-42" });
    const until = new Date(w.clock.now() + 3600_000).toISOString();
    const u = await c.call<Record<string, unknown>>("a2h.approve", { to: w.ownerId, title: "y", grant: { kind: "until", until }, wait_s: 0 });
    expect((u.grant as { kind: string }).kind).toBe("until");
  });

  it("in-process calls without grant warn with request id + agent and default to once", async () => {
    const w = await world();
    const { agentId } = addAgent(w, "inproc");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const a = await w.hub.gw.createAgentApproval({ agentId, to: w.ownerId, title: "x" });
    const q = await w.hub.gw.askPerson({ agentId, to: w.ownerId, question: "q?" });
    expect(warn).toHaveBeenCalledTimes(2);
    const [m1] = warn.mock.calls[0]! as [string];
    const [m2] = warn.mock.calls[1]! as [string];
    for (const [m, id] of [[m1, a.requestId], [m2, q.requestId]] as const) {
      expect(m).toContain(id);
      expect(m).toContain("inproc");
      expect(m).toContain(agentId);
      expect(m).toContain("defaulted to once");
    }
    expect(a.grant).toEqual({ kind: "once" });
    expect(q.grant).toEqual({ kind: "once" });
    warn.mockClear();
    await w.hub.gw.createAgentApproval({ agentId, to: w.ownerId, title: "y", grant: { kind: "once" } });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("migration: requests without a grant become once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imw-mig-"));
    const db = join(dir, "old.sqlite");
    const w = await world();
    const { token } = addAgent(w);
    const c = await client(w, token);
    const r = await c.call<{ request_id: string }>("a2h.approve", { to: w.ownerId, title: "x", grant: { kind: "task", task_id: "T" }, wait_s: 0 });
    // simulate a pre-v0 DB: copy, then strip grant columns' values as an old hub would have left them
    w.hub.gw.store.db.exec(`VACUUM INTO '${db}'`);
    const old = new SessionStore(db);
    old.db.exec("UPDATE a2h_request SET grant_spec = NULL");
    expect(old.db.prepare<{ n: number }>("SELECT COUNT(*) n FROM a2h_request WHERE grant_spec IS NULL").get()!.n).toBeGreaterThan(0);
    old.close();
    const reopened = new SessionStore(db);
    expect(reopened.db.prepare<{ n: number }>("SELECT COUNT(*) n FROM a2h_request WHERE grant_spec IS NULL").get()!.n).toBe(0);
    expect(reopened.a2hMeta(r.request_id)!.grant).toEqual({ kind: "once" });
    reopened.close();
  });

  it("migration from a real pre-v0 schema adds the column and fills once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imw-mig2-"));
    const db = join(dir, "old.sqlite");
    const s1 = new SessionStore(db);
    const p = s1.createPerson("x", 1);
    const conv = s1.defaultConversation(p.id, 1);
    const ag = s1.createAgent("a", "h", 1);
    const { request } = s1.createA2hRequest({ agentId: ag.id, personId: p.id, conversationId: conv.id, kind: "approval", payload: {}, expiresAt: 2, now: 1 });
    // drop the v0 column to recreate the pre-v0 table shape
    s1.db.exec("ALTER TABLE a2h_request DROP COLUMN grant_spec");
    s1.close();
    const s2 = new SessionStore(db);
    expect(s2.a2hMeta(request.id)!.grant).toEqual({ kind: "once" });
    expect(s2.db.prepare<{ g: string }>("SELECT grant_spec g FROM a2h_request WHERE id = ?").get(request.id)!.g).toBe('{"kind":"once"}');
    s2.close();
  });
});

describe("v0 receipts", () => {
  it("received → recorded → executed, each once; results land in the event log", async () => {
    const w = await world();
    const { token } = addAgent(w);
    const c = await client(w, token);
    const r = await c.call<Record<string, string>>("a2h.approve", { to: w.ownerId, title: "x", grant: "once", wait_s: 0 });
    expect((await rpcError(c.call("a2h.receipt", { request_id: r.request_id, level: "received" }))).data?.code).toBe("invalid");
    await approve(w, r.request_id!, r.code!);
    const a = await c.call<Record<string, unknown>>("a2h.receipt", { request_id: r.request_id, level: "received" });
    expect(a).toMatchObject({ level: "received", replayed: false, execution: "pending" });
    await c.call("a2h.receipt", { request_id: r.request_id, level: "recorded" });
    const ex = await c.call<Record<string, unknown>>("a2h.receipt", {
      request_id: r.request_id,
      level: "executed",
      result: { exit_code: 0, external_id: "github:wangwu-30/imwire#run-123" },
    });
    expect(ex).toMatchObject({ level: "executed", replayed: false, execution: "executed" });
    const again = await c.call<Record<string, unknown>>("a2h.receipt", { request_id: r.request_id, level: "executed", result: { exit_code: 1 } });
    expect(again).toMatchObject({ replayed: true, event_id: ex.event_id });
    expect((await rpcError(c.call("a2h.receipt", { request_id: r.request_id, level: "done" }))).data?.code).toBe("invalid");

    const evs = eventsOf(w, r.request_id!);
    const decision = evs.find((e) => e.type === "collab.decision.recorded.v0")!;
    const receipts = evs.filter((e) => e.type === "collab.receipt.recorded.v0");
    expect(receipts.map((e) => e.data.level)).toEqual(["received", "recorded", "executed"]);
    for (const e of receipts) expect(e.data.of).toBe(decision.id);
    expect(receipts[0]!.causationid).toBe(decision.id);
    expect(receipts[2]!.data.result).toEqual({ exit_code: 0, external_id: "github:wangwu-30/imwire#run-123" });
    expect(receipts[2]!.idempotencykey).toBe(`rcpt:${r.request_id}:executed`);
    const view = await c.call<{ results: Array<Record<string, unknown>> }>("a2h.wait", { request_ids: [r.request_id], wait_s: 0 });
    expect(view.results[0]).toMatchObject({ execution: "executed", receipts: ["received", "recorded", "executed"] });
  });

  it("executed is refused for denied requests and, for critical, before verifyAction", async () => {
    const w = await world();
    const { token } = addAgent(w);
    const c = await client(w, token);
    const d = await c.call<Record<string, string>>("a2h.approve", { to: w.ownerId, title: "x", grant: "once", wait_s: 0 });
    const approvalId = w.hub.gw.store.getA2hRequest(d.request_id!)!.approvalId!;
    await w.tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "deny", value: approvalId }));
    await w.hub.gw.waitForIdle();
    expect((await rpcError(c.call("a2h.receipt", { request_id: d.request_id, level: "executed" }))).data?.code).toBe("invalid");
    await c.call("a2h.receipt", { request_id: d.request_id, level: "received" });
    const deny = eventsOf(w, d.request_id!).find((e) => e.type === "collab.decision.recorded.v0")!;
    expect(deny.data).toMatchObject({ decision: "denied", quote: "[按钮] 拒绝", channel: "telegram:dm" });

    const k = await c.call<Record<string, string>>("a2h.approve", { to: w.ownerId, title: "dep", risk: "critical", action: DEPLOY, grant: "once", wait_s: 0 });
    await approve(w, k.request_id!, k.code!);
    expect((await rpcError(c.call("a2h.receipt", { request_id: k.request_id, level: "executed" }))).data?.code).toBe("invalid");
    await c.call("a2h.verifyAction", { request_id: k.request_id, action: DEPLOY });
    expect(await c.call("a2h.receipt", { request_id: k.request_id, level: "executed", result: { exit_code: 0 } })).toMatchObject({ execution: "executed" });
  });

  it("no executed receipt 24h after the decision → unknown in the log, never done; a late receipt is flagged", async () => {
    const w = await world();
    const { token } = addAgent(w);
    const c = await client(w, token);
    const r = await c.call<Record<string, string>>("a2h.approve", { to: w.ownerId, title: "x", grant: "once", wait_s: 0 });
    const ok = await c.call<Record<string, string>>("a2h.approve", { to: w.ownerId, title: "y", grant: "once", wait_s: 0 });
    await approve(w, r.request_id!, r.code!);
    await approve(w, ok.request_id!, ok.code!);
    await c.call("a2h.receipt", { request_id: r.request_id, level: "received" });
    await c.call("a2h.receipt", { request_id: ok.request_id, level: "executed", result: { exit_code: 0 } });

    w.clock.t += 23 * 3600_000;
    w.hub.gw.sweepExpired();
    expect(eventsOf(w, r.request_id!).some((e) => e.data.action === "execution_unknown")).toBe(false);

    w.clock.t += 2 * 3600_000;
    w.hub.gw.sweepExpired();
    w.hub.gw.sweepExpired(); // idempotent
    const unk = eventsOf(w, r.request_id!).filter((e) => e.data.action === "execution_unknown");
    expect(unk).toHaveLength(1);
    expect(unk[0]).toMatchObject({ type: "imwire.a2h.execution_unknown.v0", data: { decision: "unknown", execution: "unknown", receipts: ["received"] } });
    expect(unk[0]!.source).toMatch(/^actor:system:/);
    expect(eventsOf(w, ok.request_id!).some((e) => e.data.action === "execution_unknown")).toBe(false);
    let v = await c.call<{ results: Array<Record<string, unknown>> }>("a2h.wait", { request_ids: [r.request_id], wait_s: 0 });
    expect(v.results[0]!.execution).toBe("unknown");

    const late = await c.call<Record<string, unknown>>("a2h.receipt", { request_id: r.request_id, level: "executed", result: { exit_code: 0 } });
    expect(late.execution).toBe("executed");
    const lateEv = eventsOf(w, r.request_id!).find((e) => e.data.level === "executed")!;
    expect(lateEv.data.after_unknown).toBe(true);
    v = await c.call("a2h.wait", { request_ids: [r.request_id], wait_s: 0 });
    expect(v.results[0]!.execution).toBe("executed");
  });

  it("answered asks: options carry consequences, the answer is a decision with quote, receipts work", async () => {
    const w = await world();
    const { token } = addAgent(w);
    const c = await client(w, token);
    const q = await c.call<Record<string, string>>("a2h.ask", {
      to: w.ownerId,
      question: "哪个环境？",
      grant: "once",
      choices: [{ label: "staging", consequence: "先上 staging" }, "prod"],
      wait_s: 0,
    });
    await w.tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "a2h:0", value: q.request_id }));
    await w.hub.gw.waitForIdle();
    const evs = eventsOf(w, q.request_id!);
    expect(evs.find((e) => e.type === "collab.request.created.v0")!.data.options).toEqual([
      { id: "a2h:0", label: "staging", consequence: "先上 staging" },
      { id: "a2h:1", label: "prod", consequence: "答案转给 agent" },
    ]);
    expect(evs.find((e) => e.type === "collab.decision.recorded.v0")!.data).toMatchObject({ choice: "staging", quote: "staging", channel: "telegram:dm", untrusted: true });
    expect(await c.call("a2h.receipt", { request_id: q.request_id, level: "executed" })).toMatchObject({ execution: "executed" });
  });

  it("no secrets: receipt notes and quotes are scrubbed; token/TOTP never in the log", async () => {
    const w = await world();
    const { token } = addAgent(w);
    const c = await client(w, token);
    const r = await c.call<Record<string, string>>("a2h.approve", { to: w.ownerId, title: "x", grant: "once", wait_s: 0 });
    const totpCode = w.code();
    const approvalId = w.hub.gw.store.getA2hRequest(r.request_id!)!.approvalId!;
    await w.tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: approvalId }));
    await w.tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "approve", args: `${r.code!} ${totpCode}` }));
    await w.hub.gw.waitForIdle();
    await c.call("a2h.receipt", { request_id: r.request_id, level: "executed", note: `used ${token} and code ${totpCode} otpauth://totp/x?secret=${w.secretB32}` });
    const all = dump(w) + JSON.stringify(w.hub.gw.store.envelopesAfter(0, { limit: 500 }));
    expect(all).not.toContain(token.split(".")[1]);
    expect(all).not.toContain(totpCode);
    expect(all).not.toContain(w.secretB32);
    for (const rc of w.recovery) expect(all).not.toContain(rc);
  });
});
