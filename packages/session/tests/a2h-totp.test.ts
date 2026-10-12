import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Clock, Inbound } from "@imwire/core";
import type { FakeAdapter } from "@imwire/core/testing";
import type { ApproverVerifier } from "../src/a2h.js";
import { SessionGateway } from "../src/gateway.js";
import { ScriptedDriver } from "../src/scripted-driver.js";
import {
  base32Decode,
  base32Encode,
  hotp,
  matchTotpStep,
  openSecret,
  sealSecret,
  totp,
  TotpVerifier,
} from "../src/totp.js";
import { action, chat, cmd, dm, extractPairCode, fakeAdapter, markdownCalls, owner } from "./helpers.js";

class ManualClock implements Clock {
  constructor(public t = Date.UTC(2026, 9, 12, 4, 0, 5)) {}
  now(): number {
    return this.t;
  }
  sleep(): Promise<void> {
    return new Promise(() => undefined);
  }
}

describe("RFC 6238 / 4226", () => {
  const secret = Buffer.from("12345678901234567890");
  it("matches the RFC 6238 SHA1 test vectors (6-digit truncation)", () => {
    expect(totp(secret, 59_000)).toBe("287082");
    expect(totp(secret, 1_111_111_109_000)).toBe("081804");
    expect(totp(secret, 1_234_567_890_000)).toBe("005924");
    expect(totp(secret, 2_000_000_000_000)).toBe("279037");
  });
  it("matches the RFC 4226 HOTP vectors", () => {
    expect([0, 1, 2, 9].map((c) => hotp(secret, c))).toEqual(["755224", "287082", "359152", "520489"]);
  });
  it("accepts ±1 step only", () => {
    const now = 1_000_000_000_000;
    expect(matchTotpStep(secret, totp(secret, now - 30_000), now)).toBeDefined();
    expect(matchTotpStep(secret, totp(secret, now + 30_000), now)).toBeDefined();
    expect(matchTotpStep(secret, totp(secret, now - 90_000), now)).toBeUndefined();
    expect(matchTotpStep(secret, "12345", now)).toBeUndefined();
  });
  it("base32 round-trips and secrets are sealed with AES-GCM", () => {
    const raw = randomBytes(20);
    expect(base32Decode(base32Encode(raw)).equals(raw)).toBe(true);
    const key = randomBytes(32);
    const sealed = sealSecret(key, raw);
    expect(sealed.includes(raw)).toBe(false);
    expect(openSecret(key, sealed).equals(raw)).toBe(true);
    expect(() => openSecret(randomBytes(32), sealed)).toThrow();
  });
});

interface World {
  gw: SessionGateway;
  tg: FakeAdapter;
  fs: FakeAdapter;
  clock: ManualClock;
  ada: string;
  secret: Buffer;
  recovery: string[];
  agentId: string;
  code: () => string;
  next: () => void;
}

/** Full owner bootstrap in totp mode: initOwner → /claim on Telegram. */
async function world(opts?: { verifier?: (s: TotpVerifier) => ApproverVerifier; allow?: string[] }): Promise<World> {
  const clock = new ManualClock();
  const key = randomBytes(32);
  const gw = new SessionGateway({
    dbPath: ":memory:",
    driver: new ScriptedDriver(),
    allowlist: [owner("telegram", "ada"), { platform: "feishu", accountId: "bot", userId: "ou_ada" }, ...(opts?.allow ?? []).map((u) => owner("telegram", u))],
    clock,
    sweepIntervalMs: 0,
    identityMode: "totp",
    approverVerifier: (store) => {
      const tv = new TotpVerifier({ store, masterKey: key });
      // Overrides keep the TotpVerifier prototype so identityMode "totp" still accepts it.
      return opts?.verifier ? Object.assign(Object.create(tv) as TotpVerifier, opts.verifier(tv)) : tv;
    },
  });
  const tg = fakeAdapter("telegram");
  const fs = fakeAdapter("feishu");
  gw.attach(tg);
  gw.attach(fs);
  const init = gw.initOwner({ name: "佳恒" });
  const secret = base32Decode(init.secretBase32);
  const code = () => totp(secret, clock.now());
  const next = () => {
    clock.t += 30_000;
  };
  await tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "claim", args: `${init.claimCode} ${code()}` }));
  await gw.waitForIdle();
  next();
  const ada = gw.store.findIdentity("telegram", "bot", "ada")!.personId;
  expect(ada).toBe(init.personId);
  const agent = gw.store.createAgent("codex-mac", "sha256:x", clock.now());
  gw.grantAgent(agent.id, ada, ["send", "ask", "approve"]);
  return { gw, tg, fs, clock, ada, secret, recovery: init.recoveryCodes, agentId: agent.id, code, next };
}

