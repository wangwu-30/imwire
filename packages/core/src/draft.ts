import { chunkText } from "./chunk.js";
import { createCoalescingThrottle } from "./rate-limit.js";
import {
  collectButtons,
  markdownText,
  renderDraftBody,
  systemClock,
  type ChatRef,
  type Clock,
  type DraftHandle,
  type MsgRef,
  type OutMessage,
  type StreamingMode,
} from "./types.js";

export interface DraftSink {
  /** First visible send. Used by edit and buffer fallback. */
  send(chat: ChatRef, msg: OutMessage): Promise<MsgRef[]>;
  /** In-place update of an existing message. */
  edit?(ref: MsgRef, msg: OutMessage): Promise<void>;
  /**
   * Card / platform-native stream. If this throws, the helper degrades
   * to edit-in-place (when `edit` exists) and then to buffered sends.
   */
  streamUpdate?(ctx: StreamContext, text: string, status?: string): Promise<void>;
  streamStart?(
    chat: ChatRef,
    opts: { replyTo?: MsgRef },
  ): Promise<StreamContext | undefined>;
  streamFinish?(ctx: StreamContext, msg: OutMessage, text: string): Promise<MsgRef[]>;
  streamAbort?(ctx: StreamContext, note?: string): Promise<void>;
}

export interface StreamContext {
  refs: MsgRef[];
  token?: unknown;
}

export interface StreamingDraftOptions {
  mode: StreamingMode;
  maxTextLength: number;
  throttleMs: number;
  chat: ChatRef;
  replyTo?: MsgRef;
  sink: DraftSink;
  clock?: Clock;
}

export function createStreamingDraft(opts: StreamingDraftOptions): DraftHandle {
  const clock = opts.clock ?? systemClock();
  const throttle = createCoalescingThrottle({
    intervalMs: opts.throttleMs,
    clock,
  });

  let text = "";
  let status: string | undefined;
  let closed = false;
  let mode: StreamingMode = opts.mode;
  let ctx: StreamContext = { refs: [] };
  let started = false;
  let startPromise: Promise<void> | undefined;
  let lastStream = "";
  const lastChunk = new Map<number, string>();

  const ensureStarted = async (): Promise<void> => {
    if (started) return;
    if (startPromise) {
      await startPromise;
      return;
    }
    startPromise = (async () => {
      if (mode === "card" && opts.sink.streamStart) {
        try {
          const created = await opts.sink.streamStart(opts.chat, { replyTo: opts.replyTo });
          if (created) {
            ctx = created;
            started = true;
            return;
          }
          mode = opts.sink.edit ? "edit" : "buffer";
        } catch {
          mode = opts.sink.edit ? "edit" : "buffer";
        }
      }
      started = true;
    })();
    await startPromise;
  };

  const bodyMsg = (body: string, extra?: OutMessage): OutMessage => ({
    blocks: [
      { kind: "markdown", text: body || "…" },
      ...(extra?.blocks.filter((b) => b.kind !== "markdown") ?? []),
    ],
    replyTo: extra?.replyTo ?? opts.replyTo,
    media: extra?.media,
  });

  const flush = async (): Promise<void> => {
    if (closed) return;
    await ensureStarted();
    const rendered = renderDraftBody(text, status);
    if (mode === "card" && opts.sink.streamUpdate && ctx.token !== undefined) {
      if (rendered === lastStream) return;
      try {
        await opts.sink.streamUpdate(ctx, text, status);
        lastStream = rendered;
        return;
      } catch {
        mode = opts.sink.edit ? "edit" : "buffer";
      }
    }
    if (mode === "buffer") return;
    await applyEditOrSend(rendered);
  };

  const applyEditOrSend = async (rendered: string, extra?: OutMessage): Promise<MsgRef[]> => {
    const chunks = chunkText(rendered.length > 0 ? rendered : "…", opts.maxTextLength);
    const buttons = extra ? collectButtons(extra) : [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i] ?? "";
      const isLast = i === chunks.length - 1;
      const msg: OutMessage = {
        blocks: [
          { kind: "markdown", text: chunk },
          ...(isLast && buttons.length > 0 ? ([{ kind: "buttons" as const, buttons }] as const) : []),
        ],
        replyTo: i === 0 ? (extra?.replyTo ?? opts.replyTo) : undefined,
        media: i === 0 ? extra?.media : undefined,
      };
      const existing = ctx.refs[i];
      const fingerprint = JSON.stringify(msg.blocks);
      if (existing && lastChunk.get(i) === fingerprint) continue;
      if (existing && opts.sink.edit) {
        try {
          await opts.sink.edit(existing, msg);
          lastChunk.set(i, fingerprint);
          continue;
        } catch {
          // fall through to send a new chunk
        }
      }
      const sent = await opts.sink.send(opts.chat, msg);
      lastChunk.set(i, fingerprint);
      if (existing) ctx.refs[i] = sent[0] ?? existing;
      else ctx.refs.push(...sent);
    }
    return ctx.refs;
  };

  const handle: DraftHandle = {
    append(delta: string) {
      if (closed) return;
      text += delta;
      throttle.schedule(flush);
    },
    setStatus(next: string) {
      if (closed) return;
      status = next;
      throttle.schedule(flush);
    },
    async finalize(final?: OutMessage) {
      if (closed) return ctx.refs;
      await throttle.flush();
      closed = true;
      await ensureStarted();
      const finalText = final ? markdownText(final) || text : text;
      const finalStatus = final ? undefined : status;
      const rendered = renderDraftBody(finalText, finalStatus);
      const msg: OutMessage = final
        ? {
            ...final,
            blocks:
              markdownText(final).length > 0
                ? final.blocks
                : [{ kind: "markdown", text: rendered || "…" }, ...final.blocks],
            replyTo: final.replyTo ?? opts.replyTo,
          }
        : bodyMsg(rendered);

      if (mode === "card" && opts.sink.streamFinish && ctx.token !== undefined) {
        try {
          const refs = await opts.sink.streamFinish(ctx, msg, finalText);
          ctx.refs = refs.length > 0 ? refs : ctx.refs;
          return ctx.refs;
        } catch {
          mode = opts.sink.edit ? "edit" : "buffer";
        }
      }
      return applyEditOrSend(rendered || "…", msg);
    },
    async abort(note?: string) {
      if (closed) return;
      await throttle.flush();
      closed = true;
      await ensureStarted();
      if (mode === "card" && opts.sink.streamAbort && ctx.token !== undefined) {
        try {
          await opts.sink.streamAbort(ctx, note);
          return;
        } catch {
          mode = opts.sink.edit ? "edit" : "buffer";
        }
      }
      const frozen = note ? `${text}${text ? "\n\n" : ""}${note}` : text;
      if (!frozen && ctx.refs.length === 0) return;
      if (mode === "buffer" && ctx.refs.length === 0) {
        if (frozen) {
          ctx.refs = await opts.sink.send(opts.chat, bodyMsg(frozen));
        }
        return;
      }
      await applyEditOrSend(frozen || "…");
    },
  };

  return handle;
}
