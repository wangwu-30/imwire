import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Clock } from "@imwire/core";
import { SessionGateway } from "../src/gateway.js";
import { ScriptedDriver } from "../src/scripted-driver.js";
import { openSqlite } from "../src/sqlite.js";
import { SessionStore } from "../src/store.js";
import { action, cmd, dm, extractPairCode, fakeAdapter, markdownCalls, owner } from "./helpers.js";

const LEGACY_SQL = readFileSync(new URL("./fixtures/schema-a654dca.sql", import.meta.url), "utf8");

class ManualClock implements Clock {
  constructor(public t = 1_000_000) {}
  now(): number {
    return this.t;
  }
  sleep(): Promise<void> {
    return new Promise(() => undefined); // never fires; tests drive the sweeper directly
  }
}

const dirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "imwire-a2h-"));
  dirs.push(d);
  return join(d, "s.sqlite");
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function columns(store: SessionStore, table: string): string[] {
  return store.db.prepare<{ name: string }>(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}
function tables(store: SessionStore): string[] {
  return store.db
    .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
    .all()
    .map((r) => r.name);
}

function expectA2hSchema(store: SessionStore): void {
  const t = tables(store);
  for (const name of ["agent", "agent_grant", "a2h_request", "audit_log", "conv_person_agent", "delivery_platform_msg"]) {
    expect(t).toContain(name);
  }
  expect(columns(store, "approval")).toEqual(expect.arrayContaining(["target_person_id", "expires_at", "source"]));
  expect(columns(store, "conversation")).toContain("agent_id");
  expect(columns(store, "message")).toEqual(expect.arrayContaining(["author", "request_id"]));
}

function snapshotCounts(store: SessionStore): Record<string, number> {
  const out: Record<string, number> = {};
  for (const tbl of ["person", "identity", "conversation", "message", "delivery", "approval"]) {
    out[tbl] = store.db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tbl}`).get()!.n;
  }
  return out;
}

describe("a2h PR1: migration", () => {
  it("fresh database gets every a2h table, column and index", () => {
    const store = new SessionStore(":memory:");
    expectA2hSchema(store);
    store.close();
  });

  it("upgrades a pre-a2h (a654dca) database in place, additively and idempotently", () => {
    const path = tmpDb();
    const legacy = openSqlite(path);
    legacy.exec(LEGACY_SQL);
    legacy.exec(`
      INSERT INTO person(id, name, created_at) VALUES ('p1', 'Ada', 1);
      INSERT INTO identity VALUES ('telegram', 'bot', 'ada', 'p1', 1);
      INSERT INTO conversation(id, person_id, title, is_default, created_at) VALUES ('c1', 'p1', 'default', 1, 1);
      INSERT INTO message(id, conversation_id, seq, role, content, created_at) VALUES ('m1', 'c1', 1, 'user', '{"text":"hi"}', 1);
      INSERT INTO approval(id, conversation_id, tool_call, state, version) VALUES ('a1', 'c1', '{"toolCallId":"t","title":"x","options":[]}', 'approved', 2);
    `);
    legacy.close();

    const store = new SessionStore(path);
    expectA2hSchema(store);
    expect(store.getApproval("a1")).toMatchObject({ state: "approved", targetPersonId: undefined, expiresAt: undefined });
    expect(store.db.prepare<{ content: string; author: string | null }>("SELECT content, author FROM message WHERE id = 'm1'").get()).toEqual({ content: '{"text":"hi"}', author: null });
    const before = snapshotCounts(store);
    store.close();

    const again = new SessionStore(path); // second open must be a no-op
    expectA2hSchema(again);
    expect(snapshotCounts(again)).toEqual(before);
    again.close();
  });

  const realDb = process.env.IMWIRE_UPGRADE_DB ?? "/workspace/imwire-assistant.sqlite";
  it.runIf(existsSync(realDb))("upgrades a copy of a real assistant database without losing rows", () => {
    const path = tmpDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(realDb + suffix)) copyFileSync(realDb + suffix, path + suffix);
    }
    const raw = openSqlite(path);
    const rawCounts: Record<string, number> = {};
    for (const tbl of ["person", "identity", "conversation", "message", "delivery", "approval"]) {
      rawCounts[tbl] = raw.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tbl}`).get()!.n;
    }
    raw.close();
    const store = new SessionStore(path);
    expectA2hSchema(store);
    expect(snapshotCounts(store)).toEqual(rawCounts);
    store.close();
  });
});

async function setup(opts?: { dbPath?: string; clock?: ManualClock; allowlist?: ReturnType<typeof owner>[] }) {
  const clock = opts?.clock ?? new ManualClock();
  const gw = new SessionGateway({
    dbPath: opts?.dbPath ?? ":memory:",
    driver: new ScriptedDriver(),
    allowlist: opts?.allowlist ?? [owner("telegram", "ada")],
    clock,
    sweepIntervalMs: 0,
  });
  const tg = fakeAdapter("telegram");
  const fs = fakeAdapter("feishu");
  gw.attach(tg);
  gw.attach(fs);
  await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
  await gw.waitForIdle();
  const ada = gw.store.findIdentity("telegram", "bot", "ada")!.personId;
  return { gw, tg, fs, clock, ada };
}

