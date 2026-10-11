import type { AgentDriver, ConversationSnapshot, TurnResult, TurnSink, UserTurn } from "./types.js";

export interface ScriptedController {
  wait(name: string): Promise<void>;
  release(name: string): void;
}

type Script = (sink: TurnSink, ctl: ScriptedController) => Promise<void>;

/**
 * Test / demo driver. The test script controls token timing and approvals.
 */
export class ScriptedDriver implements AgentDriver {
  private script: Script;
  private readonly gates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  lastSessionId?: string;
  private cancelled = false;

  constructor(script?: Script) {
    this.script = script ?? (async (sink) => {
      sink.text("ok");
    });
  }

  plan(script: Script): void {
    this.script = script;
  }

  release(name: string): void {
    const gate = this.gates.get(name);
    if (gate) gate.resolve();
    else this.gate(name).resolve();
  }

  async ensureSession(conv: ConversationSnapshot): Promise<{ agentSessionId: string }> {
    this.lastSessionId = `scripted:${conv.id}`;
    return { agentSessionId: this.lastSessionId };
  }

  async prompt(_sessionId: string, _input: UserTurn, sink: TurnSink): Promise<TurnResult> {
    this.cancelled = false;
    const ctl: ScriptedController = {
      wait: async (name) => {
        if (this.cancelled) throw new Error("cancelled");
        await this.gate(name).promise;
        if (this.cancelled) throw new Error("cancelled");
      },
      release: (name) => this.release(name),
    };
    await this.script(sink, ctl);
    return { text: "" };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    for (const g of this.gates.values()) g.resolve();
  }

  private gate(name: string): { promise: Promise<void>; resolve: () => void } {
    const existing = this.gates.get(name);
    if (existing) return existing;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const g = { promise, resolve };
    this.gates.set(name, g);
    return g;
  }
}
