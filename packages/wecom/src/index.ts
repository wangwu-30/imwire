export { WecomAdapter, type WecomAdapterOptions } from "./adapter.js";
export { wecomCapabilities, WECOM_MAX_TEXT, WECOM_WS_URL } from "./capabilities.js";
export { mapWecomEvent, replyContextOf, isDisconnectedEvent, type WecomMapContext } from "./map.js";
export { createRawWecomTransport, type WecomTransport, type WecomFrame } from "./transport.js";
export { WecomApiError, WecomKickError, wecomShouldRetry, WECOM_AUTH_ERRCODES } from "./errors.js";
export {
  WecomReplyStore,
  WECOM_REPLY_TTL_MS,
  WECOM_REPLY_MAX_BYTES,
  type ReplySlot,
  type WecomReplyStoreOptions,
} from "./reply-store.js";
