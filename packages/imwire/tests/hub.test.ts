import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore, base32Decode, totp } from "@imwire/session";
import { action, cmd, fakeAdapter, markdownCalls } from "../../session/tests/helpers.js";
import { HubAdmin } from "../src/hub/admin.js";
import { redactText } from "../src/hub/redact.js";
import { ROTATE_OVERLAP_MS } from "../src/hub/tokens.js";
import { runHubCli, type CliIo } from "../src/hub/commands.js";
import { addAgent, boot, client, dump, open, rpcError, world } from "./hub-world.js";

describe("imwire hub: socket", () => {
  it("socket is 0600 inside a 0700 dir; unauthenticated calls are refused", async () => {
    const w = await world();
    expect(statSync(w.sock).mode & 0o777).toBe(0o600);
    expect(statSync(join(w.dir, "run")).mode & 0o777).toBe(0o700);
    const c = await client(w);
    expect((await rpcError(c.call("a2h.findPerson", {}))).code).toBe(-32001);
    expect((await rpcError(c.call("a2h.auth", { token: "imw_nope" }))).data?.reason).toBe("bad_format");
  });
});

describe("imwire hub: e2e TOTP approval over RPC (mock platform)", () => {
  it("agent → approve → human clicks → step-up with TOTP → wait returns approved/verified, with events", async () => {
    const w = await world();
    const { agentId, token } = addAgent(w);
    const c = await client(w, token);

    const people = await c.call<{ people: Array<{ person_id: string }> }>("a2h.findPerson", {});
    expect(people.people.map((p) => p.person_id)).toEqual([w.ownerId]);

    const sub = await c.call<{ subscribed: boolean }>("a2h.events.subscribe", { cursor: 0 });
    expect(sub.subscribed).toBe(true);

    const req = await c.call<Record<string, unknown>>("a2h.approve", { grant: "once", to: w.ownerId, title: "deploy prod", wait_s: 0 });
    expect(req).toMatchObject({ status: "pending", approved: false, required_level: "verified" });
    expect(String(req.next)).toContain("NOT approved");

    const approvalId = w.hub.gw.store.getA2hRequest(req.request_id as string)!.approvalId!;
    await w.tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: approvalId }));
    let r = await c.call<{ results: Array<Record<string, unknown>> }>("a2h.wait", { request_ids: [req.request_id], wait_s: 0 });
    expect(r.results[0]).toMatchObject({ status: "pending", step_up_required: true });

    const code = w.code();
    await w.tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "approve", args: `${req.code as string} ${code}` }));
    await w.hub.gw.waitForIdle();
    r = await c.call("a2h.wait", { request_ids: [req.request_id], wait_s: 0 });
    expect(r.results[0]).toMatchObject({ status: "approved", approved: true, decided_level: "verified" });

    // v0 envelopes: schema version, agent, object, decision, time; handoff recorded once.
    type Env = { id: string; seq: number; v: number; type: string; subject: string; source: string; correlationid?: string; data: Record<string, unknown> };
    const ev = await c.call<{ events: Env[]; cursor: number }>("a2h.events.read", { cursor: 0 });
    const actions = ev.events.map((e) => e.data.action);
    expect(actions).toContain("handoff");
    expect(actions).toContain("decision");
    expect(actions.filter((a) => a === "handoff")).toHaveLength(1);
    for (const e of ev.events) {
      expect(e.v).toBe(1);
      expect(e.data.agent).toBe(`agent:${agentId}`);
      expect(typeof e.data.decision).toBe("string");
    }
    expect(ev.events.find((e) => e.data.action === "handoff")).toMatchObject({
      subject: `request:${req.request_id as string}`,
      correlationid: `req:${req.request_id as string}`,
      data: { decision: "approved" },
    });
    // cursor reads continue where they stopped
    const more = await c.call<{ events: unknown[] }>("a2h.events.read", { cursor: ev.cursor });
    expect(more.events).toHaveLength(0);

    // subscription pushed the same envelopes
    await new Promise((res) => setTimeout(res, 400));
    const pushed = c.notifications.filter((n) => n.method === "a2h.event").map((n) => (n.params as Env).id);
    expect(pushed).toEqual(ev.events.map((e) => e.id));

    // no secrets in DB / logs / audit
    const all = dump(w);
    expect(all).not.toContain(token);
    expect(all).not.toContain(token.split(".")[1]);
    expect(all).not.toContain(code);
    expect(all).not.toContain(w.secretB32);
    for (const rc of w.recovery) expect(all).not.toContain(rc);
  });

  it("an agent only sees its own events", async () => {
    const w = await world();
    const a = addAgent(w, "a1");
    const b = addAgent(w, "b1");
    const ca = await client(w, a.token);
    const cb = await client(w, b.token);
    await ca.call("a2h.send", { to: w.ownerId, text: "hi" });
    const evb = await cb.call<{ events: Array<{ data: { agent?: string; action: string } }> }>("a2h.events.read", {});
    expect(evb.events.length).toBeGreaterThan(0);
    expect(evb.events.every((e) => e.data.agent === `agent:${b.agentId}`)).toBe(true);
    expect(evb.events.some((e) => e.data.action === "send")).toBe(false);
  });
});

