import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionGateway } from "../src/gateway.js";
import { ScriptedDriver } from "../src/scripted-driver.js";
import { SessionStore } from "../src/store.js";
import {
  action,
  cmd,
  dm,
  extractPairCode,
  groupMsg,
  lastApprovalId,
  markdownCalls,
  openGateway,
  owner,
  waitFor,
} from "./helpers.js";

describe("pairing", () => {
  it("bootstraps the allowlisted owner, issues a code, and links a new IM", async () => {
    const { gw, tg, fs } = openGateway();
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
    expect(markdownCalls(tg).join(" ")).toMatch(/Welcome/);

    await tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "pair" }));
    const pairText = markdownCalls(tg).find((t) => t.includes("Pairing code"));
    expect(pairText).toBeTruthy();
    const code = extractPairCode(pairText ?? "");
    expect(code).toHaveLength(8);

    await fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: code ?? "" }));
    expect(markdownCalls(fs).join(" ")).toMatch(/Linked/);

    const ident = gw.store.findIdentity("feishu", "bot", "ou_ada");
    expect(ident?.personId).toBe(gw.store.findIdentity("telegram", "bot", "ada")?.personId);
    gw.close();
  });

  it("tells unpaired senders a short instruction and nothing else", async () => {
    const driver = new ScriptedDriver(async (sink) => {
      sink.text("should-not-run");
    });
    const { gw, tg } = openGateway({ driver, allowlist: [owner("telegram", "ada")] });
    await tg.ingest(dm({ platform: "telegram", userId: "stranger", text: "hi there" }));
    const texts = markdownCalls(tg);
    expect(texts.some((t) => /private/i.test(t))).toBe(true);
    expect(texts.join(" ")).not.toMatch(/should-not-run/);
    gw.close();
  });

  it("pairing codes are single-use and expire after 10 minutes", () => {
    const store = new SessionStore(":memory:");
    const person = store.createPerson("Ada", 1_000);
    const ttl = 10 * 60 * 1000;
    const expired = store.createPairCode(person.id, "telegram:bot:ada", 1_000 + ttl, 1_000, 5, ttl);
    expect(expired).not.toBe("rate_limited");
    expect(store.consumePairCode(expired as string, 1_000 + ttl + 1)).toBeUndefined();

    const live = store.createPairCode(person.id, "telegram:bot:ada", 2_000 + ttl, 2_000, 5, ttl);
    expect(live).not.toBe("rate_limited");
    expect(store.consumePairCode(live as string, 2_500)).toBe(person.id);
    expect(store.consumePairCode(live as string, 2_600)).toBeUndefined();
    store.close();
  });

  it("rate-limits pairing codes", async () => {
    const { gw, tg } = openGateway();
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hi" }));
    for (let i = 0; i < 5; i += 1) {
      await tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "pair" }));
    }
    await tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "pair" }));
    expect(markdownCalls(tg).some((t) => /Too many/i.test(t))).toBe(true);
    gw.close();
  });
});

describe("topics and routing", () => {
  it("switches a named topic across two adapters", async () => {
    const driver = new ScriptedDriver(async (sink) => {
      sink.text("reply");
    });
    const { gw, tg, fs } = openGateway({ driver });
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hi" }));
    await tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "topic", args: "travel" }));
    expect(markdownCalls(tg).some((t) => /Switched to travel/.test(t))).toBe(true);

    await tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "pair" }));
    const code = extractPairCode(markdownCalls(tg).join("\n")) ?? "";
    await fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: code }));

    await fs.ingest(cmd({ platform: "feishu", userId: "ou_ada", name: "topics" }));
    expect(markdownCalls(fs).some((t) => /→ travel/.test(t))).toBe(true);

    const before = gw.store.activeConversation(gw.store.findIdentity("telegram", "bot", "ada")!.personId, Date.now());
    expect(before.title).toBe("travel");
    await fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: "itinerary?" }));
    await gw.waitForIdle();
    const after = gw.store.snapshot(before.id);
    expect(after.messages.some((m) => m.text === "itinerary?")).toBe(true);
    gw.close();
  });

  it("replies on the triggering IM and sends proactive to the last surface", async () => {
    const driver = new ScriptedDriver(async (sink) => {
      sink.text("pong");
    });
    const { gw, tg, fs } = openGateway({ driver });
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hi" }));
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "ping" }));
    await gw.waitForIdle();
    expect(markdownCalls(tg).some((t) => t === "pong")).toBe(true);
    expect(markdownCalls(fs).some((t) => t === "pong")).toBe(false);

    const personId = gw.store.findIdentity("telegram", "bot", "ada")!.personId;
    await gw.sendProactive(personId, "async result");
    expect(markdownCalls(tg).some((t) => t === "async result")).toBe(true);

    await tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "pair" }));
    const code = extractPairCode(markdownCalls(tg).join("\n")) ?? "";
    await fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: code }));
    await fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: "now here" }));
    await gw.waitForIdle();
    await gw.sendProactive(personId, "follow-up");
    expect(markdownCalls(fs).some((t) => t === "follow-up")).toBe(true);
    gw.close();
  });
});

