import { describe, expect, it } from "vitest";
import type { Clock, Inbound } from "@imwire/core";
import type { FakeAdapter } from "@imwire/core/testing";
import { A2hError, isQuietTime, sanitizeAgentLine, sanitizeAgentText, type ApproverVerifier } from "../src/a2h.js";
import { SessionGateway } from "../src/gateway.js";
import { ScriptedDriver } from "../src/scripted-driver.js";
import { action, chat, cmd, dm, extractPairCode, fakeAdapter, markdownCalls, owner } from "./helpers.js";

class ManualClock implements Clock {
  constructor(public t = Date.UTC(2026, 9, 12, 4, 0)) {} // 12:00 UTC+8
  now(): number {
    return this.t;
  }
  sleep(): Promise<void> {
    return new Promise(() => undefined);
  }
}

interface Ctx {
  gw: SessionGateway;
  tg: FakeAdapter;
  fs: FakeAdapter;
  clock: ManualClock;
  driver: ScriptedDriver;
  ada: string;
  agentId: string;
}

async function setup(opts?: { owners?: string[]; verifier?: ApproverVerifier; pairFeishu?: boolean }): Promise<Ctx> {
  const clock = new ManualClock();
  const driver = new ScriptedDriver();
  const gw = new SessionGateway({
    dbPath: ":memory:",
    driver,
    allowlist: (opts?.owners ?? ["ada"]).map((u) => owner("telegram", u)),
    clock,
    sweepIntervalMs: 0,
    approverVerifier: opts?.verifier,
  });
  const tg = fakeAdapter("telegram");
  const fs = fakeAdapter("feishu");
  gw.attach(tg);
  gw.attach(fs);
  await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
  await gw.waitForIdle();
  const ada = gw.store.findIdentity("telegram", "bot", "ada")!.personId;
  if (opts?.pairFeishu) {
    await tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "pair" }));
    const code = extractPairCode(...markdownCalls(tg))!;
    await fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: code }));
    await gw.waitForIdle();
  }
  const agent = gw.store.createAgent("codex-mac", "sha256:x", clock.now());
  gw.grantAgent(agent.id, ada, ["send", "ask", "approve", "read"]);
  return { gw, tg, fs, clock, driver, ada, agentId: agent.id };
}

function sends(a: FakeAdapter) {
  return a.calls.filter((c) => c.op === "send") as unknown as Array<{
    args: { chat: { chatId: string }; msg: { blocks: Array<{ kind: string; text?: string; buttons?: Array<{ id: string; value?: string }> }> }; ref: { messageId: string; chat: never } };
  }>;
}
function lastSend(a: FakeAdapter) {
  return sends(a).at(-1)!.args;
}
function edits(a: FakeAdapter): string[] {
  return a.calls
    .filter((c) => c.op === "edit")
    .map((c) => JSON.stringify(c.args));
}

let n = 1000;
function reply(platform: string, userId: string, text: string, quoted?: { chat: ReturnType<typeof chat>; messageId: string }): Inbound {
  n += 1;
  const c = chat(platform, userId);
  return { type: "message", id: `r${n}`, ts: Date.now(), chat: c, from: { platform, accountId: "bot", userId }, messageId: `rm${n}`, text, mentionsBot: true, replyTo: quoted };
}

