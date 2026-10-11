import type { Capabilities } from "@imwire/core";

/** WeCom markdown body is documented as ≤20480 UTF-8 bytes. */
export const WECOM_MAX_TEXT = 4096;

/**
 * WeCom 智能机器人 long-connection.
 * Official docs also describe `aibot_send_msg` (proactive). This adapter maps
 * the reply-only constraint via `proactiveSend: false` and req_id reuse —
 * outbound always uses `aibot_respond_msg` / stream, never `aibot_send_msg`.
 *
 * Reply context (inbound `req_id`) is kept for the documented 24h window
 * (「收到消息回调后，24 小时内可以往该会话回复消息」) in a memory-bounded LRU
 * (default 1 MiB; override with `replyMaxBytes` / `WECOM_REPLY_MAX_BYTES`).
 * Optional JSON persist: `replyStorePath` / `WECOM_REPLY_STORE`. Official
 * send rate is 30/min and 1000/h; under a burst of unique chats the LRU may
 * evict a still-valid 24h slot once the memory budget is full.
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
