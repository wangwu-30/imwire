// Reviewer repros for PR #2 — assertions match the fixed behavior.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DraftHandle } from "@imwire/core";
import { SessionGateway } from "../src/gateway.js";
import { ScriptedDriver } from "../src/scripted-driver.js";
import type { AgentDriver, ConversationSnapshot, TurnSink, UserTurn } from "../src/types.js";
import { action, cmd, dm, extractPairCode, fakeAdapter, groupMsg, lastApprovalId, markdownCalls, openGateway, waitFor } from "./helpers.js";

const tick = () => new Promise((r) => setTimeout(r, 10));

async function bootstrapAndPairFeishu(
  gw: SessionGateway,
  tg: ReturnType<typeof fakeAdapter>,
  fs: ReturnType<typeof fakeAdapter>,
) {
  await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
  await tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "pair" }));
  const code = extractPairCode(...markdownCalls(tg).filter((t) => t.includes("Pairing code")))!;
  await fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: code }));
  return code;
}

class RecordingDriver implements AgentDriver {
  prompts: string[] = [];
  concurrent = 0;
  maxConcurrent = 0;
  gates: Array<() => void> = [];
  hold = true;
  async ensureSession(conv: ConversationSnapshot) {
    return { agentSessionId: `rec:${conv.id}` };
  }
  async prompt(_s: string, input: UserTurn, sink: TurnSink) {
    this.prompts.push(input.text);
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    sink.text(`re:${input.text} `);
    if (this.hold) await new Promise<void>((r) => this.gates.push(r));
    this.concurrent -= 1;
    return { text: "" };
  }
  releaseAll() {
    const g = this.gates.splice(0);
    g.forEach((f) => f());
  }
  async cancel() {}
}

describe("ADV pairing", () => {
  it("A1: pair-code guesses are per-sender + globally rate-limited; lockout blocks the attacker", async () => {
    const { gw, tg, fs } = openGateway();
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
    await tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "pair" }));
    const code = extractPairCode(...markdownCalls(tg).filter((t) => t.includes("Pairing code")))!;
    const before = fs.calls.length;
    let n = 0;
    for (let i = 0; n < 500; i += 1) {
      const guess = String(i).padStart(8, "0");
      if (guess === code) continue;
      await fs.ingest(dm({ platform: "feishu", userId: "mallory", text: guess }));
      n += 1;
    }
    const replies = fs.calls.length - before;
    await fs.ingest(dm({ platform: "feishu", userId: "mallory", text: code }));
    expect(replies).toBeLessThan(20);
    expect(gw.store.findIdentity("feishu", "bot", "mallory")).toBeUndefined();
    await tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "pair" }));
    const fresh = extractPairCode(...markdownCalls(tg).filter((t) => t.includes("Pairing code")))!;
    await fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: fresh }));
    expect(gw.store.findIdentity("feishu", "bot", "ou_ada")?.personId).toBe(
      gw.store.findIdentity("telegram", "bot", "ada")?.personId,
    );
    gw.close();
  }, 60_000);
});