describe("imwire hub: token lifecycle", () => {
  it("revoke takes effect on an already-authenticated connection; open requests are cancelled", async () => {
    const w = await world();
    const { token } = addAgent(w);
    const c = await client(w, token);
    const req = await c.call<{ request_id: string }>("a2h.approve", { grant: "once", to: w.ownerId, title: "x", wait_s: 0 });
    // revoke from a separate admin process (own store handle, like the CLI)
    const cliStore = new HubAdmin(new SessionStore(w.db), w.key, () => w.clock.now());
    expect(cliStore.revokeAgent("codex-mac").cancelled).toBe(1);
    cliStore.store.close();
    const e = await rpcError(c.call("a2h.findPerson", {}));
    expect(e).toMatchObject({ code: -32001, data: { reason: "revoked" } });
    const c2 = await client(w);
    expect((await rpcError(c2.call("a2h.auth", { token }))).data?.reason).toBe("revoked");
    expect(w.hub.gw.store.getA2hRequest(req.request_id)!.state).toBe("cancelled");
    // a late click cannot approve
    const approvalId = w.hub.gw.store.getA2hRequest(req.request_id)!.approvalId!;
    await w.tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: approvalId }));
    expect(w.hub.gw.store.getApproval(approvalId)!.state).toBe("denied");
  });

  it("expired token is rejected (default TTL 90d)", async () => {
    const w = await world();
    const { token } = addAgent(w);
    const c = await client(w, token);
    w.clock.t += 89 * 86_400_000;
    await c.call("a2h.findPerson", {});
    w.clock.t += 2 * 86_400_000;
    expect((await rpcError(c.call("a2h.findPerson", {}))).data?.reason).toBe("expired");
    const c2 = await client(w);
    expect((await rpcError(c2.call("a2h.auth", { token }))).data?.reason).toBe("expired");
  });

  it("rotate: old and new token both work for 24h, then only the new one", async () => {
    const w = await world();
    const { token: oldTok } = addAgent(w);
    const r = w.admin.rotateAgent("codex-mac", w.code());
    w.next();
    expect(r.token).not.toBe(oldTok);
    const cOld = await client(w, oldTok);
    const cNew = await client(w, r.token);
    await cOld.call("a2h.findPerson", {});
    await cNew.call("a2h.findPerson", {});
    w.clock.t += ROTATE_OVERLAP_MS + 1;
    expect((await rpcError(cOld.call("a2h.findPerson", {}))).data?.reason).toBe("expired");
    await cNew.call("a2h.findPerson", {});
    expect(dump(w)).not.toContain(r.token);
  });

  it("agent add/rotate need the owner's TOTP; a wrong code adds nothing", async () => {
    const w = await world();
    expect(() => w.admin.addAgent({ name: "x", grantTo: w.ownerId, scopes: ["send"], ownerProof: "000000" === w.code() ? "111111" : "000000" })).toThrow(/verification failed/);
    expect(w.admin.listAgents()).toHaveLength(0);
  });

  it("bind to a uid: a peer with another uid is refused", async () => {
    const w = await world();
    const r = w.admin.addAgent({ name: "bound", grantTo: w.ownerId, scopes: ["send"], ownerProof: w.code(), bindUid: 999_999 });
    const c = await client(w);
    expect((await rpcError(c.call("a2h.auth", { token: r.token }))).data?.reason).toBe("bind_mismatch");
  });
});

