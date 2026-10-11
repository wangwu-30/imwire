import type { Capabilities } from "@imwire/core";

/** Conservative chunk size. Feishu cards themselves cap at 30 KB (error 200860). */
export const FEISHU_MAX_TEXT = 8000;
export const FEISHU_CARD_BYTE_CAP = 30_000;

export const feishuCapabilities: Capabilities = {
  streaming: "card",
  streamingCard: true,
  edit: true,
  editScope: "cards",
  editTextMessages: false,
  proactiveSend: true,
  delete: true,
  buttons: true,
  reactions: true,
  threads: true,
  typing: false,
  media: { image: false, file: false },
  maxTextLength: FEISHU_MAX_TEXT,
  markdown: "subset",
};
