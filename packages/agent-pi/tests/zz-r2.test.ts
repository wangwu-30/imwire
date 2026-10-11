// Round-2 fresh adversarial repros. Real pi-agent-core/pi-ai 1.1.0 + fauxProvider.
import { describe, expect, it } from "vitest";
import { Type, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { PiAgentDriver } from "../src/index.js";
import { userTextOf, windowMessages } from "../src/messages.js";
import type { TurnSink } from "@imwire/session";
import { action, dm, lastApprovalId, openGateway, waitFor } from "../../session/tests/helpers.js";

const src = { chat: { platform: "telegram", accountId: "bot", chatId: "1", kind: "dm" as const }, from: { platform: "telegram", accountId: "bot", userId: "u" } };
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function setup(tps = 200) {
  const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o-mini" }], tokensPerSecond: tps, tokenSize: { min: 2, max: 2 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const ctxs: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const rec = (text: string | ReturnType<typeof fauxAssistantMessage>) => (ctx: unknown) => {
    ctxs.push(JSON.parse(JSON.stringify(ctx)));
    return typeof text === "string" ? fauxAssistantMessage(text) : text;
  };
  return { faux, models, ctxs, rec };
}
const show = (c: { messages: Array<{ role: string; content: unknown }> }) =>
  c.messages.map((m) => `${m.role}:${typeof m.content === "string" ? m.content : JSON.stringify(m.content).slice(0, 60)}`);

function mkTool(log: string[], big = 0): AgentTool {
  return {
    name: "rm_rf",
    label: "rm",
    description: "delete",
    parameters: Type.Object({}),
    execute: async () => {
      log.push("EXECUTED");
      return { content: [{ type: "text", text: big ? "X".repeat(big) : "done" }], details: undefined };
    },
  };
}

