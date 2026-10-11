import { collectButtons, renderDraftBody, type Button, type OutMessage } from "@imwire/core";

/** Default AI-card stream variable. Override with DINGTALK_CARD_STREAM_KEY. */
export const DEFAULT_STREAM_KEY = "content";

export function cardParamMap(text: string, status?: string, buttons?: Button[]): Record<string, string> {
  const map: Record<string, string> = {
    content: renderDraftBody(text || "…", status),
  };
  if (buttons) {
    map.buttons = JSON.stringify(
      buttons.map((b) => ({
        id: b.id,
        label: b.label,
        style: b.style ?? "default",
        value: b.value ?? "",
      })),
    );
  }
  return map;
}

export function cardDataFromOut(msg: OutMessage): Record<string, string> {
  const text = msg.blocks
    .filter((b) => b.kind === "markdown")
    .map((b) => b.text)
    .join("\n\n");
  const status = msg.blocks
    .filter((b) => b.kind === "status")
    .map((b) => b.text)
    .join("\n");
  return cardParamMap(text, status || undefined, collectButtons(msg));
}

export function webhookMarkdown(text: string, title = "imwire"): Record<string, unknown> {
  return {
    msgtype: "markdown",
    markdown: { title, text: text || "…" },
  };
}

export function webhookActionCard(text: string, buttons: Button[]): Record<string, unknown> {
  return {
    msgtype: "actionCard",
    actionCard: {
      title: "imwire",
      text: text || "…",
      btnOrientation: "1",
      btns: buttons.map((b) => ({
        title: b.label,
        actionURL: `https://imwire.invalid/action?id=${encodeURIComponent(b.id)}&value=${encodeURIComponent(b.value ?? "")}`,
      })),
    },
  };
}
