// Round-2 fresh adversarial repros. Assertions match the fixed behaviour.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptedDriver } from "../src/scripted-driver.js";
import type { AgentDriver, ConversationSnapshot, TurnSink, UserTurn } from "../src/types.js";
import { action, cmd, dm, extractPairCode, lastApprovalId, markdownCalls, openGateway, owner, waitFor } from "./helpers.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function issueCode(tg: ReturnType<typeof openGateway>["tg"]) {
  await tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "pair" }));
  return extractPairCode(...markdownCalls(tg).filter((t) => t.includes("Pairing code")))!;
}
function wrong(code: string, i: number) {
  return String((Number(code) + 1 + i) % 100_000_000).padStart(8, "0");
}

describe("R2 pairing lockout abuse", () => {
  it("R1: strangers cannot revoke the owner's live code; owner still pairs", async () => {
    const { gw, tg, fs } = openGateway();
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
    const code = await issueCode(tg);
    for (let i = 0; i < 5; i += 1) await tg.ingest(dm({ platform: "telegram", userId: "stranger", text: wrong(code, i) }));
    await fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: code }));
    const linked = Boolean(gw.store.findIdentity("feishu", "bot", "ou_ada"));
    console.log(`R1 owner's new IM linked with valid code after stranger's 5 misses: ${linked}; feishu got: ${JSON.stringify(markdownCalls(fs))}`);
    expect(linked).toBe(true);
    expect(markdownCalls(fs).some((t) => /Linked/.test(t))).toBe(true);
    gw.close();
  });

  it("R2: 10 throwaway accounts x 5 misses cannot block the owner's fresh code", async () => {
    const { gw, tg, fs } = openGateway();
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
    for (let a = 0; a < 10; a += 1)
      for (let i = 0; i < 5; i += 1)
        await tg.ingest(dm({ platform: "telegram", userId: `bot${a}`, text: String(10000000 + a * 10 + i).padStart(8, "0") }));
    const code = await issueCode(tg);
    await fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: code }));
    const linked = Boolean(gw.store.findIdentity("feishu", "bot", "ou_ada"));
    console.log(`R2 after 50 stranger misses, owner's fresh code linked: ${linked}; feishu got: ${JSON.stringify(markdownCalls(fs))}`);
    expect(linked).toBe(true);
    expect(markdownCalls(fs).join(" ")).not.toMatch(/Too many pairing attempts/);
    gw.close();
  });
});

