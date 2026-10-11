import type { Capabilities } from "imwire";

/** https://core.telegram.org/bots/api#sendmessage — 1-4096 characters after parsing. */
export const TELEGRAM_MAX_TEXT = 4096;

export const telegramCapabilities: Capabilities = {
  streaming: "edit",
  streamingCard: false,
  edit: true,
  delete: true,
  buttons: true,
  reactions: true,
  threads: true,
  typing: true,
  media: { image: true, file: true },
  maxTextLength: TELEGRAM_MAX_TEXT,
  markdown: "subset",
};
