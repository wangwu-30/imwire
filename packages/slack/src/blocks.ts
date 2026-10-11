import { collectButtons, markdownText, statusText, type Button, type OutMessage } from "@imwire/core";

export function blocksFromOut(msg: OutMessage): unknown[] {
  const text = [markdownText(msg), statusText(msg)].filter(Boolean).join("\n\n") || "…";
  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
  ];
  const buttons = collectButtons(msg);
  if (buttons.length > 0) {
    blocks.push({
      type: "actions",
      elements: buttons.map((b) => buttonElement(b)),
    });
  }
  return blocks;
}

export function buttonElement(button: Button): Record<string, unknown> {
  const el: Record<string, unknown> = {
    type: "button",
    action_id: button.id,
    text: { type: "plain_text", text: button.label, emoji: true },
    value: button.value ?? button.id,
  };
  if (button.style === "primary") el.style = "primary";
  if (button.style === "danger") el.style = "danger";
  return el;
}

export function fallbackText(msg: OutMessage): string {
  return [markdownText(msg), statusText(msg)].filter(Boolean).join("\n\n") || "…";
}
