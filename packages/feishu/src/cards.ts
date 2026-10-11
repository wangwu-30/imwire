import { collectButtons, renderDraftBody, type Button, type OutMessage } from "@imwire/core";

export const STREAM_ELEMENT_ID = "imwire_content";

/** Feishu element_id: letter first, [A-Za-z0-9_], ≤20 chars, unique in the card. */
export const ELEMENT_ID_RE = /^[A-Za-z][A-Za-z0-9_]{0,19}$/;

export function buttonElementId(index: number, button: Button): string {
  const hash = fnv1a6(`${button.id}\0${button.value ?? ""}`);
  return `b${index}_${hash}`;
}

export function buttonElement(button: Button, index = 0): Record<string, unknown> {
  const value: Record<string, string> = { actionId: button.id };
  if (button.value !== undefined) value.value = button.value;
  return {
    tag: "button",
    element_id: buttonElementId(index, button),
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
    opts.buttons.forEach((button, i) => elements.push(buttonElement(button, i)));
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
  const seen = new Set<string>();
  for (const id of collectElementIds(card)) {
    if (!ELEMENT_ID_RE.test(id)) {
      throw new Error(`invalid element_id "${id}": must start with a letter, [A-Za-z0-9_], ≤20 chars`);
    }
    if (seen.has(id)) throw new Error(`duplicate element_id "${id}"`);
    seen.add(id);
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

function collectElementIds(card: Record<string, unknown>): string[] {
  const body = card.body as { elements?: unknown[] } | undefined;
  const ids: string[] = [];
  for (const el of body?.elements ?? []) {
    if (!el || typeof el !== "object") continue;
    const id = (el as { element_id?: unknown }).element_id;
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}

function fnv1a6(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(6, "0").slice(0, 6);
}