function lastText(a: FakeAdapter): string {
  return markdownCalls(a).at(-1) ?? "";
}

let k = 5000;
function quote(platform: string, userId: string, text: string, ref: { chat: ReturnType<typeof chat>; messageId: string }): Inbound {
  k += 1;
  return { type: "message", id: `q${k}`, ts: 0, chat: chat(platform, userId), from: { platform, accountId: "bot", userId }, messageId: `qm${k}`, text, mentionsBot: true, replyTo: ref };
}

function approvalOf(w: World, requestId: string): string {
  return w.gw.store.getA2hRequest(requestId)!.approvalId!;
}

function allStoredText(w: World): string {
  return JSON.stringify(w.gw.store.db.prepare("SELECT content FROM message").all()) +
    JSON.stringify(w.gw.store.db.prepare("SELECT * FROM audit_log").all());
}

describe("a2h PR2.5: full TOTP step-up flow", () => {
  it("send approval → click Approve → step-up required → correct TOTP → approved (verified)", async () => {
    const w = await world();
    const req = await w.gw.createAgentApproval({ agentId: w.agentId, to: w.ada, title: "deploy prod" });
    expect(req.requiredLevel).toBe("verified");
    expect(lastText(w.tg)).toContain(`/approve ${req.code}`);

    await w.tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: approvalOf(w, req.requestId) }));
    let v = w.gw.getAgentRequest(w.agentId, req.requestId);
    expect(v).toMatchObject({ status: "pending", approved: false, stepUpRequired: true });
    expect(lastText(w.tg)).toContain("需要验证码");

    const totpCode = w.code();
    await w.tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "approve", args: `${req.code} ${totpCode}` }));
    await w.gw.waitForIdle();
    v = w.gw.getAgentRequest(w.agentId, req.requestId);
    expect(v).toMatchObject({ status: "approved", approved: true, decidedLevel: "verified", requiredLevel: "verified" });
    // Nothing secret anywhere persistent.
    const dump = allStoredText(w);
    expect(dump).not.toContain(totpCode);
    expect(dump).not.toContain(base32Encode(w.secret));
    for (const rc of w.recovery) expect(dump).not.toContain(rc);
    const creds = JSON.stringify(w.gw.store.db.prepare("SELECT kind, hex(secret_enc) h, code_hash FROM person_credential").all());
    expect(creds).not.toContain(w.secret.toString("hex").toUpperCase());
    for (const rc of w.recovery) expect(creds).not.toContain(rc);
    w.gw.close();
  });

  it("quote-replying 6 digits to the card works and the code is never stored", async () => {
    const w = await world();
    const req = await w.gw.createAgentApproval({ agentId: w.agentId, to: w.ada, title: "x" });
    const card = (w.tg.calls.filter((c) => c.op === "send").at(-1)!.args as { ref: { chat: never; messageId: string } }).ref;
    await w.tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: approvalOf(w, req.requestId) }));
    const c = w.code();
    await w.tg.ingest(quote("telegram", "ada", c, card));
    await w.gw.waitForIdle();
    expect(w.gw.getAgentRequest(w.agentId, req.requestId).status).toBe("approved");
    expect(allStoredText(w)).not.toContain(c);
    w.gw.close();
  });

  it("a bare code DM with one approval awaiting step-up is consumed, not sent to pi or logged", async () => {
    const w = await world();
    const req = await w.gw.createAgentApproval({ agentId: w.agentId, to: w.ada, title: "x" });
    await w.tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: approvalOf(w, req.requestId) }));
    const c = w.code();
    await w.tg.ingest(dm({ platform: "telegram", userId: "ada", text: c }));
    await w.gw.waitForIdle();
    expect(w.gw.getAgentRequest(w.agentId, req.requestId).status).toBe("approved");
    expect(allStoredText(w)).not.toContain(c);
    w.gw.close();
  });

  it("free text with a code quoted on a card is stored masked", async () => {
    const w = await world();
    await w.gw.createAgentApproval({ agentId: w.agentId, to: w.ada, title: "x" });
    const card = (w.tg.calls.filter((c) => c.op === "send").at(-1)!.args as { ref: { chat: never; messageId: string } }).ref;
    await w.tg.ingest(quote("telegram", "ada", "同意 654321 吧", card));
    await w.gw.waitForIdle();
    const dump = allStoredText(w);
    expect(dump).not.toContain("654321");
    expect(dump).toContain("同意 ****** 吧");
    w.gw.close();
  });

  it("Deny never needs a code", async () => {
    const w = await world();
    const req = await w.gw.createAgentApproval({ agentId: w.agentId, to: w.ada, title: "x" });
    await w.tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "deny", value: approvalOf(w, req.requestId) }));
    expect(w.gw.getAgentRequest(w.agentId, req.requestId)).toMatchObject({ status: "denied", approved: false });
    w.gw.close();
  });
});

