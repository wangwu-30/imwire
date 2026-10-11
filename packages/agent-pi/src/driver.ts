import type { AgentDriver, ConversationSnapshot, TurnResult, TurnSink, UserTurn } from "@imwire/session";
import { createFakePiProvider, type PiTokenSource } from "./fake-provider.js";

export interface PiAgentDriverOptions {
  source?: PiTokenSource;
  systemPrompt?: string;
  /** When set, the real pi Agent is used (model/provider via env). */
  usePi?: boolean;
  modelProvider?: string;
  modelId?: string;
}

/**
 * AgentDriver over `@earendil-works/pi-agent-core`.
 * Tests inject `source` (fake provider). Production can set `usePi: true`
 * and PI_* / provider API keys in the environment.
 */
export class PiAgentDriver implements AgentDriver {
  private readonly source: PiTokenSource;
  private readonly systemPrompt: string;
  private readonly sessions = new Map<string, Array<{ role: string; content: string }>>();

  constructor(opts: PiAgentDriverOptions = {}) {
    this.source = opts.source ?? createFakePiProvider([{ type: "text", delta: "…" }]);
    this.systemPrompt = opts.systemPrompt ?? "You are a helpful assistant.";
    if (opts.usePi) {
      this.source = wrapRealPi(opts) ?? this.source;
    }
  }

  async ensureSession(conv: ConversationSnapshot): Promise<{ agentSessionId: string }> {
    const id = `pi:${conv.id}`;
    if (!this.sessions.has(id)) {
      const history = conv.messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.text,
      }));
      this.sessions.set(id, [{ role: "system", content: this.systemPrompt }, ...history]);
    }
    return { agentSessionId: id };
  }

  async prompt(sessionId: string, input: UserTurn, sink: TurnSink): Promise<TurnResult> {
    const messages = this.sessions.get(sessionId) ?? [{ role: "system", content: this.systemPrompt }];
    messages.push({ role: "user", content: input.text });
    let text = "";
    for await (const event of this.source(messages)) {
      if (event.type === "text") {
        text += event.delta;
        sink.text(event.delta);
      } else if (event.type === "approval") {
        const decision = await sink.requestApproval(event.req);
        messages.push({ role: "user", content: `approval:${event.req.toolCallId}=${decision}` });
      }
    }
    messages.push({ role: "assistant", content: text });
    this.sessions.set(sessionId, messages);
    return { text };
  }

  async cancel(): Promise<void> {
    return;
  }
}

function wrapRealPi(opts: PiAgentDriverOptions): PiTokenSource | undefined {
  // Bound at runtime so tests never load provider SDKs.
  return async function* (messages) {
    const core = await import("@earendil-works/pi-agent-core");
    const Agent = (core as unknown as { Agent?: new (o: Record<string, unknown>) => PiAgent }).Agent;
    const all = await import("@earendil-works/pi-ai/providers/all" as string).catch(() => undefined);
    const ai = await import("@earendil-works/pi-ai");
    const builtinModels = (all as { builtinModels?: () => PiModels } | undefined)?.builtinModels;
    const createModels = (ai as { createModels?: () => PiModels }).createModels;
    const models = builtinModels?.() ?? createModels?.();
    if (!Agent || !models) {
      yield { type: "text", delta: "pi packages loaded but Agent / models were not found." };
      return;
    }
    const provider = opts.modelProvider ?? process.env.IMWIRE_PI_PROVIDER ?? "openai";
    const modelId = opts.modelId ?? process.env.IMWIRE_PI_MODEL ?? "gpt-4o-mini";
    const model = models.getModel?.(provider, modelId);
    const chunks: string[] = [];
    const agent = new Agent({
      initialState: { systemPrompt: opts.systemPrompt ?? "You are a helpful assistant.", model, messages },
      streamFn: models.streamSimple?.bind(models),
    });
    agent.subscribe?.((event) => {
      const inner = (event as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
      if ((event as { type?: string }).type === "message_update" && inner?.type === "text_delta" && inner.delta) {
        chunks.push(inner.delta);
      }
    });
    const last = messages.at(-1)?.content ?? "";
    await agent.prompt?.(last);
    for (const c of chunks) yield { type: "text", delta: c };
  };
}

interface PiModels {
  getModel?(provider: string, id: string): unknown;
  streamSimple?: (...args: unknown[]) => unknown;
}

interface PiAgent {
  subscribe?(fn: (event: unknown) => void): void;
  prompt?(text: string): Promise<unknown>;
}