/** A second, linked person who is not on the owner allowlist. */
function addNonOwner(gw: SessionGateway, clock: ManualClock): string {
  const bob = gw.store.createPerson("Bob", clock.now());
  gw.store.linkIdentity(bob.id, "telegram", "bot", "bob", clock.now());
  return bob.id;
}

function agentApproval(gw: SessionGateway, target: string, clock: ManualClock, ttlMs = 600_000) {
  const agent = gw.store.createAgent(`codex-${Math.random().toString(36).slice(2, 7)}`, "sha256:test", clock.now());
  gw.grantAgent(agent.id, target, ["send", "ask", "approve"]);
  const conv = gw.store.activeConversation(target, clock.now());
  const approval = gw.store.createApproval(conv.id, "a2h", "deploy?", ["approve", "deny"], undefined, clock.now(), {
    targetPersonId: target,
    expiresAt: clock.now() + ttlMs,
    source: "agent",
  });
  const { request } = gw.store.createA2hRequest({
    agentId: agent.id,
    personId: target,
    conversationId: conv.id,
    kind: "approval",
    payload: { title: "deploy?" },
    approvalId: approval.id,
    expiresAt: clock.now() + ttlMs,
    now: clock.now(),
    idempotencyKey: "k1",
  });
  return { agent, approval, request };
}