describe("a2h PR2.5: never approve on failure", () => {
  async function clicked(w: World) {
    const req = await w.gw.createAgentApproval({ agentId: w.agentId, to: w.ada, title: "x" });
    await w.tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: approvalOf(w, req.requestId) }));
    return req;
  }

  it("wrong code", async () => {
    const w = await world();
    const req = await clicked(w);
    const wrong = w.code() === "000000" ? "111111" : "000000";
    await w.tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "approve", args: `${req.code} ${wrong}` }));
    expect(w.gw.getAgentRequest(w.agentId, req.requestId).status).toBe("pending");
    expect(lastText(w.tg)).toContain("验证码不对");
    w.gw.close();
  });

  it("replay: the same code (same step) cannot approve a second request", async () => {
    const w = await world();
    const a = await clicked(w);
    const b = await clicked(w);
    const c = w.code();
    await w.tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "approve", args: `${a.code} ${c}` }));
    await w.tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "approve", args: `${b.code} ${c}` }));
    expect(w.gw.getAgentRequest(w.agentId, a.requestId).status).toBe("approved");
    expect(w.gw.getAgentRequest(w.agentId, b.requestId).status).toBe("pending");
    expect(lastText(w.tg)).toContain("已经用过");
    // An older step is also refused.
    const old = totp(w.secret, w.clock.now() - 30_000);
    await w.tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "approve", args: `${b.code} ${old}` }));
    expect(w.gw.getAgentRequest(w.agentId, b.requestId).status).toBe("pending");
    w.next();
    await w.tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "approve", args: `${b.code} ${w.code()}` }));
    expect(w.gw.getAgentRequest(w.agentId, b.requestId).status).toBe("approved");
    w.gw.close();
  });

  it("a step-up is bound to one request; a click on another request still needs its own", async () => {
    const w = await world();
    const a = await clicked(w);
    const b = await clicked(w);
    await w.tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "approve", args: `${a.code} ${w.code()}` }));
    await w.tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: approvalOf(w, b.requestId) }));
    expect(w.gw.getAgentRequest(w.agentId, b.requestId)).toMatchObject({ status: "pending", stepUpRequired: true });
    w.gw.close();
  });

  it("cooling-off: a freshly paired IM cannot approve (click or code) for 24 h", async () => {
    const w = await world();
    await w.tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "pair" }));
    const pc = extractPairCode(...markdownCalls(w.tg))!;
    await w.fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: `${pc} ${w.code()}` }));
    w.next();
    expect(w.gw.store.findIdentity("feishu", "bot", "ou_ada")).toMatchObject({ personId: w.ada, linkedVia: "pair+totp" });

    const req = await w.gw.createAgentApproval({ agentId: w.agentId, to: w.ada, title: "x" });
    const id = approvalOf(w, req.requestId);
    await w.fs.ingest(action({ platform: "feishu", userId: "ou_ada", actionId: "approve", value: id }));
    expect(w.gw.getAgentRequest(w.agentId, req.requestId)).toMatchObject({ status: "pending", stepUpRequired: false });
    expect(lastText(w.fs)).toContain("冷静期");
    await w.fs.ingest(cmd({ platform: "feishu", userId: "ou_ada", name: "approve", args: `${req.code} ${w.code()}` }));
    expect(w.gw.getAgentRequest(w.agentId, req.requestId).status).toBe("pending");
    expect(w.gw.store.auditEntries().some((e) => e.result === "cooling_off")).toBe(true);

    w.clock.t += 24 * 3600_000; // cooldown over (new request: the old one has expired)
    const r2 = await w.gw.createAgentApproval({ agentId: w.agentId, to: w.ada, title: "y" });
    await w.fs.ingest(action({ platform: "feishu", userId: "ou_ada", actionId: "approve", value: approvalOf(w, r2.requestId) }));
    await w.fs.ingest(cmd({ platform: "feishu", userId: "ou_ada", name: "approve", args: `${r2.code} ${w.code()}` }));
    expect(w.gw.getAgentRequest(w.agentId, r2.requestId).status).toBe("approved");
    w.gw.close();
  });

  it("group click never decides, and /approve in a group is refused without logging the code", async () => {
    const w = await world();
    const req = await w.gw.createAgentApproval({ agentId: w.agentId, to: w.ada, title: "x" });
    const id = approvalOf(w, req.requestId);
    const inGroup = (actionId: string) =>
      ({
        ...action({ platform: "telegram", userId: "ada", actionId, value: id }),
        target: { chat: chat("telegram", "g1", "group"), messageId: "x" },
      }) as Inbound;
    await w.tg.ingest(inGroup("approve"));
    await w.tg.ingest(inGroup("deny"));
    expect(w.gw.getAgentRequest(w.agentId, req.requestId)).toMatchObject({ status: "pending", stepUpRequired: false });
    expect(w.gw.store.auditEntries().filter((e) => e.result === "group_click")).toHaveLength(2);
    const c = w.code();
    await w.tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "approve", args: `${req.code} ${c}`, chatId: "g1", kind: "group" }));
    await w.gw.waitForIdle();
    expect(w.gw.getAgentRequest(w.agentId, req.requestId).status).toBe("pending");
    expect(allStoredText(w)).not.toContain(c);
    w.gw.close();
  });

  it("verifier error is fail-closed", async () => {
    const w = await world({
      verifier: () => ({
        verifyApprover: () => {
          throw new Error("secret-ish detail");
        },
      }),
    });
    const req = await clicked(w);
    expect(w.gw.getAgentRequest(w.agentId, req.requestId).status).toBe("pending");
    const audit = w.gw.store.auditEntries().find((e) => e.result === "unverified_click")!;
    expect(audit.detail).toContain("verifier_error");
    expect(audit.detail).not.toContain("secret-ish");
    w.gw.close();
  });

  it("lockout: 5 wrong codes in 15 min lock, deny every pending approval, notify, and refuse the right code", async () => {
    const w = await world();
    const a = await clicked(w);
    const b = await w.gw.createAgentApproval({ agentId: w.agentId, to: w.ada, title: "other" });
    const good = w.code();
    const wrong = good === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i += 1) {
      await w.tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "approve", args: `${a.code} ${wrong}` }));
    }
    expect(w.gw.getAgentRequest(w.agentId, a.requestId)).toMatchObject({ status: "denied", approved: false });
    expect(w.gw.getAgentRequest(w.agentId, b.requestId).status).toBe("denied");
    expect(markdownCalls(w.tg).some((t) => t.includes("已锁定 15 分钟"))).toBe(true);
    const c = await w.gw.createAgentApproval({ agentId: w.agentId, to: w.ada, title: "third" });
    await w.tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: approvalOf(w, c.requestId) }));
    await w.tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "approve", args: `${c.code} ${w.code()}` }));
    expect(w.gw.getAgentRequest(w.agentId, c.requestId).status).not.toBe("approved");
    w.clock.t += 16 * 60_000;
    const d = await clicked(w);
    await w.tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "approve", args: `${d.code} ${w.code()}` }));
    expect(w.gw.getAgentRequest(w.agentId, d.requestId).status).toBe("approved");
    w.gw.close();
  });
});