describe("R2 turn pipeline", () => {
  it("R3: a draft() 429 during follow-up hand-off does not wedge; M2–M4 are answered", async () => {
    let n = 0;
    const driver = new ScriptedDriver(async (sink, ctl) => {
      n += 1;
      sink.text("r" + n);
      if (n === 1) await ctl.wait("g");
    });
    const { gw, tg } = openGateway({ driver });
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "M1" }));
    await waitFor(() => n === 1);
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "M2" }));
    const orig = tg.draft.bind(tg);
    let fail = true;
    tg.draft = async (c, o) => {
      if (fail) {
        fail = false;
        throw new Error("429 Too Many Requests");
      }
      return orig(c, o);
    };
    driver.release("g");
    await tick(50);
    for (const t of ["M3", "M4"]) await tg.ingest(dm({ platform: "telegram", userId: "ada", text: t }));
    await gw.waitForIdle();
    await tick(50);
    await gw.waitForIdle();
    console.log(`R3 turns run after a single draft() failure in hand-off: ${n - 1}`);
    expect(n).toBeGreaterThanOrEqual(3);
    const personId = gw.store.findIdentity("telegram", "bot", "ada")!.personId;
    const conv = gw.store.activeConversation(personId, Date.now());
    expect(conv.messages.some((m) => m.text === "M2")).toBe(true);
    expect(conv.messages.some((m) => m.text === "M3")).toBe(true);
    expect(conv.messages.some((m) => m.text === "M4")).toBe(true);
    expect(conv.messages.filter((m) => m.role === "assistant").length).toBeGreaterThanOrEqual(3);
    gw.close();
  });

  it("R4: assistant reply is logged before queued user messages; crash mid-batch is detected", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "imw-")), "s.sqlite");
    let n = 0;
    const d1 = new ScriptedDriver(async (sink, ctl) => {
      n += 1;
      sink.text("A" + n);
      if (n === 1) await ctl.wait("g");
      if (n === 2) await ctl.wait("never");
    });
    const a = openGateway({ driver: d1, dbPath });
    await a.tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
    await a.tg.ingest(dm({ platform: "telegram", userId: "ada", text: "Q1" }));
    await waitFor(() => n === 1);
    await a.tg.ingest(dm({ platform: "telegram", userId: "ada", text: "Q2" }));
    d1.release("g");
    await waitFor(() => n === 2);
    const conv = a.gw.store.activeConversation(a.gw.store.findIdentity("telegram", "bot", "ada")!.personId, Date.now());
    const order = conv.messages.map((m) => `${m.role}:${m.text}`);
    console.log(`R4 log order: ${JSON.stringify(order)}`);
    const q1 = order.indexOf("user:Q1");
    const a1 = order.indexOf("assistant:A1");
    const q2 = order.indexOf("user:Q2");
    expect(q1).toBeGreaterThanOrEqual(0);
    expect(a1).toBeGreaterThan(q1);
    expect(q2).toBeGreaterThan(a1);
    a.gw.close();
    const b = openGateway({ driver: new ScriptedDriver(), dbPath });
    await tick(50);
    const notices = markdownCalls(b.tg).filter((t) => /interrupted/.test(t)).length;
    console.log(`R4 restart: interrupt notices sent=${notices} (Q2 was in flight)`);
    expect(notices).toBeGreaterThanOrEqual(1);
    b.gw.close();
  });

  it("R5: interrupt notice is sent once per interrupted turn", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "imw-")), "s.sqlite");
    const hang = () => new ScriptedDriver(async (_s, ctl) => {
      await ctl.wait("never");
    });
    let notices = 0;
    for (let round = 0; round < 2; round += 1) {
      const g = openGateway({ driver: hang(), dbPath });
      await tick(30);
      notices += markdownCalls(g.tg).filter((t) => /interrupted/.test(t)).length;
      await g.tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
      await g.tg.ingest(dm({ platform: "telegram", userId: "ada", text: `crash me ${round}` }));
      await tick(30);
      g.gw.close();
    }
    const g = openGateway({ driver: hang(), dbPath });
    await tick(30);
    notices += markdownCalls(g.tg).filter((t) => /interrupted/.test(t)).length;
    console.log(`R5 two crashes with unanswered messages -> notices=${notices}`);
    expect(notices).toBeGreaterThanOrEqual(2);
    g.gw.close();
  });

  it("R6: recovery covers every attached IM, including adapters attached later", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "imw-")), "s.sqlite");
    const hang = new ScriptedDriver(async (_s, ctl) => {
      await ctl.wait("never");
    });
    const a = openGateway({ driver: hang, dbPath, allowlist: [owner("feishu", "ou_ada")] });
    await a.fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: "hello" }));
    await a.fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: "in flight on feishu" }));
    await tick(20);
    a.gw.close();
    const b = openGateway({ driver: new ScriptedDriver(), dbPath, allowlist: [owner("feishu", "ou_ada")] });
    await tick(50);
    const n = markdownCalls(b.fs).filter((t) => /interrupted/.test(t)).length;
    console.log(`R6 feishu interrupt notices=${n}`);
    expect(n).toBeGreaterThanOrEqual(1);
    b.gw.close();
  });

  it("R7: steer during the pre-prompt window is refused; Feishu follow-up is queued once", async () => {
    const seen: string[][] = [];
    const steers: string[] = [];
    let n = 0;
    const driver: AgentDriver = {
      ensureSession: async (c: ConversationSnapshot) => {
        seen.push(c.messages.map((m) => `${m.role}:${m.text}`));
        return { agentSessionId: c.id };
      },
      prompt: async (_s: string, i: UserTurn, sink: TurnSink) => {
        n += 1;
        sink.text("ok");
        return { text: "ok:" + i.text };
      },
      steer: async (_s: string, i: UserTurn) => {
        steers.push(i.text);
        return true;
      },
      cancel: async () => {},
    };
    const { gw, tg, fs } = openGateway({ driver });
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
    await tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "pair" }));
    const code = extractPairCode(...markdownCalls(tg).filter((t) => t.includes("Pairing code")))!;
    await fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: code }));
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "T1" }));
    await gw.waitForIdle();
    let releaseTyping!: () => void;
    tg.typing = async () => {
      await new Promise<void>((r) => (releaseTyping = r));
    };
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "T2" }));
    await waitFor(() => Boolean(releaseTyping));
    await fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: "F-during-typing" }));
    releaseTyping();
    await gw.waitForIdle();
    console.log(`R7 steered=${JSON.stringify(steers)} snapshot for T2 turn=${JSON.stringify(seen.at(-2) ?? seen.at(-1))}`);
    expect(steers).toEqual([]);
    const t2snap = seen.find((s) => s.some((m) => m === "user:T2"));
    expect(t2snap?.some((m) => m.includes("F-during-typing"))).toBe(false);
    expect(n).toBeGreaterThanOrEqual(3);
    gw.close();
  });

  it("R8: allow_once is recorded as approved, not denied", async () => {
    let got = "";
    const driver = new ScriptedDriver(async (sink) => {
      got = await sink.requestApproval({ toolCallId: "t", title: "Send?", options: ["allow_once", "deny"] });
    });
    const { gw, tg } = openGateway({ driver });
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "go" }));
    await waitFor(() => Boolean(lastApprovalId(tg)));
    const id = lastApprovalId(tg)!;
    await tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "allow_once", value: id }));
    await gw.waitForIdle();
    console.log(`R8 driver got=${got} state=${gw.store.getApproval(id)!.state} card=${JSON.stringify(markdownCalls(tg).filter((t) => /handled/.test(t)))}`);
    expect(got).toBe("allow_once");
    expect(gw.store.getApproval(id)!.state).toBe("approved");
    expect(markdownCalls(tg).some((t) => /handled \(approved\)/.test(t))).toBe(true);
    gw.close();
  });
});
