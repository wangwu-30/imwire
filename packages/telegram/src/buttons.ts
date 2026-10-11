import { createHash } from "node:crypto";
import type { Button } from "@imwire/core";

const LIMIT = 64;

export function encodeCallbackData(
  button: Button,
  table: Map<string, { id: string; value?: string }>,
): string {
  const payload = button.value !== undefined ? `${button.id}:${button.value}` : button.id;
  const bytes = new TextEncoder().encode(payload);
  if (bytes.length <= LIMIT) return payload;
  const hash = createHash("sha256").update(payload).digest("hex").slice(0, 16);
  const short = `h:${hash}`;
  table.set(short, { id: button.id, value: button.value });
  return short;
}

export function decodeCallbackData(
  data: string,
  table: Map<string, { id: string; value?: string }>,
): { actionId: string; value?: string } {
  const hashed = table.get(data);
  if (hashed) return { actionId: hashed.id, value: hashed.value };
  const idx = data.indexOf(":");
  if (idx === -1) return { actionId: data };
  return { actionId: data.slice(0, idx), value: data.slice(idx + 1) };
}

export function inlineKeyboard(
  buttons: Button[],
  table: Map<string, { id: string; value?: string }>,
) {
  return {
    inline_keyboard: [
      buttons.map((b) => ({
        text: b.style === "danger" ? `✕ ${b.label}` : b.style === "primary" ? `● ${b.label}` : b.label,
        callback_data: encodeCallbackData(b, table),
      })),
    ],
  };
}