describe("ADV approvals", () => {
  it("A2: an unlinked group member cannot approve the owner's tool call", async () => {
    const driver = new ScriptedDriver(async (sink) => {
      const d = await sink.requestApproval({ toolCallId: "rm", title: "rm -rf ~/project?", options: ["approve", "deny"] });
      sink.text(`decision=${d}`);
    });
    const { gw, tg } = openGateway({ driver, approvalTimeoutMs: 200 });
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
    await tg.ingest(groupMsg({ platform: "telegram", chatId: "g1", userId: "ada", text: "@bot clean up" }));
    await waitFor(() => Boolean(lastApprovalId(tg)));
    const id = lastApprovalId(tg)!;
    expect(gw.store.findIdentity("telegram", "bot", "eve")).toBeUndefined();
    await tg.ingest(action({ platform: "telegram", userId: "eve", chatId: "g1", actionId: "approve", value: id }));
    expect(gw.store.getApproval(id)!.state).toBe("pending");
    await tg.ingest(action({ platform: "telegram", userId: "ada", chatId: "g1", actionId: "deny", value: id }));
    await gw.waitForIdle();
    expect(gw.store.getApproval(id)!.state).toBe("denied");
    gw.close();
  });

  it("A3: typed options are returned; reject is not coerced to approved", async () => {
    let got = "";
    const driver = new ScriptedDriver(async (sink) => {
      got = await sink.requestApproval({ toolCallId: "t", title: "Send email?", options: ["allow_once", "reject"] });
    });
    const { gw, tg } = openGateway({ driver });
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "send it" }));
    await waitFor(() => Boolean(lastApprovalId(tg)));
    const rejectId = lastApprovalId(tg)!;
    await tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "reject", value: rejectId }));
    await gw.waitForIdle();
    expect(got).toBe("reject");
    expect(gw.store.getApproval(rejectId)?.state).toBe("denied");
    gw.close();
  });

  it("A4: double click across IMs -> first wins (positive check)", async () => {
    const decisions: string[] = [];
    const driver = new ScriptedDriver(async (sink) => {
      decisions.push(await sink.requestApproval({ toolCallId: "t", title: "ok?", options: ["approve", "deny"] }));
    });
    const { gw, tg, fs } = openGateway({ driver });
    await bootstrapAndPairFeishu(gw, tg, fs);
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "go" }));
    await waitFor(() => Boolean(lastApprovalId(tg)));
    const id = lastApprovalId(tg)!;
    await Promise.all([
      fs.ingest(action({ platform: "feishu", userId: "ou_ada", actionId: "deny", value: id })),
      tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: id })),
    ]);
    await gw.waitForIdle();
    expect(decisions).toHaveLength(1);
    gw.close();
  });

  it("A5: approval times out, unblocks the conversation, and later messages are answered", async () => {
    const seen: string[] = [];
    const driver = new ScriptedDriver(async (sink) => {
      seen.push("turn");
      if (seen.length === 1) {
        await sink.requestApproval({ toolCallId: "t", title: "ok?", options: ["approve", "deny"] });
      } else {
        sink.text("back");
      }
    });
    const { gw, tg } = openGateway({ driver, approvalTimeoutMs: 80 });
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "first" }));
    await waitFor(() => Boolean(lastApprovalId(tg)));
    for (const t of ["are you there?", "hello??", "cancel"]) await tg.ingest(dm({ platform: "telegram", userId: "ada", text: t }));
    await waitFor(() => seen.length >= 2, 2000);
    expect(seen.length).toBeGreaterThan(1);
    gw.close();
  });

  it("A6: restart expires stale pending approvals; click does not resume the dead turn", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "imw-")), "s.sqlite");
    const driver = new ScriptedDriver(async (sink) => {
      await sink.requestApproval({ toolCallId: "t", title: "deploy?", options: ["approve", "deny"] });
      sink.text("deployed");
    });
    const a = openGateway({ driver, dbPath });
    await bootstrapAndPairFeishu(a.gw, a.tg, a.fs);
    await a.tg.ingest(dm({ platform: "telegram", userId: "ada", text: "deploy" }));
    await waitFor(() => Boolean(lastApprovalId(a.tg)));
    const id = lastApprovalId(a.tg)!;
    a.gw.close();

    const d2 = new ScriptedDriver(async (sink) => {
      sink.text("fresh");
    });
    const b = openGateway({ driver: d2, dbPath });
    const conv = b.gw.store.getApproval(id)!.conversationId;
    expect(b.gw.store.getApproval(id)!.state).toBe("denied");
    expect(b.gw.store.pendingApprovals(conv)).toHaveLength(0);
    await b.tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: id }));
    expect(markdownCalls(b.tg).some((t) => /deployed/.test(t))).toBe(false);
    b.gw.close();
  });
});

