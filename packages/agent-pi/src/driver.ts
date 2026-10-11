import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, type Api, type Model, type Models } from "@earendil-works/pi-ai";
import type {
  AgentDriver,
  ApprovalDecision,
  ConversationSnapshot,
  TurnResult,
  TurnSink,
  UserTurn,
} from "@imwire/session";
import { isExplicitApprove } from "@imwire/session";
import { createFakePiProvider, type PiTokenSource } from "./fake-provider.js";
import { snapshotToPi, userTextOf, windowMessages } from "./messages.js";

export interface PiAgentDriverOptions {
  source?: PiTokenSource;
  systemPrompt?: string;
  usePi?: boolean;
  modelProvider?: string;
  modelId?: string;
  /** Injected Models (tests: createModels + fauxProvider). */
  models?: Models;
  contextChars?: number;
  tools?: AgentTool[];
  /**
   * Accept a model id that pi's catalog doesn't list yet (new or preview
   * releases) by borrowing a sibling model's settings from the same provider.
   * Default: `IMWIRE_PI_ALLOW_UNLISTED_MODEL=1`.
   */
  allowUnlistedModel?: boolean;
}

type LiveAgent = {
  agent: Agent;
  model: Model<Api>;
  provider: string;
  modelId: string;
};

/**
 * AgentDriver over `@earendil-works/pi-agent-core` 1.1.0.
 * One Agent per conversation so steer / abort work. History is rebuilt from
 * the session log (pi message shapes) on ensureSession.
 */
export class PiAgentDriver implements AgentDriver {
  private readonly source?: PiTokenSource;
  private readonly systemPrompt: string;
  private readonly usePi: boolean;
  private readonly modelProvider: string;
  private readonly modelId: string;
  private readonly models?: Models;
  private readonly contextChars: number;
  private readonly tools: AgentTool[];
  private readonly allowUnlistedModel: boolean;
  private readonly agents = new Map<string, LiveAgent>();
  private readonly snaps = new Map<string, ConversationSnapshot>();
  private readonly legacy = new Map<string, Array<{ role: string; content: string }>>();
  private readonly prompting = new Set<string>();
  private readonly cancels = new Map<string, AbortController>();

  constructor(opts: PiAgentDriverOptions = {}) {
    this.systemPrompt = opts.systemPrompt ?? "You are a helpful assistant.";
    this.usePi = Boolean(opts.usePi || opts.models);
    this.modelProvider = opts.modelProvider ?? process.env.IMWIRE_PI_PROVIDER ?? "openai";
    this.modelId = opts.modelId ?? process.env.IMWIRE_PI_MODEL ?? "gpt-4o-mini";
    this.models = opts.models;
    this.contextChars = opts.contextChars ?? 32_000;
    this.tools = opts.tools ?? [];
    this.allowUnlistedModel = opts.allowUnlistedModel ?? process.env.IMWIRE_PI_ALLOW_UNLISTED_MODEL === "1";
    if (!this.usePi) this.source = opts.source ?? createFakePiProvider([{ type: "text", delta: "…" }]);
  }

  async ensureSession(conv: ConversationSnapshot): Promise<{ agentSessionId: string }> {
    const id = `pi:${conv.id}`;
    this.snaps.set(id, conv);
    if (this.usePi) {
      try {
        await this.ensureAgent(id, conv);
      } catch {
        // retry on the next prompt — a transient loadModels/getModel failure must not stick
      }
    } else if (!this.legacy.has(id)) {
      this.legacy.set(id, [{ role: "system", content: this.systemPrompt }]);
    }
    return { agentSessionId: id };
  }

  async prompt(sessionId: string, input: UserTurn, sink: TurnSink): Promise<TurnResult> {
    if (this.usePi) return this.promptPi(sessionId, input, sink);
    return this.promptLegacy(sessionId, input, sink);
  }

  async steer(sessionId: string, input: UserTurn): Promise<boolean> {
    const live = this.agents.get(sessionId);
    if (!live) return false;
    if (!live.agent.state.isStreaming && !this.prompting.has(sessionId)) return false;
    live.agent.steer({ role: "user", content: input.text, timestamp: Date.now() });
    return true;
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancels.get(sessionId)?.abort();
    this.agents.get(sessionId)?.agent.abort();
  }

