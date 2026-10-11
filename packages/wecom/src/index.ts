export { WecomAdapter, type WecomAdapterOptions } from "./adapter.js";
export { wecomCapabilities, WECOM_MAX_TEXT, WECOM_WS_URL } from "./capabilities.js";
export { mapWecomEvent, replyContextOf, isDisconnectedEvent, type WecomMapContext } from "./map.js";
export { createRawWecomTransport, type WecomTransport, type WecomFrame } from "./transport.js";
export { WecomApiError, WecomKickError, wecomShouldRetry } from "./errors.js";
