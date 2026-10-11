import type { ApprovalRequest } from "@imwire/session";

export type PiTokenEvent =
  | { type: "text"; delta: string }
  | { type: "approval"; req: ApprovalRequest }
  | { type: "end" };

export type PiTokenSource = (
  messages: Array<{ role: string; content: string }>,
  signal?: AbortSignal,
) => AsyncIterable<PiTokenEvent>;

/** In-process fake provider — no network. Used by tests and local demos. */
export function createFakePiProvider(script: PiTokenEvent[]): PiTokenSource {
  return async function* (_messages, signal) {
    for (const event of script) {
      if (signal?.aborted) return;
      yield event;
    }
    yield { type: "end" };
  };
}