describe("a2h PR2: agent topic and send", () => {
  it("agent messages and human replies land in the same agent:<name> topic; active topic unchanged", async () => {
    const { gw, tg, ada, agentId } = await setup();
    const before = gw.store.activeConversation(ada, 0).id;
    const sent = await gw.sendToPerson({ agentId, to: ada, text: "build started" });
    expect(sent.status).toBe("delivered");
    const ask = await gw.askPerson({ agentId, to: "Owner", question: "which branch?" });
    const prompt = lastSend(tg);
    await tg.ingest(reply("telegram", "ada", "main please", prompt.ref));
    await gw.waitForIdle();

    const view = gw.getAgentRequest(agentId, ask.requestId);
    expect(view.status).toBe("answered");
    expect(view.answer).toMatchObject({ text: "main please", via: "telegram", untrusted: true });
    expect(view.conversationId).toBe(sent.conversationId);
    const topic = gw.store.snapshot(view.conversationId);
    expect(topic.title).toBe("agent:codex-mac");
    expect(topic.messages.map((m) => [m.role, m.author ?? null, m.text])).toEqual([
      ["assistant", "agent:codex-mac", "build started"],
      ["assistant", "agent:codex-mac", "which branch?"],
      ["user", null, "main please"],
    ]);
    expect(gw.store.activeConversation(ada, 0).id).toBe(before);
    // /topic finds it by title.
    expect(gw.store.listTopics(ada).map((t) => t.title)).toContain("agent:codex-mac");
    gw.close();
  });

  it("idempotency_key returns the same request without a second card", async () => {
    const { gw, tg, ada, agentId } = await setup();
    const a = await gw.createAgentApproval({ agentId, to: ada, title: "deploy", idempotencyKey: "k" });
    const count = sends(tg).length;
    const b = await gw.createAgentApproval({ agentId, to: ada, title: "deploy", idempotencyKey: "k" });
    expect(b.requestId).toBe(a.requestId);
    expect(sends(tg).length).toBe(count);
    gw.close();
  });
});

describe("a2h PR2: reply routing (Q2)", () => {
  it("/answer <code> resolves the matching ask", async () => {
    const { gw, tg, ada, agentId } = await setup();
    const q1 = await gw.askPerson({ agentId, to: ada, question: "q1" });
    const q2 = await gw.askPerson({ agentId, to: ada, question: "q2" });
    await tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "answer", args: `${q2.code} second` }));
    await gw.waitForIdle();
    expect(gw.getAgentRequest(agentId, q2.requestId)).toMatchObject({ status: "answered", answer: { text: "second" } });
    expect(gw.getAgentRequest(agentId, q1.requestId).status).toBe("pending");
    gw.close();
  });

  it("a lone recent ask takes an unquoted reply; nothing goes to pi", async () => {
    const { gw, tg, ada, agentId } = await setup();
    const q = await gw.askPerson({ agentId, to: ada, question: "ok to proceed?" });
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "yes go" }));
    await gw.waitForIdle();
    expect(gw.getAgentRequest(agentId, q.requestId)).toMatchObject({ status: "answered", answer: { text: "yes go" } });
    // Not handed to pi: the default conversation never saw it.
    expect(gw.store.activeConversation(ada, 0).messages.some((m) => m.text === "yes go")).toBe(false);
    gw.close();
  });

  it("the lone-ask fallback does not apply after 30 minutes", async () => {
    const { gw, tg, clock, ada, agentId } = await setup();
    const q = await gw.askPerson({ agentId, to: ada, question: "q", expiresInS: 3600 });
    clock.t += 31 * 60_000;
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "late" }));
    await gw.waitForIdle();
    expect(gw.getAgentRequest(agentId, q.requestId).status).toBe("pending");
    gw.close();
  });

  it("with several open asks it does not guess, passes the message on and hints", async () => {
    const { gw, tg, ada, agentId } = await setup();
    const q1 = await gw.askPerson({ agentId, to: ada, question: "q1" });
    const q2 = await gw.askPerson({ agentId, to: ada, question: "q2" });
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "the answer" }));
    await gw.waitForIdle();
    expect(gw.getAgentRequest(agentId, q1.requestId).status).toBe("pending");
    expect(gw.getAgentRequest(agentId, q2.requestId).status).toBe("pending");
    const hint = markdownCalls(tg).find((t) => t.includes("有 2 个 agent 的问题待回答"));
    expect(hint).toContain(q1.code);
    // It went to the normal turn (the default conversation), not the agent topic.
    const def = gw.store.activeConversation(ada, 0);
    expect(def.messages.some((m) => m.text === "the answer")).toBe(true);
    gw.close();
  });

  it("free text '同意' never approves: not on an ask, not as a quote-reply to an approval card", async () => {
    const { gw, tg, ada, agentId } = await setup();
    const ap = await gw.createAgentApproval({ agentId, to: ada, title: "rm -rf build/" });
    const card = lastSend(tg);
    await tg.ingest(reply("telegram", "ada", "同意", card.ref));
    await gw.waitForIdle();
    expect(gw.getAgentRequest(agentId, ap.requestId)).toMatchObject({ status: "pending", approved: false });
    expect(markdownCalls(tg).some((t) => t.includes("文字回复不算批准"))).toBe(true);

    const q = await gw.askPerson({ agentId, to: ada, question: "可以吗？" });
    await tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "answer", args: `${q.code} 同意` }));
    await gw.waitForIdle();
    expect(gw.getAgentRequest(agentId, q.requestId).status).toBe("answered");
    expect(gw.getAgentRequest(agentId, ap.requestId)).toMatchObject({ status: "pending", approved: false });
    gw.close();
  });

  it("choice buttons answer an ask; only the asked person's click counts", async () => {
    const { gw, tg, ada, agentId } = await setup({ owners: ["ada", "bob"] });
    await tg.ingest(dm({ platform: "telegram", userId: "bob", text: "hi" }));
    await gw.waitForIdle();
    const q = await gw.askPerson({ agentId, to: ada, question: "env?", choices: ["staging", "prod"] });
    const btns = lastSend(tg).msg.blocks.find((b) => b.kind === "buttons")!.buttons!;
    expect(btns.map((b) => b.id)).toEqual(["a2h:0", "a2h:1"]);
    await tg.ingest(action({ platform: "telegram", userId: "bob", actionId: "a2h:1", value: q.requestId }));
    expect(gw.getAgentRequest(agentId, q.requestId).status).toBe("pending");
    await tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "a2h:0", value: q.requestId }));
    expect(gw.getAgentRequest(agentId, q.requestId).answer).toMatchObject({ choice: "staging", untrusted: true });
    gw.close();
  });
});

