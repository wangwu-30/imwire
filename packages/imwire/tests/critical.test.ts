import { describe, expect, it } from "vitest";
import { action, cmd } from "../../session/tests/helpers.js";
import { checkReadOnlyName } from "../src/hub/admin.js";
import { addAgent, client, dump, rpcError, world, type World } from "./hub-world.js";

const DEPLOY = { op: "deploy", service: "api", commit: "3360b9a", env: "prod" };

async function approveWithTotp(w: World, requestId: string, code: string): Promise<void> {
  const approvalId = w.hub.gw.store.getA2hRequest(requestId)!.approvalId!;
  await w.tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: approvalId }));
  await w.tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "approve", args: `${code} ${w.code()}` }));
  await w.hub.gw.waitForIdle();
  w.next();
}

describe("risk: critical", () => {
  it("binds the action hash; verify passes once for the same object and is audited", async () => {
    const w = await world();
    const { token } = addAgent(w);
    const c = await client(w, token);
    const r = await c.call<Record<string, string>>("a2h.approve", { to: w.ownerId, title: "deploy", risk: "critical", action: DEPLOY, wait_s: 0 });
    expect(r).toMatchObject({ status: "pending", required_level: "verified", risk: "critical" });
    expect(r.binding_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    await approveWithTotp(w, r.request_id!, r.code!);
    // key order does not matter (canonical JSON)
    const reordered = { env: "prod", commit: "3360b9a", service: "api", op: "deploy" };
    const ok = await c.call<Record<string, unknown>>("a2h.verifyAction", { request_id: r.request_id, action: reordered });
    expect(ok).toMatchObject({ ok: true, binding_hash: r.binding_hash });
    const again = await c.call<Record<string, unknown>>("a2h.verifyAction", { request_id: r.request_id, action: DEPLOY });
    expect(again).toMatchObject({ ok: false, reason: "already_used" });
    const ev = w.hub.gw.store.eventsAfter(0).filter((e) => e.requestId === r.request_id);
    expect(ev.every((e) => e.bindingHash === r.binding_hash)).toBe(true);
    expect(ev.map((e) => `${e.action}:${e.decision}`)).toEqual(expect.arrayContaining(["action_verify:ok", "action_verify:rejected:already_used"]));
  });

  it("a changed object is rejected (and the rejection is audited)", async () => {
    const w = await world();
    const { token } = addAgent(w);
    const c = await client(w, token);
    const r = await c.call<Record<string, string>>("a2h.approve", { to: w.ownerId, title: "deploy", risk: "critical", action: DEPLOY, wait_s: 0 });
    await approveWithTotp(w, r.request_id!, r.code!);
    const bad = await c.call<Record<string, unknown>>("a2h.verifyAction", { request_id: r.request_id, action: { ...DEPLOY, commit: "deadbee" } });
    expect(bad).toMatchObject({ ok: false, reason: "mismatch" });
    const audit = w.hub.gw.store.eventsAfter(0).find((e) => e.decision === "rejected:mismatch");
    expect(audit).toMatchObject({ requestId: r.request_id, bindingHash: r.binding_hash });
    // the correct object still works after a mismatch
    expect(await c.call("a2h.verifyAction", { request_id: r.request_id, action: DEPLOY })).toMatchObject({ ok: true });
  });

  it("digest binding (git SHA) works the same way", async () => {
    const w = await world();
    const { token } = addAgent(w);
    const c = await client(w, token);
    const sha = "3360b9a0c5e1f2d3a4b5c6d7e8f9a0b1c2d3e4f5";
    const r = await c.call<Record<string, string>>("a2h.approve", { to: w.ownerId, title: "push", risk: "critical", action_digest: sha, wait_s: 0 });
    expect(r.binding_hash).toBe(`digest:${sha}`);
    await approveWithTotp(w, r.request_id!, r.code!);
    expect(await c.call("a2h.verifyAction", { request_id: r.request_id, action_digest: sha.replace("3360", "4460") })).toMatchObject({ ok: false, reason: "mismatch" });
    expect(await c.call("a2h.verifyAction", { request_id: r.request_id, action_digest: sha })).toMatchObject({ ok: true });
  });

  it("cannot be downgraded: agent at im_account still needs TOTP; a bare click never approves", async () => {
    const w = await world();
    const { token } = addAgent(w);
    w.admin.setAgentLevel("codex-mac", "im_account", w.code());
    w.next();
    const c = await client(w, token);
    const normal = await c.call<Record<string, string>>("a2h.approve", { to: w.ownerId, title: "low", wait_s: 0 });
    expect(normal.required_level).toBe("im_account");
    const r = await c.call<Record<string, string>>("a2h.approve", { to: w.ownerId, title: "deploy", risk: "critical", action: DEPLOY, wait_s: 0 });
    expect(r.required_level).toBe("verified");
    const approvalId = w.hub.gw.store.getA2hRequest(r.request_id!)!.approvalId!;
    await w.tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: approvalId }));
    const v = await c.call<{ results: Array<Record<string, unknown>> }>("a2h.wait", { request_ids: [r.request_id], wait_s: 0 });
    expect(v.results[0]).toMatchObject({ status: "pending", approved: false, step_up_required: true });
    expect(await c.call("a2h.verifyAction", { request_id: r.request_id, action: DEPLOY })).toMatchObject({ ok: false, reason: "not_approved" });
  });

  it("requires exactly one of action/action_digest; idempotent replay cannot re-bind", async () => {
    const w = await world();
    const { token } = addAgent(w);
    const c = await client(w, token);
    expect((await rpcError(c.call("a2h.approve", { to: w.ownerId, title: "x", risk: "critical", wait_s: 0 }))).data?.code).toBe("invalid");
    expect((await rpcError(c.call("a2h.approve", { to: w.ownerId, title: "x", action: DEPLOY, wait_s: 0 }))).data?.code).toBe("invalid");
    await c.call("a2h.approve", { to: w.ownerId, title: "x", risk: "critical", action: DEPLOY, idempotency_key: "k1", wait_s: 0 });
    const e = await rpcError(c.call("a2h.approve", { to: w.ownerId, title: "x", risk: "critical", action: { ...DEPLOY, env: "dev" }, idempotency_key: "k1", wait_s: 0 }));
    expect(e.data?.code).toBe("conflict");
  });

  it("verify on a non-critical approval is refused", async () => {
    const w = await world();
    const { token } = addAgent(w);
    const c = await client(w, token);
    const r = await c.call<Record<string, string>>("a2h.approve", { to: w.ownerId, title: "x", wait_s: 0 });
    expect(await c.call("a2h.verifyAction", { request_id: r.request_id, action: DEPLOY })).toMatchObject({ ok: false, reason: "not_critical" });
  });
});