  private async ensureAgent(sessionId: string, conv: ConversationSnapshot): Promise<LiveAgent> {
    const existing = this.agents.get(sessionId);
    if (existing) {
      existing.agent.state.messages = snapshotToPi(conv, {
        systemPrompt: this.systemPrompt,
        provider: existing.provider,
        model: existing.modelId,
        maxChars: this.contextChars,
      });
      return existing;
    }
    const models = this.models ?? (await loadModels());
    const model = resolveModel(models, this.modelProvider, this.modelId, {
      allowUnlisted: this.allowUnlistedModel,
    });
    if (!model) {
      throw new Error(`Unknown model ${this.modelProvider}/${this.modelId}. Set IMWIRE_PI_PROVIDER / IMWIRE_PI_MODEL (or IMWIRE_PI_ALLOW_UNLISTED_MODEL=1 for ids newer than pi's catalog).`);
    }
    const messages = snapshotToPi(conv, {
      systemPrompt: this.systemPrompt,
      provider: this.modelProvider,
      model: this.modelId,
      maxChars: this.contextChars,
    });
    const agent = new Agent({
      initialState: {
        systemPrompt: this.systemPrompt,
        model,
        messages,
        tools: this.tools,
      },
      streamFn: models.streamSimple.bind(models),
      transformContext: async (msgs) => windowMessages(msgs, this.contextChars),
      beforeToolCall: async (ctx, signal) => {
        if (signal?.aborted || this.cancels.get(sessionId)?.signal.aborted) {
          return { block: true, reason: "cancelled", terminate: true };
        }
        const sink = this.activeSink.get(sessionId);
        if (!sink) return { block: true, reason: "no active turn" };
        const decision: ApprovalDecision = await Promise.race([
          sink.requestApproval({
            toolCallId: ctx.toolCall.id,
            title: `Run ${ctx.toolCall.name}?`,
            options: ["approve", "deny"],
          }),
          abortDecision(signal),
          abortDecision(this.cancels.get(sessionId)?.signal),
        ]);
        if (signal?.aborted || this.cancels.get(sessionId)?.signal.aborted) {
          return { block: true, reason: "cancelled", terminate: true };
        }
        if (!isExplicitApprove(decision)) return { block: true, reason: `denied:${decision}`, terminate: true };
        return undefined;
      },
    });
    const live = { agent, model, provider: this.modelProvider, modelId: this.modelId };
    this.agents.set(sessionId, live);
    return live;
  }

  private readonly activeSink = new Map<string, TurnSink>();

  private async promptPi(sessionId: string, input: UserTurn, sink: TurnSink): Promise<TurnResult> {
    this.activeSink.set(sessionId, sink);
    const ac = new AbortController();
    this.cancels.set(sessionId, ac);
    this.prompting.add(sessionId);
    try {
      const snap = this.snaps.get(sessionId);
      let live: LiveAgent;
      try {
        live = await this.ensureAgent(sessionId, snap ?? { id: sessionId, title: "default", isDefault: true, messages: [] });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sink.text(msg);
        return { text: msg };
      }

      if (snap) {
        const mapped = snapshotToPi(snap, {
          systemPrompt: this.systemPrompt,
          provider: live.provider,
          model: live.modelId,
          maxChars: this.contextChars,
        });
        if (live.agent.state.messages.length <= mapped.length) {
          live.agent.state.messages = mapped;
        }
      }

      let text = "";
      const unsub = live.agent.subscribe((event) => {
        if (event.type !== "message_update") return;
        const inner = event.assistantMessageEvent;
        if (inner.type === "text_delta" && inner.delta) {
          text += inner.delta;
          sink.text(inner.delta);
        }
      });

      const already = inputAlreadyPresent(live.agent.state.messages, input.text);
      if (already) await live.agent.continue();
      else await live.agent.prompt({ role: "user", content: input.text, timestamp: Date.now() });
      unsub();

      const err = live.agent.state.errorMessage;
      const lastMsg = live.agent.state.messages.at(-1);
      const stop =
        lastMsg && lastMsg.role === "assistant" && "stopReason" in lastMsg
          ? (lastMsg as { stopReason?: string; errorMessage?: string })
          : undefined;
      if (err || stop?.stopReason === "error") {
        const msg = err ?? stop?.errorMessage ?? "model error";
        if (!text) sink.text(msg);
        return { text: text || msg };
      }
      return { text };
    } finally {
      this.prompting.delete(sessionId);
      this.activeSink.delete(sessionId);
      this.cancels.delete(sessionId);
    }
  }

