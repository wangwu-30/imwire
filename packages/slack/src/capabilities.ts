import type { Capabilities } from "@imwire/core";

/** chat.postMessage `text` official limit is 40,000 characters. */
export const SLACK_MAX_TEXT = 40_000;

/**
 * Slack Socket Mode + Block Kit + chat.update streaming.
 * `chat.startStream` / `appendStream` / `stopStream` exists in current docs
 * but is treated as unverified here; drafts use chat.postMessage + chat.update.
 * https://docs.slack.dev/apis/events-api/using-socket-mode
 */
export const slackCapabilities: Capabilities = {
  streaming: "edit",
  streamingCard: false,
  edit: true,
  editScope: "any",
  proactiveSend: true,
  delete: true,
  buttons: true,
  reactions: true,
  threads: true,
  typing: false,
  media: { image: false, file: false },
  maxTextLength: SLACK_MAX_TEXT,
  markdown: "subset",
};