describe("R2 pi driver", () => {
  it("Q1: tool call -> approval card -> approve executes / deny blocks (via gateway)", async () => {
    for (const choice of ["approve", "deny"]) {
      const { faux, models, rec } = setup();
      const log: string[] = [];
      faux.setResponses([rec(fauxAssistantMessage(fauxToolCall("rm_rf", {}, { id: "tc1" }), { stopReason: "toolUse" })), rec("after tool")]);
      const driver = new PiAgentDriver({ models, tools: [mkTool(log)] });
      const { gw, tg } = openGateway({ driver, approvalTimeoutMs: 5000 });
      await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
      await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "delete it" }));
      await waitFor(() => Boolean(lastApprovalId(tg)), 3000);
      await tg.ingest(action({ platform: "telegram", userId: "ada", actionId: choice, value: lastApprovalId(tg) }));
      await gw.waitForIdle();
      console.log(`Q1 ${choice}: tool=${log.join(",") || "not run"} providerCalls=${faux.state.callCount}`);
      expect(log.length).toBe(choice === "approve" ? 1 : 0);
      gw.close();
    }
  }, 20_000);

  it("Q2: cancel() while waiting on an approval resolves promptly and the tool does not run", async () => {
    const { faux, models, rec } = setup();
    const log: string[] = [];
    faux.setResponses([rec(fauxAssistantMessage(fauxToolCall("rm_rf", {}, { id: "tc1" }), { stopReason: "toolUse" })), rec("after")]);
    const driver = new PiAgentDriver({ models, tools: [mkTool(log)] });
    const { agentSessionId } = await driver.ensureSession({
      id: "c",
      title: "d",
      isDefault: true,
      messages: [{ id: "m", seq: 1, role: "user", text: "go", createdAt: 1 }],
    });
    let release!: (d: string) => void;
    const sink: TurnSink = { text: () => {}, status: () => {}, requestApproval: () => new Promise((r) => (release = r)) };
    let done = false;
    const p = driver.prompt(agentSessionId, { text: "go", source: src }, sink).then(() => (done = true));
    await waitFor(() => Boolean(release), 3000);
    await driver.cancel(agentSessionId);
    await tick(300);
    console.log(`Q2 prompt resolved 300ms after cancel()? ${done}`);
    expect(done).toBe(true);
    release("approve");
    await p;
    console.log(`Q2 after late approve post-cancel: tool=${log.join(",") || "not run"}`);
    expect(log).toEqual([]);
  }, 10_000);

  it("Q3: steer() while the agent is idle returns false so the gateway can queue", async () => {
    const { faux, models, ctxs, rec } = setup();
    faux.setResponses([rec("A1"), rec("A2"), rec("A3")]);
    const driver = new PiAgentDriver({ models });
    const conv = { id: "c", title: "d", isDefault: true, messages: [{ id: "1", seq: 1, role: "user" as const, text: "Q1", createdAt: 1 }] };
    const sink: TurnSink = { text: () => {}, status: () => {}, requestApproval: async () => "approve" };
    const { agentSessionId } = await driver.ensureSession(conv);
    await driver.prompt(agentSessionId, { text: "Q1", source: src }, sink);
    const steered = await driver.steer(agentSessionId, { text: "Q2-steered", source: src });
    console.log(`Q3 steer() on idle agent returned ${steered}; provider calls so far=${faux.state.callCount}`);
    expect(steered).toBe(false);
    const conv2 = {
      ...conv,
      messages: [
        ...conv.messages,
        { id: "2", seq: 2, role: "assistant" as const, text: "A1", createdAt: 2 },
        { id: "3", seq: 3, role: "user" as const, text: "Q2-steered", createdAt: 3 },
        { id: "4", seq: 4, role: "user" as const, text: "Q3", createdAt: 4 },
      ],
    };
    await driver.ensureSession(conv2);
    await driver.prompt(agentSessionId, { text: "Q3", source: src }, sink);
    const seen = ctxs.slice(1).map(show);
    const n = JSON.stringify(seen).split("Q2-steered").length - 1;
    console.log(`Q3 later provider transcripts: ${JSON.stringify(seen)}`);
    console.log(`Q3 occurrences of Q2-steered across later requests=${n}`);
    expect(n).toBe(1);
  }, 10_000);

  it("Q4: queued follow-ups appear once in the model transcript", async () => {
    const { faux, models, ctxs, rec } = setup(20);
    faux.setResponses([rec("hi"), rec("long answer to M1 streaming slowly"), rec("batched")]);
    const driver = new PiAgentDriver({ models });
    const { gw, tg } = openGateway({ driver });
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "M1" }));
    await waitFor(() => faux.state.callCount >= 1, 3000);
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "M2" }));
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "M3" }));
    await gw.waitForIdle();
    await tick(50);
    await gw.waitForIdle();
    const last = ctxs.at(-1)!;
    const shown = show(last);
    console.log(`Q4 final request transcript: ${JSON.stringify(shown)}`);
    const blob = JSON.stringify(shown);
    expect(blob.split("M2").length - 1).toBe(1);
    expect(blob.split("M3").length - 1).toBe(1);
    expect(blob).not.toMatch(/M2\\nM3/);
    gw.close();
  }, 20_000);

  it("Q5: windowMessages keeps the user question and tool_call+tool_result pair", () => {
    const msgs = [
      { role: "system", content: "S" },
      { role: "user", content: "please summarise the log" },
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] },
      { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "X".repeat(40_000) }] },
    ];
    const w = windowMessages(msgs, 32_000);
    console.log(`Q5 window roles=${JSON.stringify(w.map((m) => m.role))}`);
    expect(w.map((m) => m.role)).toEqual(["system", "user", "assistant", "toolResult"]);
    expect(w.some((m) => m.role === "user" && userTextOf(m).includes("summarise"))).toBe(true);
    const tool = w.find((m) => m.role === "toolResult");
    expect(userTextOf(tool ?? {})).toMatch(/truncated/);
    const mixed = [
      { role: "system", content: "S" },
      { role: "user", content: "a".repeat(10) },
      { role: "system", content: "mid-transcript tool-set change" },
      { role: "user", content: "b" },
    ];
    const reordered = windowMessages(mixed, 1000).map((m) => m.content);
    console.log(`Q5 system reorder: ${JSON.stringify(reordered)}`);
    expect(reordered).toEqual(["S", "aaaaaaaaaa", "mid-transcript tool-set change", "b"]);
    const turns = [
      { role: "system", content: "S" },
      { role: "user", content: "old-q" },
      { role: "assistant", content: "tiny" },
      { role: "user", content: "new-q" },
    ];
    const dropped = windowMessages(turns, 10);
    expect(dropped.map((m) => m.content)).toEqual(["S", "new-q"]);
    expect(dropped.some((m) => m.content === "tiny")).toBe(false);
  });

  it("Q6: bounded context over many turns (log window + char window)", async () => {
    const { faux, models, ctxs, rec } = setup(100000);
    faux.setResponses(Array.from({ length: 60 }, (_, i) => rec("A".repeat(2000) + i)));
    const driver = new PiAgentDriver({ models });
    const { gw, tg } = openGateway({ driver });
    await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "hello" }));
    for (let i = 0; i < 60; i += 1) {
      await tg.ingest(dm({ platform: "telegram", userId: "ada", text: "Q" + "q".repeat(1000) + i }));
      await gw.waitForIdle();
    }
    const sizes = ctxs.map((c) => JSON.stringify(c.messages).length);
    console.log(`Q6 request sizes first=${sizes[0]} max=${Math.max(...sizes)} last=${sizes.at(-1)} msgs(last)=${ctxs.at(-1)!.messages.length}`);
    expect(Math.max(...sizes)).toBeLessThan(80_000);
    expect(ctxs.at(-1)!.messages.length).toBeLessThan(40);
    gw.close();
  }, 60_000);
});
