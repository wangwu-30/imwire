import type { Capabilities } from "@imwire/core";

/** https://core.telegram.org/bots/api#sendmessage — 1-4096 characters after parsing. */
export const TELEGRAM_MAX_TEXT = 4096;

export const telegramCapabilities: Capabilities = {
  streaming: "edit",
  streamingCard: false,
  edit: true,
  editScope: "any",
  editTextMessages: true,
  proactiveSend: true,
  delete: true,
  buttons: true,
  reactions: true,
  threads: true,
  typing: true,
  media: { image: false, file: false },
  maxTextLength: TELEGRAM_MAX_TEXT,
  markdown: "none",
};