describe("imwire hub: identity defaults", () => {
  it("hub default is totp: approvals require TOTP; per-agent downgrade to im_account works", async () => {
    const w = await world();
    const { token, agentId } = addAgent(w);
    const c = await client(w, token);
    const a = await c.call<Record<string, unknown>>("a2h.approve", { grant: "once", to: w.ownerId, title: "x", wait_s: 0 });
    expect(a.required_level).toBe("verified");
    w.admin.setAgentLevel("codex-mac", "im_account", w.code());
    w.next();
    expect(w.hub.gw.store.agentApprovalLevel(agentId)).toBe("im_account");
    const b = await c.call<Record<string, unknown>>("a2h.approve", { grant: "once", to: w.ownerId, title: "y", wait_s: 0 });
    expect(b.required_level).toBe("im_account");
    // risk high still forces TOTP
    const h = await c.call<Record<string, unknown>>("a2h.approve", { grant: "once", to: w.ownerId, title: "z", risk: "high", wait_s: 0 });
    expect(h.required_level).toBe("verified");
  });

  it("owner init: a wrong confirmation code stores nothing", async () => {
    const w = await world();
    const before = w.hub.gw.store.db.prepare<{ n: number }>("SELECT COUNT(*) n FROM person").get()!.n;
    const p = w.admin.prepareOwner("other");
    const wrong = totp(p.secret, w.clock.now()) === "000000" ? "111111" : "000000";
    expect(() => w.admin.commitOwner("other", p, wrong)).toThrow(/nothing was saved/);
    expect(w.hub.gw.store.db.prepare<{ n: number }>("SELECT COUNT(*) n FROM person").get()!.n).toBe(before);
  });

  it("owner reset needs TOTP/recovery, unlinks IM accounts and issues a new claim code", async () => {
    const w = await world();
    expect(() => w.admin.resetOwner(w.ownerId, "nope")).toThrow();
    const r = w.admin.resetOwner(w.ownerId, w.recovery[0]);
    expect(r.unlinked).toBe(1);
    expect(r.claimCode).toMatch(/^\d{8}$/);
    expect(w.hub.gw.store.findIdentity("telegram", "bot", "ada")).toBeUndefined();
    // recovery code is single-use
    expect(() => w.admin.resetOwner(w.ownerId, w.recovery[0])).toThrow();
  });
});

describe("imwire hub: restart", () => {
  it("pending requests expire on restart and their cards say 已失效", async () => {
    const w = await world();
    const { token } = addAgent(w);
    const c = await client(w, token);
    const ap = await c.call<{ request_id: string }>("a2h.approve", { grant: "once", to: w.ownerId, title: "deploy", wait_s: 0 });
    const ask = await c.call<{ request_id: string }>("a2h.ask", { grant: "once", to: w.ownerId, question: "which?", choices: ["a", "b"], wait_s: 0 });
    c.close();
    await w.hub.close();
    open.splice(open.indexOf(w.hub), 1);
    const tg2 = fakeAdapter("telegram");
    const { hub } = await boot(w, tg2);
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.gw.store.getA2hRequest(ap.request_id)!.state).toBe("expired");
    expect(hub.gw.store.getA2hRequest(ask.request_id)!.state).toBe("expired");
    const edits = tg2.calls.filter((x) => x.op === "edit");
    expect(edits.length).toBeGreaterThanOrEqual(2);
    expect(markdownCalls(tg2).join("\n")).toContain("已失效");
  });
});

