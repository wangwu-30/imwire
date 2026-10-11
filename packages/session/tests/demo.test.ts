import { describe, expect, it } from "vitest";
import { ScriptedDriver } from "../src/scripted-driver.js";
import { action, cmd, dm, extractPairCode, lastApprovalId, markdownCalls, openGateway, waitFor } from "./helpers.js";

/**
 * Acceptance demo: ask on Telegram, switch to Feishu mid-stream,
 * reply continues on Feishu, approve on Feishu.
 */
describe("acceptance demo (fake adapters)", () => {
  it("follows the user from Telegram onto Feishu", async () => {
    const log: string[] = [];
    let turns = 0;
    const driver = new ScriptedDriver(async (sink, ctl) => {
      turns += 1;
      if (turns > 1) {
        sink.text("ok");
        return;
      }
      sink.text("Once upon a time ");
      log.push("streamed first tokens on the active IM");
      await ctl.wait("mid");
      sink.text("the story continued.");
      const decision = await sink.requestApproval({
        toolCallId: "publish",
        title: "Publish the story?",
        options: ["approve", "deny"],
      });
      sink.text(` (${decision})`);
    });
    const { gw, tg, fs } = openGateway({ driver });

    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hi" }));
    await tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "pair" }));
    const code = extractPairCode(markdownCalls(tg).join("\n")) ?? "";
    await fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: code }));
    log.push("paired Telegram + Feishu");

    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "tell me a story" }));
    await waitFor(() => markdownCalls(tg).some((t) => t.includes("Once upon a time")));
    log.push("asked on Telegram");

    await fs.ingest(dm({ platform: "feishu", userId: "ou_ada", text: "I'm on Feishu now" }));
    await waitFor(() => markdownCalls(tg).some((t) => /continued in feishu/i.test(t)));
    expect(markdownCalls(tg).some((t) => /continued in feishu/i.test(t))).toBe(true);
    log.push("switched; Telegram draft marked continued in Feishu");

    driver.release("mid");
    await waitFor(() => Boolean(lastApprovalId(fs)));
    const approvalId = lastApprovalId(fs);
    expect(approvalId).toBeTruthy();
    await fs.ingest(action({ platform: "feishu", userId: "ou_ada", actionId: "approve", value: approvalId }));
    await gw.waitForIdle();

    expect(markdownCalls(fs).some((t) => t.includes("the story continued"))).toBe(true);
    expect(markdownCalls(fs).some((t) => /handled \(approved\)/.test(t))).toBe(true);
    log.push("approval first click on Feishu won");
    console.log(log.map((l, i) => `${i + 1}. ${l}`).join("\n"));
    gw.close();
  });
});
