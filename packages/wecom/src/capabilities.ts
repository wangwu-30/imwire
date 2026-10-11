import type { Capabilities } from "@imwire/core";

/** WeCom markdown body is documented as ≤20480 UTF-8 bytes. */
export const WECOM_MAX_TEXT = 4096;

/**
 * WeCom 智能机器人 long-connection.
 * Official docs also describe `aibot_send_msg` (proactive). This adapter maps
 * the reply-only constraint via `proactiveSend: false` and req_id reuse —
 * outbound always uses `aibot_respond_msg` / stream, never `aibot_send_msg`.
 * https://developer.work.weixin.qq.com/document/path/101463
 */
export const wecomCapabilities: Capabilities = {
  streaming: "card",
  streamingCard: true,
  edit: true,
  editScope: "cards",
  proactiveSend: false,
  delete: false,
  buttons: true,
  reactions: false,
  threads: false,
  typing: false,
  media: { image: false, file: false },
  maxTextLength: WECOM_MAX_TEXT,
  markdown: "subset",
};

export const WECOM_WS_URL = "wss://openws.work.weixin.qq.com";
