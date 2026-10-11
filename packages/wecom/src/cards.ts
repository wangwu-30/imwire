import { collectButtons, type Button, type OutMessage } from "@imwire/core";

export function templateCard(text: string, buttons: Button[], taskId: string): Record<string, unknown> {
  return {
    card_type: "button_interaction",
    main_title: { title: text.slice(0, 128) || "imwire" },
    sub_title_text: text.length > 128 ? text.slice(128, 512) : undefined,
    button_list: buttons.map((b) => ({
      text: b.label,
      style: b.style === "danger" ? 4 : b.style === "primary" ? 1 : 2,
      key: b.value ? `${b.id}:${b.value}` : b.id,
    })),
    task_id: taskId,
  };
}

export function respondBody(msg: OutMessage, taskId: string): Record<string, unknown> {
  const text =
    msg.blocks
      .filter((b) => b.kind === "markdown" || b.kind === "status")
      .map((b) => b.text)
      .join("\n\n") || "…";
  const buttons = collectButtons(msg);
  if (buttons.length > 0) {
    return { msgtype: "template_card", template_card: templateCard(text, buttons, taskId) };
  }
  return { msgtype: "markdown", markdown: { content: text } };
}

export function streamBody(id: string, content: string, finish: boolean): Record<string, unknown> {
  return {
    msgtype: "stream",
    stream: { id, finish, content: content || "…" },
  };
}