describe("a2h PR2.5: policy", () => {
  it("per-agent downgrade makes it button-only; risk=high overrides the downgrade", async () => {
    const w = await world();
    w.gw.store.setAgentApprovalLevel(w.agentId, "im_account");
    const low = await w.gw.createAgentApproval({ agentId: w.agentId, to: w.ada, title: "x" });
    expect(low.requiredLevel).toBe("im_account");
    await w.tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: approvalOf(w, low.requestId) }));
    expect(w.gw.getAgentRequest(w.agentId, low.requestId)).toMatchObject({ status: "approved", decidedLevel: "im_account" });
    const high = await w.gw.createAgentApproval({ agentId: w.agentId, to: w.ada, title: "y", risk: "high" });
    expect(high.requiredLevel).toBe("verified");
    w.gw.close();
  });

  it("required_level is pinned at creation", async () => {
    const w = await world();
    const req = await w.gw.createAgentApproval({ agentId: w.agentId, to: w.ada, title: "x" });
    w.gw.store.setAgentApprovalLevel(w.agentId, "im_account");
    await w.tg.ingest(action({ platform: "telegram", userId: "ada", actionId: "approve", value: approvalOf(w, req.requestId) }));
    expect(w.gw.getAgentRequest(w.agentId, req.requestId)).toMatchObject({ status: "pending", stepUpRequired: true });
    w.gw.close();
  });

  it("a person without TOTP cannot be targeted (legacy owner, fail-closed)", async () => {
    const w = await world();
    const legacy = w.gw.store.createPerson("old", 0);
    w.gw.store.linkIdentity(legacy.id, "telegram", "bot", "ada2", 0, "legacy");
    expect(w.gw.isA2hTargetAllowed(legacy.id)).toBe(false);
    w.gw.close();
  });
});

