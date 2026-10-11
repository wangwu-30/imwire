import type { Capabilities } from "imwire";

/** Conservative text limit for Feishu text / card markdown chunks. */
export const FEISHU_MAX_TEXT = 8000;

export const feishuCapabilities: Capabilities = {
  streaming: "card",
  streamingCard: true,
  edit: true,
  delete: true,
  buttons: true,
  reactions: true,
  threads: true,
  typing: false,
  media: { image: true, file: true },
  maxTextLength: FEISHU_MAX_TEXT,
  markdown: "subset",
};