describe("a2h PR1: approval core", () => {
  it("persists expires_at; the sweeper fails closed once it passes", async () => {
    const { gw, tg, clock, ada } = await setup();
    const { approval, request } = agentApproval(gw, ada, clock, 60_000);
    expect(gw.store.getApproval(approval.id)!.expiresAt).toBe(clock.now() + 60_000);

    clock.t += 59_999;
    expect(gw.sweepExpired().approvals).toHaveLength(0);
    expect(gw.store.getApproval(approval.id)!.state).toBe("pending");

    clock.t += 1;
    const swept = gw.sweepExpired();
    expect(swept.approvals.map((a) => a.id)).toEqual([approval.id]);
    expect(gw.store.getApproval(approval.id)).toMatchObject({ state: "denied", decidedBy: "expired" });
    expect(gw.store.getA2hRequest(request.id)).toMatchObject({ state: "expired" });

    // A click after expiry changes nothing.
    await tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: approval.id }));
    expect(gw.store.getApproval(approval.id)!.state).toBe("denied");
    expect(gw.sweepExpired().approvals).toHaveLength(0);
    gw.close();
  });

  it("a late click past expires_at, before the sweeper ran, is still denied", async () => {
    const { gw, tg, clock, ada } = await setup();
    const { approval, request } = agentApproval(gw, ada, clock, 1_000);
    clock.t += 5_000;
    await tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: approval.id }));
    expect(gw.store.getApproval(approval.id)!.state).toBe("denied");
    expect(gw.store.getA2hRequest(request.id)!.state).toBe("expired");
    gw.close();
  });

  it("standalone ask requests expire through the sweeper too", async () => {
    const { gw, clock, ada } = await setup();
    const agent = gw.store.createAgent("asker", "h", clock.now());
    const conv = gw.store.activeConversation(ada, clock.now());
    const { request } = gw.store.createA2hRequest({
      agentId: agent.id, personId: ada, conversationId: conv.id, kind: "ask",
      payload: { question: "q" }, expiresAt: clock.now() + 10, now: clock.now(),
    });
    clock.t += 10;
    expect(gw.sweepExpired().requests.map((r) => r.id)).toEqual([request.id]);
    expect(gw.store.getA2hRequest(request.id)!.state).toBe("expired");
    expect(gw.store.auditEntries().some((e) => e.requestId === request.id && e.result === "expired")).toBe(true);
    gw.close();
  });

  it("only the targeted person can decide; others are ignored and audited", async () => {
    const { gw, tg, fs, clock, ada } = await setup({ allowlist: [owner("telegram", "ada"), owner("telegram", "bob")] });
    // Second owner, also on the allowlist, but not the one being asked.
    await tg.ingest(dm({ platform: "telegram", userId: "bob", text: "hi" }));
    await gw.waitForIdle();
    const bob = gw.store.findIdentity("telegram", "bot", "bob")!.personId;
    expect(bob).not.toBe(ada);

    const { approval, request } = agentApproval(gw, ada, clock);
    await tg.ingest(action({ platform: "telegram", userId: "bob", actionId: "approve", value: approval.id }));
    await tg.ingest(action({ platform: "telegram", userId: "eve", actionId: "approve", value: approval.id }));
    expect(gw.store.getApproval(approval.id)!.state).toBe("pending");
    const forbidden = gw.store.auditEntries().filter((e) => e.result === "forbidden_click");
    expect(forbidden).toHaveLength(2);
    expect(forbidden[0]).toMatchObject({ personId: bob, requestId: request.id });

    // Ada can decide from a linked second IM.
    await tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "pair" }));
    await gw.waitForIdle();
    const code = extractPairCode(...markdownCalls(tg))!;
    await fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: code }));
    await gw.waitForIdle();
    expect(gw.store.findIdentity("feishu", "bot", "ou_ada")?.personId).toBe(ada);
    await fs.ingest(action({ platform: "feishu", userId: "ou_ada", actionId: "approve", value: approval.id }));
    expect(gw.store.getApproval(approval.id)!.state).toBe("approved");
    expect(gw.store.getA2hRequest(request.id)!.state).toBe("approved");
    gw.close();
  });

  it("repeated and racing clicks are idempotent (first click wins)", async () => {
    const { gw, tg, clock, ada } = await setup();
    const { approval, request } = agentApproval(gw, ada, clock);
    await tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "deny", value: approval.id }));
    const first = gw.store.getApproval(approval.id)!;
    const firstReq = gw.store.getA2hRequest(request.id)!;
    expect(first.state).toBe("denied");
    expect(firstReq.state).toBe("denied");

    await tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: approval.id }));
    await tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: approval.id }));
    expect(gw.store.getApproval(approval.id)).toEqual(first);
    expect(gw.store.getA2hRequest(request.id)).toEqual(firstReq);
    expect(gw.store.decideA2hRequest(request.id, "approved", "x", clock.now())).toBeUndefined();
    gw.close();
  });

  it("idempotency_key replays the same request", async () => {
    const { gw, clock, ada } = await setup();
    const { agent, request } = agentApproval(gw, ada, clock);
    const again = gw.store.createA2hRequest({
      agentId: agent.id, personId: ada, conversationId: request.conversationId, kind: "approval",
      payload: {}, expiresAt: clock.now() + 1, now: clock.now(), idempotencyKey: "k1",
    });
    expect(again).toMatchObject({ replayed: true, request: { id: request.id } });
    gw.close();
  });

  it("v1 gate: agents can only be granted allowlisted owners", async () => {
    const { gw, clock, ada } = await setup();
    const bob = addNonOwner(gw, clock);
    const agent = gw.store.createAgent("codex", "h", clock.now());
    expect(gw.isA2hTargetAllowed(ada)).toBe(true);
    expect(gw.isA2hTargetAllowed(bob)).toBe(false);
    expect(() => gw.grantAgent(agent.id, bob, ["send"])).toThrow(/allowlisted owners/);
    expect(gw.store.agentScopes(agent.id, bob)).toEqual([]);
    gw.grantAgent(agent.id, ada, ["send", "approve", "send"]);
    expect(gw.store.agentScopes(agent.id, ada)).toEqual(["send", "approve"]);
    expect(gw.store.auditEntries().some((e) => e.result === "forbidden_target" && e.personId === bob)).toBe(true);
    gw.close();
  });

  it("restart expires every open a2h request and its approval (Q4)", async () => {
    const path = tmpDb();
    const clock = new ManualClock();
    const first = await setup({ dbPath: path, clock });
    const { approval, request } = agentApproval(first.gw, first.ada, clock, 24 * 3600_000);
    const agent = first.gw.store.getAgent(request.agentId)!;
    const conv = first.gw.store.activeConversation(first.ada, clock.now());
    const { request: ask } = first.gw.store.createA2hRequest({
      agentId: agent.id, personId: first.ada, conversationId: conv.id, kind: "ask",
      payload: {}, expiresAt: clock.now() + 3600_000, now: clock.now(),
    });
    first.gw.close();

    clock.t += 1_000; // well within TTL
    const second = new SessionGateway({ dbPath: path, driver: new ScriptedDriver(), clock, sweepIntervalMs: 0 });
    expect(second.store.getA2hRequest(request.id)).toMatchObject({ state: "expired", decidedBy: "restart" });
    expect(second.store.getA2hRequest(ask.id)).toMatchObject({ state: "expired", decidedBy: "restart" });
    expect(second.store.getApproval(approval.id)!.state).toBe("denied");
    expect(second.store.pendingA2hRequests()).toEqual([]);
    expect(second.store.auditEntries().filter((e) => e.result === "expired_on_restart")).toHaveLength(2);
    second.close();
  });

  it("pi approvals now persist expires_at but keep their existing behaviour", async () => {
    const clock = new ManualClock();
    const driver = new ScriptedDriver(async (sink) => {
      const d = await sink.requestApproval({ toolCallId: "t", title: "rm?", options: ["approve", "deny"] });
      sink.text(`decision=${d}`);
    });
    const gw = new SessionGateway({
      dbPath: ":memory:", driver, allowlist: [owner("telegram", "ada")], clock, sweepIntervalMs: 0, approvalTimeoutMs: 5_000,
    });
    const tg = fakeAdapter("telegram");
    gw.attach(tg);
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
    await gw.waitForIdle();
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "go" }));
    let pending = gw.store.pendingApprovals();
    for (let i = 0; i < 50 && pending.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      pending = gw.store.pendingApprovals();
    }
    expect(pending[0]).toMatchObject({ source: "pi", expiresAt: clock.now() + 5_000, targetPersonId: undefined });
    clock.t += 5_000;
    gw.sweepExpired();
    await gw.waitForIdle();
    expect(gw.store.getApproval(pending[0]!.id)!.state).toBe("denied");
    gw.close();
  });
});