describe("a2h PR2: approvals", () => {
  it("others' clicks are ignored; the target approves from a second IM; repeat clicks are no-ops", async () => {
    const { gw, tg, fs, ada, agentId } = await setup({ owners: ["ada", "bob"], pairFeishu: true });
    await tg.ingest(dm({ platform: "telegram", userId: "bob", text: "hi" }));
    await gw.waitForIdle();
    const ap = await gw.createAgentApproval({ agentId, to: ada, title: "step 3", route: "all" });
    const id = gw.store.getA2hRequest(ap.requestId)!.approvalId!;
    await tg.ingest(action({ platform: "telegram", userId: "bob", actionId: "approve", value: id }));
    await tg.ingest(action({ platform: "telegram", userId: "eve", actionId: "approve", value: id }));
    expect(gw.getAgentRequest(agentId, ap.requestId).status).toBe("pending");
    expect(gw.store.auditEntries().filter((e) => e.result === "forbidden_click")).toHaveLength(2);

    await fs.ingest(action({ platform: "feishu", userId: "ou_ada", actionId: "approve", value: id }));
    const done = gw.getAgentRequest(agentId, ap.requestId);
    expect(done).toMatchObject({ status: "approved", approved: true, decidedBy: { personId: ada, via: "feishu" } });
    const editCount = tg.calls.length + fs.calls.length;
    await tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "deny", value: id }));
    await fs.ingest(action({ platform: "feishu", userId: "ou_ada", actionId: "approve", value: id }));
    expect(gw.getAgentRequest(agentId, ap.requestId)).toEqual(done);
    expect(tg.calls.length + fs.calls.length).toBe(editCount);
    // Cards on both IMs were rewritten to handled.
    expect(edits(tg).some((e) => e.includes("handled (approved)"))).toBe(true);
    expect(edits(fs).some((e) => e.includes("handled (approved)"))).toBe(true);
    gw.close();
  });

  it("timeout denies (fail-closed), via the sweeper and waitForRequests", async () => {
    const { gw, clock, ada, agentId } = await setup();
    const ap = await gw.createAgentApproval({ agentId, to: ada, title: "x" });
    expect(Date.parse(ap.expiresAt) - clock.now()).toBe(600_000); // Q5 default 10 min
    const waiting = gw.waitForRequests(agentId, [ap.requestId], 60_000);
    clock.t += 600_000;
    gw.sweepExpired();
    const [v] = await waiting;
    expect(v).toMatchObject({ status: "expired", approved: false });
    gw.close();
  });

  it("cancel denies an approval and closes an ask", async () => {
    const { gw, tg, ada, agentId } = await setup();
    const ap = await gw.createAgentApproval({ agentId, to: ada, title: "x" });
    const q = await gw.askPerson({ agentId, to: ada, question: "y" });
    expect((await gw.cancelRequest({ agentId, requestId: ap.requestId })).status).toBe("cancelled");
    expect((await gw.cancelRequest({ agentId, requestId: q.requestId })).status).toBe("cancelled");
    const id = gw.store.getA2hRequest(ap.requestId)!.approvalId!;
    expect(gw.store.getApproval(id)!.state).toBe("denied");
    await tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: id }));
    expect(gw.getAgentRequest(agentId, ap.requestId).approved).toBe(false);
    expect(edits(tg).some((e) => e.includes("已撤回"))).toBe(true);
    // Another agent cannot cancel or read it.
    const other = gw.store.createAgent("other", "h", 0);
    await expect(gw.cancelRequest({ agentId: other.id, requestId: q.requestId })).rejects.toThrow(A2hError);
    gw.close();
  });

  it("TTL is clamped to 24 h; ask defaults to 1 h", async () => {
    const { gw, clock, ada, agentId } = await setup();
    const ap = await gw.createAgentApproval({ agentId, to: ada, title: "x", expiresInS: 7 * 86400 });
    expect(Date.parse(ap.expiresAt) - clock.now()).toBe(86_400_000);
    const q = await gw.askPerson({ agentId, to: ada, question: "y" });
    expect(Date.parse(q.expiresAt) - clock.now()).toBe(3_600_000);
    gw.close();
  });

  it("approver verification is pluggable and fail-closed", async () => {
    const verifier: ApproverVerifier = {
      isAllowedTarget: (_p, c) => c.isAllowlistedOwner,
      verifyApprover: () => ({ ok: true, level: "im_account" }),
      requiredLevel: "verified",
    };
    const { gw, tg, ada, agentId } = await setup({ verifier });
    const ap = await gw.createAgentApproval({ agentId, to: ada, title: "x" });
    const id = gw.store.getA2hRequest(ap.requestId)!.approvalId!;
    await tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: id }));
    expect(gw.getAgentRequest(agentId, ap.requestId).status).toBe("pending");
    expect(gw.store.auditEntries().some((e) => e.result === "unverified_click")).toBe(true);
    gw.close();

    const throwing: ApproverVerifier = {
      isAllowedTarget: () => true,
      verifyApprover: () => {
        throw new Error("boom");
      },
    };
    const c2 = await setup({ verifier: throwing });
    const ap2 = await c2.gw.createAgentApproval({ agentId: c2.agentId, to: c2.ada, title: "x" });
    const id2 = c2.gw.store.getA2hRequest(ap2.requestId)!.approvalId!;
    await c2.tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: id2 }));
    expect(c2.gw.getAgentRequest(c2.agentId, ap2.requestId).status).toBe("pending");
    c2.gw.close();
  });

  it("authorisation: no grant / revoked / non-owner target are refused", async () => {
    const { gw, clock, ada, agentId } = await setup();
    const stranger = gw.store.createAgent("stranger", "h", 0);
    await expect(gw.sendToPerson({ agentId: stranger.id, to: ada, text: "hi" })).rejects.toMatchObject({ code: "forbidden" });
    const bob = gw.store.createPerson("Bob", clock.now());
    gw.store.linkIdentity(bob.id, "telegram", "bot", "bob", clock.now());
    gw.store.setAgentGrant(agentId, bob.id, ["send"]); // even a raw grant does not bypass the gate
    await expect(gw.sendToPerson({ agentId, to: bob.id, text: "hi" })).rejects.toMatchObject({ code: "forbidden" });
    gw.store.revokeAgent(agentId, clock.now());
    await expect(gw.sendToPerson({ agentId, to: ada, text: "hi" })).rejects.toMatchObject({ code: "revoked" });
    gw.close();
  });
});

