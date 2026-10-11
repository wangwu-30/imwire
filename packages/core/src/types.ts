export type Platform =
  | "feishu"
  | "dingtalk"
  | "wecom"
  | "telegram"
  | "slack"
  | (string & {});

export interface ChatRef {
  platform: Platform;
  accountId: string;
  chatId: string;
  kind: "dm" | "group";
  threadId?: string;
}

export interface UserRef {
  platform: Platform;
  accountId: string;
  userId: string;
  displayName?: string;
}

export interface MsgRef {
  chat: ChatRef;
  messageId: string;
}

export type MediaKind = "image" | "file" | "audio" | "video" | "sticker" | "other";

export interface MediaRef {
  id: string;
  kind: MediaKind;
  mime?: string;
  name?: string;
  size?: number;
}

export interface MediaUpload {
  kind: "image" | "file";
  name?: string;
  mime?: string;
  bytes: Uint8Array;
}

export type ButtonStyle = "primary" | "danger" | "default";

export interface Button {
  id: string;
  label: string;
  style?: ButtonStyle;
  value?: string;
}

export type Block =
  | { kind: "markdown"; text: string }
  | { kind: "buttons"; buttons: Button[] }
  | { kind: "status"; text: string };

export interface OutMessage {
  blocks: Block[];
  replyTo?: MsgRef;
  media?: MediaUpload[];
}

export interface InboundBase {
  id: string;
  ts: number;
  raw?: unknown;
}

export interface MessageEvent extends InboundBase {
  type: "message";
  chat: ChatRef;
  from: UserRef;
  /** Platform message id (for replies / edits). Distinct from `id`, which is the inbound event id used for dedup. */
  messageId: string;
  text: string;
  mentionsBot: boolean;
  replyTo?: MsgRef;
  media?: MediaRef[];
}

export interface EditEvent extends InboundBase {
  type: "edit";
  target: MsgRef;
  from: UserRef;
  text: string;
}

export interface ReactionEvent extends InboundBase {
  type: "reaction";
  target: MsgRef;
  from: UserRef;
  emoji: string;
  added: boolean;
}

export interface ActionEvent extends InboundBase {
  type: "action";
  target: MsgRef;
  from: UserRef;
  actionId: string;
  value?: string;
}

export interface CommandEvent extends InboundBase {
  type: "command";
  chat: ChatRef;
  from: UserRef;
  messageId?: string;
  name: string;
  args: string;
}

export type Inbound = MessageEvent | EditEvent | ReactionEvent | ActionEvent | CommandEvent;

export interface DraftHandle {
  append(delta: string): void;
  setStatus(text: string): void;
  finalize(final?: OutMessage): Promise<MsgRef[]>;
  abort(note?: string): Promise<void>;
}

export type StreamingMode = "card" | "edit" | "buffer";
export type EditScope = "any" | "cards" | "none";

export interface Capabilities {
  streaming: StreamingMode;
  streamingCard: boolean;
  edit: boolean;
  /**
   * What `edit()` can actually change.
   * `any` — text and cards (Telegram). `cards` — interactive cards only (Feishu).
   * `none` — no edits. Replaces the old `editTextMessages` flag.
   */
  editScope: EditScope;
  /** False when the bot can only reply in-window (some WeCom setups). */
  proactiveSend: boolean;
  delete: boolean;
  buttons: boolean;
  reactions: boolean;
  threads: boolean;
  typing: boolean;
  media: { image: boolean; file: boolean };
  maxTextLength: number;
  markdown: "full" | "subset" | "none";
}

export type InboundHandler = (event: Inbound) => Promise<void>;

export interface Adapter {
  readonly platform: Platform;
  readonly accountId: string;
  readonly capabilities: Capabilities;
  start(signal: AbortSignal): Promise<void>;
  on(handler: InboundHandler): void;
  send(chat: ChatRef, msg: OutMessage): Promise<MsgRef[]>;
  edit(ref: MsgRef, msg: OutMessage): Promise<void>;
  draft(chat: ChatRef, opts?: { replyTo?: MsgRef }): Promise<DraftHandle>;
  typing(chat: ChatRef): Promise<void>;
  delete(ref: MsgRef): Promise<void>;
  react?(ref: MsgRef, emoji: string): Promise<void>;
  download(media: MediaRef): Promise<ReadableStream<Uint8Array>>;
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export function chatKey(chat: ChatRef): string {
  return `${chat.platform}:${chat.accountId}:${chat.chatId}`;
}

export function inboundChat(event: Inbound): ChatRef {
  if ("chat" in event) return event.chat;
  return event.target.chat;
}

export function markdownText(msg: OutMessage): string {
  return msg.blocks
    .filter((b): b is Extract<Block, { kind: "markdown" }> => b.kind === "markdown")
    .map((b) => b.text)
    .join("\n\n");
}

export function statusText(msg: OutMessage): string | undefined {
  const parts = msg.blocks
    .filter((b): b is Extract<Block, { kind: "status" }> => b.kind === "status")
    .map((b) => b.text);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function collectButtons(msg: OutMessage): Button[] {
  return msg.blocks
    .filter((b): b is Extract<Block, { kind: "buttons" }> => b.kind === "buttons")
    .flatMap((b) => b.buttons);
}

export function renderDraftBody(text: string, status?: string): string {
  if (status && text) return `${text}\n\n_${status}_`;
  if (status) return `_${status}_`;
  return text;
}