  private async promptLegacy(sessionId: string, input: UserTurn, sink: TurnSink): Promise<TurnResult> {
    const snap = this.snaps.get(sessionId);
    const history = this.legacy.get(sessionId) ?? [{ role: "system", content: this.systemPrompt }];
    const last = history.at(-1);
    if (!(last?.role === "user" && last.content === input.text) && !snapHasUser(snap, input.text)) {
      history.push({ role: "user", content: input.text });
    } else if (last?.role !== "user") {
      // snapshot already has it; do not duplicate
    }
    let text = "";
    const source = this.source!;
    for await (const event of source(history)) {
      if (event.type === "text") {
        text += event.delta;
        sink.text(event.delta);
      } else if (event.type === "approval") {
        await sink.requestApproval(event.req);
      }
    }
    history.push({ role: "assistant", content: text });
    this.legacy.set(sessionId, history);
    return { text };
  }
}

function snapHasUser(snap: ConversationSnapshot | undefined, text: string): boolean {
  if (!snap) return false;
  if (snap.messages.some((m) => m.role === "user" && m.text === text)) return true;
  const parts = text.split("\n").filter(Boolean);
  if (parts.length > 1) {
    const users = snap.messages.filter((m) => m.role === "user").map((m) => m.text);
    if (parts.every((p) => users.includes(p))) return true;
  }
  const last = snap.messages.at(-1);
  return last?.role === "user" && last.text === text;
}

function inputAlreadyPresent(messages: Array<{ role?: string; content?: unknown }>, text: string): boolean {
  const users = messages.filter((m) => m.role === "user").map((m) => userTextOf(m));
  if (users.includes(text)) return true;
  const parts = text.split("\n").filter(Boolean);
  if (parts.length > 1 && parts.every((p) => users.includes(p))) return true;
  const last = messages.at(-1);
  return last?.role === "user" && userTextOf(last) === text;
}

function abortDecision(signal?: AbortSignal): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) {
      resolve("deny");
      return;
    }
    signal.addEventListener("abort", () => resolve("deny"), { once: true });
  });
}

/**
 * Look up a model; if the provider is known but this id isn't in pi's catalog yet
 * (new or preview releases), reuse a sibling model's transport config under the
 * requested id so the provider's API decides whether the id is valid.
 * Off by default: an unknown id is usually a typo, which should surface as an error.
 */
export function resolveModel(
  models: Pick<Models, "getModel"> & { getModels?: (provider: never) => readonly unknown[] },
  provider: string,
  id: string,
  opts: { allowUnlisted?: boolean; warn?: (msg: string) => void } = {},
): Model<Api> | undefined {
  const exact = models.getModel(provider as never, id as never) as Model<Api> | undefined;
  if (exact) return exact;
  if (!opts.allowUnlisted) return undefined;
  const siblings = (models.getModels?.(provider as never) ?? []) as Model<Api>[];
  const base = siblings[0];
  if (!base) return undefined;
  (opts.warn ?? console.warn)(
    `pi: ${provider}/${id} is not in the built-in catalog; using ${base.id}'s settings with id ${id}`,
  );
  // Don't force thinking off on a model we know nothing about: some (e.g. MiniMax
  // M3.1 previews) reject thinking.type="disabled". Omitting it uses the provider default.
  const thinkingLevelMap = { ...(base as { thinkingLevelMap?: Record<string, unknown> }).thinkingLevelMap, off: null };
  return { ...base, id, name: id, thinkingLevelMap } as Model<Api>;
}

async function loadModels(): Promise<Models> {
  try {
    const all = await import("@earendil-works/pi-ai/providers/all");
    if (typeof all.builtinModels === "function") return all.builtinModels();
  } catch {
    // fall through
  }
  return createModels();
}