describe("a2h PR2.5: /claim and /pair", () => {
  it("allowlisted first DM is not auto-owner in totp mode; non-allowlisted IDs cannot claim or pair", async () => {
    const w = await world({ allow: ["carol"] });
    await w.tg.ingest(dm({ platform: "telegram", userId: "carol", text: "hi" }));
    expect(w.gw.store.findIdentity("telegram", "bot", "carol")).toBeUndefined();
    expect(lastText(w.tg)).toContain("/claim");

    await w.tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "pair" }));
    const pc = extractPairCode(...markdownCalls(w.tg))!;
    await w.tg.ingest(dm({ platform: "telegram", userId: "mallory", text: `${pc} ${w.code()}` }));
    expect(w.gw.store.findIdentity("telegram", "bot", "mallory")).toBeUndefined();
    w.gw.close();
  });

  it("/claim: wrong TOTP or reused code fails", async () => {
    const w = await world({ allow: ["carol"] });
    const init = w.gw.initOwner({ name: "Carol" });
    const sec = base32Decode(init.secretBase32);
    const wrong = totp(sec, w.clock.now()) === "000000" ? "111111" : "000000";
    await w.tg.ingest(cmd({ platform: "telegram", userId: "carol", name: "claim", args: `${init.claimCode} ${wrong}` }));
    expect(w.gw.store.findIdentity("telegram", "bot", "carol")).toBeUndefined();
    await w.tg.ingest(cmd({ platform: "telegram", userId: "carol", name: "claim", args: `${init.claimCode} ${totp(sec, w.clock.now())}` }));
    expect(w.gw.store.findIdentity("telegram", "bot", "carol")).toMatchObject({ personId: init.personId, linkedVia: "claim" });
    w.gw.close();
  });

  it("/pair needs code + TOTP; success notifies every bound surface", async () => {
    const w = await world();
    await w.tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "pair" }));
    const pc = extractPairCode(...markdownCalls(w.tg))!;
    await w.fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: pc }));
    expect(w.gw.store.findIdentity("feishu", "bot", "ou_ada")).toBeUndefined();
    expect(lastText(w.fs)).toContain("还需要验证码");
    const wrong = w.code() === "000000" ? "111111" : "000000";
    await w.fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: `${pc} ${wrong}` }));
    expect(w.gw.store.findIdentity("feishu", "bot", "ou_ada")).toBeUndefined();
    await w.fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: `${pc} ${w.code()}` }));
    expect(w.gw.store.findIdentity("feishu", "bot", "ou_ada")?.linkedVia).toBe("pair+totp");
    expect(markdownCalls(w.tg).some((t) => t.startsWith("新增绑定：feishu ou_ada"))).toBe(true);
    expect(w.gw.store.auditEntries().some((e) => e.action === "pair" && e.result === "linked")).toBe(true);
    w.gw.close();
  });

  it("recovery codes are single use", async () => {
    const w = await world();
    const v = new TotpVerifier({ store: w.gw.store, masterKey: randomBytes(32) });
    expect(v.useRecoveryCode(w.ada, w.recovery[0]!, w.clock.now())).toBe(true);
    expect(v.useRecoveryCode(w.ada, w.recovery[0]!, w.clock.now())).toBe(false);
    w.gw.close();
  });

  it("totp mode requires a TotpVerifier", () => {
    expect(
      () => new SessionGateway({ dbPath: ":memory:", driver: new ScriptedDriver(), identityMode: "totp", sweepIntervalMs: 0 }),
    ).toThrow(/TotpVerifier/);
  });
});
