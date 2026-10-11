import type { Capabilities } from "@imwire/core";

/** Conservative chunk size for robot markdown / AI card bodies. */
export const DINGTALK_MAX_TEXT = 5000;

/**
 * DingTalk Stream robot + AI cards.
 * Live Stream / AI-card paths are fixture-tested against official docs; not
 * verified against a real org in this repo.
 */
export const dingtalkCapabilities: Capabilities = {
  streaming: "card",
  streamingCard: true,
  edit: true,
  editScope: "cards",
  proactiveSend: true,
  delete: false,
  buttons: true,
  reactions: false,
  threads: false,
  typing: false,
  media: { image: false, file: false },
  maxTextLength: DINGTALK_MAX_TEXT,
  markdown: "subset",
};

/** Stream callback topic for inbound robot messages. */
export const TOPIC_ROBOT = "/v1.0/im/bot/messages/get";

/** Stream callback topic for interactive / AI card button clicks. */
export const TOPIC_CARD = "/v1.0/card/instances/callback";
