import { collectButtons, renderDraftBody, type Button, type OutMessage } from "@imwire/core";

export const STREAM_ELEMENT_ID = "imwire_content";

export function buttonElement(button: Button): Record<string, unknown> {
  const value: Record<string, string> = { actionId: button.id };
  if (button.value !== undefined) value.value = button.value;
  return {
    tag: "button",
    element_id: `btn_${button.id}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40),
    text: { tag: "plain_text", content: button.label },
    type: button.style === "danger" ? "danger" : button.style === "primary" ? "primary" : "default",
    behaviors: [{ type: "callback", value }],
  };
}

export function buildCardJson(opts: {
  text: string;
  status?: string;
  buttons?: Button[];
  streaming?: boolean;
}): Record<string, unknown> {
  const content = renderDraftBody(opts.text || "…", opts.status);
  const elements: unknown[] = [
    {
      tag: "markdown",
      content,
      element_id: STREAM_ELEMENT_ID,
    },
  ];
  if (opts.buttons) {
    for (const button of opts.buttons) elements.push(buttonElement(button));
  }
  return {
    schema: "2.0",
    config: {
      streaming_mode: Boolean(opts.streaming),
      update_multi: true,
      width_mode: "fill",
    },
    body: { elements },
  };
}

export function cardFromOutMessage(msg: OutMessage, streaming = false): Record<string, unknown> {
  const text = msg.blocks
    .filter((b) => b.kind === "markdown")
    .map((b) => b.text)
    .join("\n\n");
  const status = msg.blocks
    .filter((b) => b.kind === "status")
    .map((b) => b.text)
    .join("\n");
  return buildCardJson({
    text,
    status: status || undefined,
    buttons: collectButtons(msg),
    streaming,
  });
}

export function assertCardJsonV2(card: Record<string, unknown>): void {
  if (card.schema !== "2.0") throw new Error("card schema must be 2.0");
  const config = card.config as Record<string, unknown> | undefined;
  if (config && "wide_screen_mode" in config) {
    throw new Error("Card JSON 2.0 rejects wide_screen_mode; use width_mode");
  }
  const raw = JSON.stringify(card);
  if (raw.includes('"tag":"action"') || raw.includes('"tag": "action"')) {
    throw new Error("Card JSON 2.0 rejects tag:action; put buttons in body.elements");
  }
}

export function interactiveContent(card: Record<string, unknown>): string {
  assertCardJsonV2(card);
  return JSON.stringify(card);
}

export function cardkitRefContent(cardId: string): string {
  return JSON.stringify({ type: "card", data: { card_id: cardId } });
}

export function clipToBytes(text: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (enc.encode(text.slice(0, mid)).length <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}
