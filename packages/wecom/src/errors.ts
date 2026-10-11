export class WecomApiError extends Error {
  readonly errcode: number;
  readonly retryable: boolean;

  constructor(message: string, errcode: number) {
    super(message);
    this.name = "WecomApiError";
    this.errcode = errcode;
    // 30/min and 1000/h rate limits — treat as retryable.
    this.retryable = errcode === 45009 || errcode === 45033 || errcode === -1;
  }
}
