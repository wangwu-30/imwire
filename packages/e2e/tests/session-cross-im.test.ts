import { describe, expect, it } from "vitest";
import { ScriptedDriver } from "@imwire/session";
import {
  bootstrapAndPair,
  extractPairCode,
  fsAction,
  fsMessage,
  openPlatformSession,
  tgCallback,
  tgMessage,
  waitFor,
} from "./helpers.js";

describe("e2e session against local Telegram HTTP + Feishu HTTP mocks", () => {
  it("pairs Telegram to Feishu with an 8-digit code", async () => {
    const { gw, tg, fs, tgMock, fsMock, close } = await openPlatformSession();
    try {
      await tg.ingest(tgMessage({ text: "hello" }));
      expect(tgMock.texts().join(" ")).toMatch(/Welcome/);

      await tg.ingest(tgMessage({ text: "/pair" }));
      const code = extractPairCode(...tgMock.texts());
      expect(code).toHaveLength(8);
      expect(tgMock.texts().some((t) => t.includes("valid 10 minutes"))).toBe(true);

      await fs.ingest(fsMessage({ text: "00000000" }));
      expect(fsMock.texts().join(" ")).toMatch(/private/i);

      await fs.ingest(fsMessage({ text: code ?? "" }));
      await waitFor(() => fsMock.texts().some((t) => /Linked/.test(t)));
      expect(gw.store.findIdentity("feishu", "cli_e2e", "ou_ada")?.personId).toBe(
        gw.store.findIdentity("telegram", "telegram", "111")?.personId,
      );
    } finally {
      await close();
    }
  });

  it("keeps one conversation when the same person switches Telegram → Feishu", async () => {
    const driver = new ScriptedDriver(async (sink) => {
      sink.text("noted");
    });
    const { gw, tg, fs, tgMock, close } = await openPlatformSession({ driver });
    try {
      await bootstrapAndPair(tg, fs, tgMock);

      await tg.ingest(tgMessage({ text: "remember the word banana" }));
      await gw.waitForIdle();
      await fs.ingest(fsMessage({ text: "what word?" }));
      await gw.waitForIdle();

      const personId = gw.store.findIdentity("telegram", "telegram", "111")!.personId;
      const snap = gw.store.activeConversation(personId, Date.now());
      const texts = snap.messages.map((m) => m.text);
      expect(texts).toContain("remember the word banana");
      expect(texts).toContain("what word?");
      expect(texts.filter((t) => t === "noted").length).toBe(2);
      expect(gw.store.findIdentity("feishu", "cli_e2e", "ou_ada")?.personId).toBe(personId);
    } finally {
      await close();
    }
  });

  it("continues an in-flight stream after the user switches IM", async () => {
    let turns = 0;
    const driver = new ScriptedDriver(async (sink, ctl) => {
      turns += 1;
      if (turns > 1) {
        sink.text("ok");
        return;
      }
      sink.text("Once upon a time ");
      await ctl.wait("mid");
      sink.text("the story continued.");
    });
    const { gw, tg, fs, tgMock, fsMock, close } = await openPlatformSession({ driver });
    try {
      await bootstrapAndPair(tg, fs, tgMock);
      await tg.ingest(tgMessage({ text: "tell me a story" }));
      await waitFor(() => tgMock.texts().some((t) => t.includes("Once upon a time")));

      await fs.ingest(fsMessage({ text: "I'm on Feishu now" }));
      await waitFor(() => tgMock.texts().some((t) => /continued in feishu/i.test(t)));

      driver.release("mid");
      await gw.waitForIdle();
      expect(fsMock.texts().some((t) => t.includes("the story continued"))).toBe(true);
    } finally {
      await close();
    }
  });

  it("accepts the owner's approval click and ignores a stranger", async () => {
    const driver = new ScriptedDriver(async (sink) => {
      const decision = await sink.requestApproval({
        toolCallId: "publish",
        title: "Publish the story?",
        options: ["approve", "deny"],
      });
      sink.text(` (${decision})`);
    });
    const { gw, tg, fs, tgMock, fsMock, close } = await openPlatformSession({ driver });
    try {
      await bootstrapAndPair(tg, fs, tgMock);
      await fs.ingest(fsMessage({ text: "publish it" }));
      await waitFor(() => Boolean(fsMock.lastApprovalId()));
      const approvalId = fsMock.lastApprovalId();
      expect(approvalId).toBeTruthy();

      await fs.ingest(fsAction({ userId: "ou_stranger", actionId: "approve", value: approvalId }));
      await new Promise((r) => setTimeout(r, 30));
      expect(fsMock.texts().some((t) => /handled/.test(t))).toBe(false);
      expect(gw.store.getApproval(approvalId ?? "")?.state).toBe("pending");

      await fs.ingest(fsAction({ userId: "ou_ada", actionId: "approve", value: approvalId }));
      await gw.waitForIdle();
      expect(fsMock.texts().some((t) => /handled \(approved\)/.test(t))).toBe(true);
      expect(gw.store.getApproval(approvalId ?? "")?.state).toBe("approved");
    } finally {
      await close();
    }
  });

  it("times out a pending approval", async () => {
    const driver = new ScriptedDriver(async (sink) => {
      const decision = await sink.requestApproval({
        toolCallId: "slow",
        title: "Wait for it?",
        options: ["approve", "deny"],
      });
      sink.text(` (${decision})`);
    });
    const { gw, tg, fs, tgMock, fsMock, close } = await openPlatformSession({
      driver,
      approvalTimeoutMs: 80,
    });
    try {
      await bootstrapAndPair(tg, fs, tgMock);
      await fs.ingest(fsMessage({ text: "need approval" }));
      await waitFor(() => Boolean(fsMock.lastApprovalId()));
      const approvalId = fsMock.lastApprovalId();
      await gw.waitForIdle();
      expect(fsMock.texts().some((t) => /handled \(denied\)/.test(t))).toBe(true);
      expect(gw.store.getApproval(approvalId ?? "")?.state).toBe("denied");
    } finally {
      await close();
    }
  });

  it("resolves a Telegram approval button through the Bot API callback_data", async () => {
    const driver = new ScriptedDriver(async (sink) => {
      const decision = await sink.requestApproval({
        toolCallId: "tg",
        title: "Allow?",
        options: ["approve", "deny"],
      });
      sink.text(` (${decision})`);
    });
    const { gw, tg, tgMock, close } = await openPlatformSession({ driver });
    try {
      await tg.ingest(tgMessage({ text: "hello" }));
      await tg.ingest(tgMessage({ text: "need a click" }));
      await waitFor(() => Boolean(tgMock.lastApprovalId()));
      const data = tgMock.lastCallbackData();
      expect(data).toBeTruthy();
      await tg.ingest(tgCallback({ data: data ?? "" }));
      await gw.waitForIdle();
      expect(tgMock.texts().some((t) => /handled \(approved\)/.test(t))).toBe(true);
    } finally {
      await close();
    }
  });
});