describe("ADV concurrency", () => {
  it("A7: mid-stream cross-IM message is queued and answered when the driver has no steer()", async () => {
    const driver = new RecordingDriver();
    const { gw, tg, fs } = openGateway({ driver });
    driver.hold = false;
    await bootstrapAndPairFeishu(gw, tg, fs);
    driver.hold = true;
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "Q1 from TG" }));
    await waitFor(() => driver.prompts.length === 1);
    await fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: "Q2 from Feishu (different question)" }));
    driver.hold = false;
    driver.releaseAll();
    await gw.waitForIdle();
    await tick();
    expect(driver.prompts.join("\n")).toContain("Q2 from Feishu (different question)");
    gw.close();
  });

  it("A8: same-surface follow-ups are all answered (batched into one turn)", async () => {
    const driver = new RecordingDriver();
    const { gw, tg } = openGateway({ driver });
    driver.hold = false;
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
    driver.prompts = [];
    driver.hold = true;
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "M1" }));
    await waitFor(() => driver.prompts.length === 1);
    for (const t of ["M2", "M3", "M4"]) await tg.ingest(dm({ platform: "telegram", userId: "ada", text: t }));
    driver.hold = false;
    driver.releaseAll();
    await gw.waitForIdle();
    await tick();
    expect(driver.prompts[0]).toBe("M1");
    expect(driver.prompts.slice(1).join("\n")).toContain("M2");
    expect(driver.prompts.slice(1).join("\n")).toContain("M3");
    expect(driver.prompts.slice(1).join("\n")).toContain("M4");
    gw.close();
  });

  it("A9: a conversation never runs two turns at once", async () => {
    const driver = new RecordingDriver();
    const { gw, tg } = openGateway({ driver });
    driver.hold = false;
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
    driver.prompts = [];
    driver.hold = true;
    const origDraft = tg.draft.bind(tg);
    let slow: (() => void) | undefined;
    let draftCalls = 0;
    tg.draft = async (c, o) => {
      draftCalls += 1;
      if (draftCalls === 3) await new Promise<void>((r) => (slow = r));
      return origDraft(c, o);
    };
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "M1" }));
    await waitFor(() => driver.prompts.length === 1);
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "M2" }));
    driver.releaseAll();
    await tick();
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "M3" }), { wait: false });
    driver.releaseAll();
    await tick();
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "M4 in the gap" }));
    await tick();
    slow?.();
    await tick();
    await tick();
    driver.hold = false;
    driver.releaseAll();
    await tick();
    driver.releaseAll();
    await gw.waitForIdle();
    expect(driver.maxConcurrent).toBe(1);
    expect(driver.prompts.join("\n")).toContain("M1");
    expect(driver.prompts.join("\n")).toContain("M2");
    expect(driver.prompts.join("\n")).toContain("M3");
    expect(driver.prompts.join("\n")).toContain("M4 in the gap");
    const order = driver.prompts.join("\n");
    expect(order.indexOf("M1")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("M2")).toBeGreaterThan(order.indexOf("M1"));
    expect(order.indexOf("M3")).toBeGreaterThan(order.indexOf("M2"));
    expect(order.indexOf("M4 in the gap")).toBeGreaterThan(order.indexOf("M3"));
    gw.close();
  });

  it("A10: switch during finalize is queued, not orphaned", async () => {
    const driver = new RecordingDriver();
    const { gw, tg, fs } = openGateway({ driver });
    driver.hold = false;
    await bootstrapAndPairFeishu(gw, tg, fs);
    driver.prompts = [];
    driver.hold = true;
    const origDraft = tg.draft.bind(tg);
    let finalizeGate: (() => void) | undefined;
    tg.draft = async (c, o) => {
      const d = await origDraft(c, o);
      const fin = d.finalize.bind(d);
      (d as DraftHandle).finalize = async (m) => {
        await new Promise<void>((r) => (finalizeGate = r));
        return fin(m);
      };
      return d;
    };
    let fsDrafts = 0;
    let fsFinalized = 0;
    const origFsDraft = fs.draft.bind(fs);
    fs.draft = async (c, o) => {
      fsDrafts += 1;
      const d = await origFsDraft(c, o);
      const fin = d.finalize.bind(d);
      (d as DraftHandle).finalize = async (m) => {
        fsFinalized += 1;
        return fin(m);
      };
      return d;
    };
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "Q1" }));
    await waitFor(() => driver.prompts.length === 1);
    driver.releaseAll();
    await waitFor(() => Boolean(finalizeGate));
    await fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: "Q2 from Feishu" }));
    finalizeGate!();
    driver.hold = false;
    driver.releaseAll();
    await gw.waitForIdle();
    await tick();
    expect(driver.prompts.join("\n")).toContain("Q2 from Feishu");
    expect(fsDrafts === 0 || fsFinalized === fsDrafts).toBe(true);
    expect(markdownCalls(fs).some((t) => /Q2 from Feishu|re:/.test(t))).toBe(true);
    gw.close();
  });
});

describe("ADV groups", () => {
  it("A11: unlinked @mentions in a group are throttled (not one public reply each)", async () => {
    const { gw, tg } = openGateway();
    for (let i = 0; i < 20; i += 1) await tg.ingest(groupMsg({ platform: "telegram", chatId: "g1", userId: `u${i}`, text: "@bot hi" }));
    const n = tg.calls.filter((c) => c.op === "send").length;
    expect(n).toBeLessThanOrEqual(1);
    gw.close();
  });

  it("A12: group conversation is isolated from the owner's DM context (positive check)", async () => {
    const snaps: number[] = [];
    const driver: AgentDriver = {
      ensureSession: async (c) => {
        snaps.push(c.messages.length);
        return { agentSessionId: c.id };
      },
      prompt: async () => ({ text: "x" }),
      cancel: async () => {},
    };
    const { gw, tg } = openGateway({ driver });
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "secret DM" }));
    await gw.waitForIdle();
    await tg.ingest(groupMsg({ platform: "telegram", chatId: "g1", userId: "ada", text: "@bot hi" }));
    await gw.waitForIdle();
    expect(snaps.at(-1)).toBe(1);
    gw.close();
  });
});
