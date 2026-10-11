import { describe, expect, it, vi } from "vitest";
import { createStreamingDraft, type DraftSink, type StreamContext } from "../src/draft.js";
import type { ChatRef, MsgRef, OutMessage } from "../src/types.js";

const chat: ChatRef = {
  platform: "telegram",
  accountId: "bot",
  chatId: "1",
  kind: "dm",
};

function collectSink() {
  const sent: OutMessage[] = [];
  const edited: Array<{ ref: MsgRef; msg: OutMessage }> = [];
  const streams: Array<{ op: string; text?: string; status?: string }> = [];
  let n = 0;
  const sink: DraftSink = {
    async send(_c, msg) {
      sent.push(msg);
      n += 1;
      return [{ chat, messageId: String(n) }];
    },
    async edit(ref, msg) {
      edited.push({ ref, msg });
    },
    async streamStart() {
      streams.push({ op: "start" });
      const ctx: StreamContext = { refs: [{ chat, messageId: "card-1" }], token: "card" };
      return ctx;
    },
    async streamUpdate(_ctx, text, status) {
      streams.push({ op: "update", text, status });
    },
    async streamFinish(_ctx, _msg, text) {
      streams.push({ op: "finish", text });
      return [{ chat, messageId: "card-1" }];
    },
    async streamAbort(_ctx, note) {
      streams.push({ op: "abort", text: note });
    },
  };
  return { sink, sent, edited, streams };
}

describe("createStreamingDraft", () => {
  it("buffers until finalize when mode is buffer", async () => {
    const { sink, sent } = collectSink();
    const draft = createStreamingDraft({
      mode: "buffer",
      maxTextLength: 20,
      throttleMs: 0,
      chat,
      sink: { send: sink.send },
    });
    draft.append("hello ");
    draft.append("world");
    expect(sent).toHaveLength(0);
    const refs = await draft.finalize();
    expect(refs).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.blocks).toEqual([{ kind: "markdown", text: "hello world" }]);
  });

  it("edits in place when mode is edit", async () => {
    const { sink, sent, edited } = collectSink();
    const draft = createStreamingDraft({
      mode: "edit",
      maxTextLength: 100,
      throttleMs: 0,
      chat,
      sink,
    });
    draft.append("Hel");
    draft.append("lo");
    const refs = await draft.finalize();
    expect(refs[0]?.messageId).toBe("1");
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(edited.length).toBeGreaterThanOrEqual(1);
    const last = edited.at(-1)?.msg.blocks[0];
    expect(last).toEqual({ kind: "markdown", text: "Hello" });
  });

  it("uses card streaming when streamStart succeeds", async () => {
    const { sink, streams, sent } = collectSink();
    const draft = createStreamingDraft({
      mode: "card",
      maxTextLength: 100,
      throttleMs: 0,
      chat,
      sink,
    });
    draft.append("alpha");
    await draft.finalize({ blocks: [{ kind: "markdown", text: "alpha" }] });
    expect(streams.map((s) => s.op)).toContain("start");
    expect(streams.map((s) => s.op)).toContain("finish");
    expect(sent).toHaveLength(0);
  });

  it("degrades from card to edit when streamStart throws", async () => {
    const { sink, sent, edited } = collectSink();
    const draft = createStreamingDraft({
      mode: "card",
      maxTextLength: 100,
      throttleMs: 0,
      chat,
      sink: {
        send: sink.send,
        edit: sink.edit,
        streamStart: async () => {
          throw new Error("no cardkit");
        },
      },
    });
    draft.append("x");
    await draft.finalize();
    expect(sent.length).toBeGreaterThan(0);
    expect(edited.length).toBeGreaterThan(0);
  });

  it("splits overflow across maxTextLength", async () => {
    const { sink, sent } = collectSink();
    const draft = createStreamingDraft({
      mode: "buffer",
      maxTextLength: 5,
      throttleMs: 0,
      chat,
      sink: { send: sink.send },
    });
    draft.append("abcdefghij");
    await draft.finalize();
    const texts = sent.flatMap((m) =>
      m.blocks.filter((b) => b.kind === "markdown").map((b) => b.text),
    );
    expect(texts.join("").replaceAll(" ", "")).toContain("abcdefghij");
    expect(sent.length).toBeGreaterThan(1);
  });

  it("abort freezes a sent draft with a note", async () => {
    const { sink, edited, sent } = collectSink();
    const draft = createStreamingDraft({
      mode: "edit",
      maxTextLength: 100,
      throttleMs: 0,
      chat,
      sink,
    });
    draft.append("partial");
    await draft.abort("→ moved to Telegram");
    const lastText =
      edited.at(-1)?.msg.blocks.find((b) => b.kind === "markdown")?.text ??
      sent.at(-1)?.blocks.find((b) => b.kind === "markdown")?.text;
    expect(lastText).toContain("partial");
    expect(lastText).toContain("moved to Telegram");
  });

  it("coalesces a 5s stream against a 1s sink to about 6 edits", async () => {
    vi.useFakeTimers();
    try {
      let edits = 0;
      const sink: DraftSink = {
        async send() {
          edits += 1;
          return [{ chat, messageId: "1" }];
        },
        async edit() {
          edits += 1;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        },
      };
      const draft = createStreamingDraft({
        mode: "edit",
        maxTextLength: 10_000,
        throttleMs: 200,
        chat,
        sink,
      });
      const run = (async () => {
        for (let i = 0; i < 50; i += 1) {
          draft.append("x");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const t0 = Date.now();
        await draft.finalize();
        return Date.now() - t0;
      })();
      await vi.advanceTimersByTimeAsync(20_000);
      const tailMs = await run;
      expect(edits).toBeGreaterThanOrEqual(4);
      expect(edits).toBeLessThanOrEqual(8);
      expect(tailMs).toBeLessThan(3000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips an unchanged edit fingerprint", async () => {
    const { sink, sent, edited } = collectSink();
    const draft = createStreamingDraft({
      mode: "edit",
      maxTextLength: 100,
      throttleMs: 0,
      chat,
      sink,
    });
    draft.append("same");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await draft.finalize({ blocks: [{ kind: "markdown", text: "same" }] });
    expect(sent).toHaveLength(1);
    expect(edited.length).toBeLessThanOrEqual(1);
  });
});