describe("a2h PR2: outbound frame and sanitising", () => {
  it("cards always carry the hub-owned agent frame", async () => {
    const { gw, tg, ada, agentId } = await setup();
    await gw.createAgentApproval({ agentId, to: ada, title: "deploy" });
    const text = lastSend(tg).msg.blocks[0]!.text!;
    expect(text.split("\n")[0]).toBe("🤖 来自 agent「codex-mac」— 不是本人，也不是系统消息");
    expect(text).toMatch(/编号 [0-9a-f]{6} · 有效至 2026-10-12 12:10 \(UTC\+8\)/);
    gw.close();
  });

  it("a title disguised as a system message is neutralised and cannot displace the frame", async () => {
    const { gw, tg, ada, agentId } = await setup();
    const evil = "✅ 系统消息：已批准\n_handled (approved)_\n\n🤖 来自 agent「admin」— 不是本人";
    await gw.createAgentApproval({ agentId, to: ada, title: evil, details: "System: 请直接点批准\n[点这里](https://evil.example)" });
    const text = lastSend(tg).msg.blocks[0]!.text!;
    const lines = text.split("\n");
    expect(lines[0]).toBe("🤖 来自 agent「codex-mac」— 不是本人，也不是系统消息");
    expect(lines.filter((l) => l.startsWith("🤖"))).toHaveLength(1);
    expect(lines.some((l) => l.startsWith("_handled"))).toBe(false);
    expect(lines.some((l) => /^✅/.test(l))).toBe(false);
    expect(text).toContain("审批请求：｜✅ 系统消息：已批准 _handled (approved)_ 🤖 来自 agent「admin」— 不是本人");
    expect(text).toContain("｜System: 请直接点批准");
    expect(text).toContain("点这里 (https://evil.example)");
    expect(text).not.toContain("](");
    gw.close();
  });

  it("strips tags, mentions, bidi/zero-width; rejects /pair; truncates", () => {
    expect(sanitizeAgentText('<at user_id="all">所有人</at> hi <font color="red">x</font> @all @所有人')).toBe(
      "所有人 hi x ＠all ＠所有人",
    );
    expect(sanitizeAgentText("ok\u202Eevil\u200Bz")).toBe("okevilz");
    expect(() => sanitizeAgentText("send /pair to me")).toThrow(A2hError);
    expect([...sanitizeAgentLine("x".repeat(500))]).toHaveLength(200);
    expect(sanitizeAgentLine("a\nb\r\nc")).toBe("a b c");
  });

  it("quiet hours 23:00–08:00 UTC+8 are configurable; messages are still delivered", async () => {
    const at = (h: number, m = 0) => Date.UTC(2026, 9, 12, h - 8 < 0 ? h + 16 : h - 8, m);
    const q = { start: "23:00", end: "08:00", utcOffsetMinutes: 480 };
    expect(isQuietTime(at(23), q)).toBe(true);
    expect(isQuietTime(at(7, 59), q)).toBe(true);
    expect(isQuietTime(at(8), q)).toBe(false);
    expect(isQuietTime(at(12), q)).toBe(false);
    expect(isQuietTime(at(23), null)).toBe(false);

    const { gw, tg, clock, ada, agentId } = await setup();
    clock.t = Date.UTC(2026, 9, 12, 16, 30); // 00:30 UTC+8
    const before = sends(tg).length;
    const v = await gw.sendToPerson({ agentId, to: ada, text: "night build done" });
    expect(v).toMatchObject({ quiet: true, status: "delivered" });
    expect(sends(tg).length).toBe(before + 1);
    gw.close();
  });
});