describe("audit log: append-only, versioned, secret-free", () => {
  it("UPDATE and DELETE on audit_log are refused by the DB", async () => {
    const w = await world();
    const db = w.hub.gw.store.db;
    expect(() => db.prepare("UPDATE audit_log SET result = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM audit_log").run()).toThrow(/append-only/);
    expect(db.prepare<{ v: number }>("SELECT DISTINCT v FROM audit_log").all().map((r) => r.v)).toEqual([1]);
  });

  it("failed auth is audited with a fingerprint only", async () => {
    const w = await world();
    const { token, agentId } = addAgent(w);
    const forged = `${token.slice(0, -4)}AAAA`;
    const c = await client(w);
    await rpcError(c.call("a2h.auth", { token: forged }));
    const rows = w.hub.gw.store.eventsAfter(0, { agentId });
    const fail = rows.find((e) => e.decision === "auth_failed:bad_token");
    expect(fail).toBeDefined();
    expect(JSON.stringify(rows)).not.toContain(forged.split(".")[1]);
    expect(dump(w)).not.toContain(token.split(".")[1]);
  });

  it("redactText strips tokens, otpauth URLs and base32 secrets", () => {
    const s = redactText("tok imw_ag_0123456789abcdef01234567.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ otpauth://totp/x?secret=JBSWY3DPEHPK3PXP JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    expect(s).not.toMatch(/imw_ag_0123/);
    expect(s).not.toContain("otpauth://totp/x?secret");
    expect(s).not.toContain("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
  });
});

describe("imwire CLI", () => {
  function io(lines: string[], answers: string[] = []): CliIo {
    return { out: (s) => lines.push(s), err: (s) => lines.push(`E:${s}`), prompt: async () => answers.shift() ?? "", env: {} };
  }

  it("owner init → agent add → list → revoke → audit (no token in audit output)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imw-cli-"));
    const base = ["--home", dir];
    const out: string[] = [];
    // owner init: first prompt is the confirmation code; we cannot know the secret before it is shown,
    // so feed it lazily from the printed secret.
    const lazy: CliIo = {
      ...io(out),
      prompt: async () => {
        const s = out.find((l) => l.includes("secret: "))!.split("secret: ")[1]!;
        return totp(base32Decode(s), Date.now());
      },
    };
    expect(await runHubCli(["owner", "init", "--name", "佳恒", ...base], lazy)).toBe(0);
    expect(statSync(join(dir, "master.key")).mode & 0o777).toBe(0o600);
    const secret = base32Decode(out.find((l) => l.includes("secret: "))!.split("secret: ")[1]!);

    // a different time step so the confirmation code is not replayed
    const add: string[] = [];
    const step = Math.floor(Date.now() / 30_000);
    const codeNext = totp(secret, (step + 1) * 30_000);
    expect(await runHubCli(["agent", "add", "codex", ...base, "--code", codeNext], io(add))).toBe(0);
    const token = add.find((l) => l.startsWith("imw_"))!;
    expect(token).toMatch(/^imw_ag_[0-9a-f]{24}\./);

    const list: string[] = [];
    await runHubCli(["agent", "list", ...base], io(list));
    expect(list.join("\n")).toContain("codex");
    expect(list.join("\n")).toContain("active");

    expect(await runHubCli(["agent", "revoke", "codex", ...base], io([]))).toBe(0);
    const aud: string[] = [];
    expect(await runHubCli(["audit", ...base, "--json"], io(aud))).toBe(0);
    const text = aud.join("\n");
    expect(text).toContain("agent_add");
    expect(text).toContain("agent_revoke");
    expect(text).not.toContain(token.split(".")[1]);
    expect(text).not.toContain(codeNext);
  });
});
