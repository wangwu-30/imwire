import { collectButtons, renderDraftBody, type Button, type OutMessage } from "imwire";

export const STREAM_ELEMENT_ID = "imwire_content";

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
  if (opts.buttons && opts.buttons.length > 0) {
    elements.push({
      tag: "action",
      actions: opts.buttons.map((b) => ({
        tag: "button",
        text: { tag: "plain_text", content: b.label },
        type: b.style === "danger" ? "danger" : b.style === "primary" ? "primary" : "default",
        value: { actionId: b.id },
      })),
    });
  }
  return {
    schema: "2.0",
    config: {
      streaming_mode: Boolean(opts.streaming),
      update_multi: true,
      wide_screen_mode: true,
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

export function textContent(text: string): string {
  return JSON.stringify({ text });
}

export function interactiveContent(card: Record<string, unknown>): string {
  return JSON.stringify(card);
}

export function cardkitRefContent(cardId: string): string {
  return JSON.stringify({ type: "card", data: { card_id: cardId } });
}