describe("group isolation", () => {
  it("keeps a group conversation out of the personal default", async () => {
    const driver = new ScriptedDriver(async (sink) => {
      sink.text("noted");
    });
    const { gw, tg } = openGateway({ driver });
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hi" }));
    await tg.ingest(groupMsg({ platform: "telegram", chatId: "-100", userId: "ada", text: "@bot group note" }));
    await gw.waitForIdle();
    const personId = gw.store.findIdentity("telegram", "bot", "ada")!.personId;
    const personal = gw.store.defaultConversation(personId, Date.now());
    expect(personal.messages.some((m) => m.text.includes("group note"))).toBe(false);
    expect(personal.groupKey).toBeUndefined();
    const group = gw.store.groupConversation(
      { platform: "telegram", accountId: "bot", chatId: "-100", kind: "group" },
      Date.now(),
    );
    expect(group.messages.some((m) => m.text.includes("group note"))).toBe(true);
    expect(group.personId).toBeUndefined();
    gw.close();
  });
});

describe("mid-stream switch and approvals", () => {
  it("moves an in-flight reply and first-click-wins approvals to the new IM", async () => {
    let turns = 0;
    const driver = new ScriptedDriver(async (sink, ctl) => {
      turns += 1;
      if (turns > 1) {
        sink.text("ok");
        return;
      }
      sink.text("Hello ");
      await ctl.wait("mid");
      sink.text("world");
      const decision = await sink.requestApproval({
        toolCallId: "tool_1",
        title: "Run tests?",
        options: ["approve", "deny"],
      });
      sink.text(` [${decision}]`);
    });
    const { gw, tg, fs } = openGateway({ driver });
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hi" }));
    await tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "pair" }));
    const code = extractPairCode(markdownCalls(tg).join("\n")) ?? "";
    await fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: code }));

    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "write a poem" }));
    await waitFor(() => markdownCalls(tg).some((t) => t.includes("Hello")));

    await fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: "continue here" }));
    await waitFor(() => markdownCalls(tg).some((t) => /continued in feishu/i.test(t)));

    driver.release("mid");
    await waitFor(() => Boolean(lastApprovalId(fs)));
    const approvalId = lastApprovalId(fs);
    expect(approvalId).toBeTruthy();

    await fs.ingest(
      action({ platform: "feishu", userId: "ou_ada", actionId: "approve", value: approvalId, chatId: "ou_ada" }),
    );
    await tg.ingest(
      action({ platform: "telegram", userId: "ada", actionId: "deny", value: approvalId, chatId: "ada" }),
    );
    await gw.waitForIdle();
    expect(markdownCalls(fs).some((t) => /handled \(approved\)/.test(t))).toBe(true);
    expect(markdownCalls(fs).some((t) => t.includes("Hello world"))).toBe(true);
    gw.close();
  });
});

describe("restart persistence", () => {
  it("reloads identities and the message log from SQLite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imwire-"));
    const dbPath = join(dir, "session.sqlite");
    const first = openGateway({ dbPath });
    await first.tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hi" }));
    await first.tg.ingest(dm({ platform: "telegram", userId: "ada", text: "remember this" }));
    await first.gw.waitForIdle();
    const personId = first.gw.store.findIdentity("telegram", "bot", "ada")!.personId;
    first.gw.close();

    const second = new SessionGateway({
      dbPath,
      driver: new ScriptedDriver(),
      allowlist: [owner("telegram", "ada")],
    });
    expect(second.store.findIdentity("telegram", "bot", "ada")?.personId).toBe(personId);
    const conv = second.store.defaultConversation(personId, Date.now());
    expect(conv.messages.some((m) => m.text === "remember this")).toBe(true);
    second.store.setCallback("h:deadbeefdeadbeef", { id: "allow_once", value: "a_1" });
    second.close();
    const third = new SessionGateway({
      dbPath,
      driver: new ScriptedDriver(),
      allowlist: [owner("telegram", "ada")],
    });
    expect(third.store.getCallback("h:deadbeefdeadbeef")).toEqual({ id: "allow_once", value: "a_1" });
    third.close();
  });

  it("stops an in-flight turn via /stop", async () => {
    const driver = new ScriptedDriver(async (sink, ctl) => {
      sink.text("partial ");
      await ctl.wait("mid");
      sink.text("should-not-appear");
    });
    const { gw, tg } = openGateway({ driver });
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "go" }));
    await waitFor(() => markdownCalls(tg).some((t) => t.includes("partial")));
    await tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "stop" }));
    await gw.waitForIdle();
    expect(markdownCalls(tg).some((t) => t === "Stopped.")).toBe(true);
    expect(markdownCalls(tg).join(" ")).not.toMatch(/should-not-appear/);
    gw.close();
  });
});
