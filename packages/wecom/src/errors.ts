const AUTH_ERRCODES = new Set([40001, 40013, 40014, 40058, 41001, 41002]);

export class WecomApiError extends Error {
  readonly errcode: number;
  readonly retryable: boolean;
  readonly fatal: boolean;

  constructor(message: string, errcode: number) {
    super(message);
    this.name = "WecomApiError";
    this.errcode = errcode;
    // 30/min and 1000/h rate limits — treat as retryable.
    this.retryable = errcode === 45009 || errcode === 45033 || errcode === -1;
    this.fatal = AUTH_ERRCODES.has(errcode);
  }
}

export class WecomKickError extends Error {
  readonly retryable = true;

  constructor() {
    super("wecom disconnected_event: another instance took over");
    this.name = "WecomKickError";
  }
}

export function wecomShouldRetry(err: unknown): boolean {
  if (err instanceof WecomApiError && err.fatal) return false;
  return true;
}
