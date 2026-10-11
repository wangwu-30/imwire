import { describe, expect, it } from "vitest";
import type { Button } from "@imwire/core";
import { ELEMENT_ID_RE, assertCardJsonV2, buildCardJson, cardFromOutMessage } from "../src/cards.js";

function buttonIds(buttons: Button[]): string[] {
  const card = buildCardJson({ text: "x", buttons });
  assertCardJsonV2(card);
  const elements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
  return elements.filter((el) => el.tag === "button").map((el) => String(el.element_id));
}

describe("Feishu Card JSON 2.0", () => {
  it("emits schema 2.0 buttons as body elements with callback behaviors", () => {
    const card = buildCardJson({
      text: "Approve this?",
      buttons: [
        { id: "approve", label: "Approve", style: "primary", value: "call_42" },
        { id: "deny", label: "Deny", style: "danger" },
      ],
      streaming: true,
    });
    assertCardJsonV2(card);
    expect(card.schema).toBe("2.0");
    const config = card.config as Record<string, unknown>;
    expect(config.wide_screen_mode).toBeUndefined();
    expect(config.width_mode).toBe("fill");
    expect(config.streaming_mode).toBe(true);
    const raw = JSON.stringify(card);
    expect(raw).not.toContain('"tag":"action"');
    expect(raw).not.toContain('"tag": "action"');
    const elements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
    const buttons = elements.filter((el) => el.tag === "button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.behaviors).toEqual([
      { type: "callback", value: { actionId: "approve", value: "call_42" } },
    ]);
  });

  it("rejects legacy action containers and wide_screen_mode", () => {
    expect(() =>
      assertCardJsonV2({
        schema: "2.0",
        config: { wide_screen_mode: true },
        body: { elements: [] },
      }),
    ).toThrow(/wide_screen_mode/);
    expect(() =>
      assertCardJsonV2({
        schema: "2.0",
        body: { elements: [{ tag: "action", actions: [] }] },
      }),
    ).toThrow(/tag:action/);
  });

  it("builds cards from OutMessage without an action module", () => {
    const card = cardFromOutMessage({
      blocks: [
        { kind: "markdown", text: "hi" },
        { kind: "buttons", buttons: [{ id: "ok", label: "OK", value: "1" }] },
      ],
    });
    assertCardJsonV2(card);
  });

  it("assigns letter-prefixed unique element_ids ≤20 chars", () => {
    const long = buttonIds([{ id: "approve_tool_call", label: "Go" }]);
    expect(long).toHaveLength(1);
    expect(long[0]).toMatch(ELEMENT_ID_RE);
    expect((long[0] ?? "").length).toBeLessThanOrEqual(20);

    const punct = buttonIds([
      { id: "approve:1", label: "A" },
      { id: "approve.1", label: "B" },
    ]);
    expect(punct).toHaveLength(2);
    expect(new Set(punct).size).toBe(2);
    for (const id of punct) {
      expect(id).toMatch(ELEMENT_ID_RE);
      expect(id.length).toBeLessThanOrEqual(20);
    }

    const sameId = buttonIds([
      { id: "approve", label: "One", value: "first" },
      { id: "approve", label: "Two", value: "second" },
    ]);
    expect(sameId).toHaveLength(2);
    expect(new Set(sameId).size).toBe(2);
    for (const id of sameId) expect(id).toMatch(ELEMENT_ID_RE);
  });
});