describe("per-agent tool policy", () => {
  it("only exact allowlisted read-only tools are auto-allowed; the rest ask a human", async () => {
    const w = await world();
    const a = addAgent(w, "a1");
    const b = addAgent(w, "b1");
    w.admin.allowReadOnlyTools("a1", ["read_file", "git_status"], w.code());
    w.next();
    const ca = await client(w, a.token);
    const cb = await client(w, b.token);
    expect(await ca.call("a2h.checkTool", { tool: "read_file" })).toMatchObject({ decision: "allow" });
    expect(await ca.call("a2h.checkTool", { tool: "git_status" })).toMatchObject({ decision: "allow" });
    expect(await ca.call("a2h.checkTool", { tool: "write_file" })).toMatchObject({ decision: "ask_human" });
    expect(await ca.call("a2h.checkTool", { tool: "read_file_and_delete" })).toMatchObject({ decision: "ask_human" });
    expect(await ca.call("a2h.checkTool", { tool: "READ_FILE" })).toMatchObject({ decision: "ask_human" });
    // per-agent: b has no allowances
    expect(await cb.call("a2h.checkTool", { tool: "read_file" })).toMatchObject({ decision: "ask_human" });
    // removal is immediate
    w.admin.removeTool("a1", "read_file");
    expect(await ca.call("a2h.checkTool", { tool: "read_file" })).toMatchObject({ decision: "ask_human" });
  });

  it("agents cannot change policy over RPC; write-like names and globs cannot be allowlisted", async () => {
    const w = await world();
    const a = addAgent(w, "a1");
    const c = await client(w, a.token);
    for (const m of ["a2h.policy.set", "a2h.setToolPolicy", "a2h.policy.allow"]) {
      expect((await rpcError(c.call(m, { tool: "rm" }))).code).toBe(-32601);
    }
    for (const t of ["write_file", "bash", "git_push", "deploy", "fs.delete", "*", "read_*", "exec"]) {
      expect(() => checkReadOnlyName(t)).toThrow();
    }
    expect(() => w.admin.allowReadOnlyTools("a1", ["read_file"], "000000" === w.code() ? "111111" : "000000")).toThrow(/verification failed/);
    expect(w.admin.toolPolicy("a1")).toHaveLength(0);
    expect(dump(w)).not.toContain(a.token);
  });
});
