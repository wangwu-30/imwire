/**
 * Fatal credential / config errcodes — reconnect must stop.
 * https://developer.work.weixin.qq.com/document/path/96213
 *
 * Credential:
 * - 40001 不合法的secret参数
 * - 40013 不合法的CorpID
 * - 40014 不合法的access_token
 * - 40058 不合法的参数 (subscribe also uses this for a bad secret)
 * - 40091 secret不合法
 * - 41001 缺少access_token参数
 * - 41002 缺少corpid参数
 * - 41004 / 41024 缺少secret参数
 * - 853000 无效的 bot_id 或者 secret
 *
 * Config that will not recover without an admin change:
 * - 846601 机器人未开启长连接模式
 */
export const WECOM_AUTH_ERRCODES = new Set([
  40001, 40013, 40014, 40058, 40091, 41001, 41002, 41004, 41024, 846601, 853000,
]);

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
    this.fatal = WECOM_AUTH_ERRCODES.has(errcode);
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
