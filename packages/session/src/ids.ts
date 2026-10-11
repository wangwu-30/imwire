import { createHash, randomBytes, randomInt } from "node:crypto";

export function newId(prefix = ""): string {
  const hex = randomBytes(12).toString("hex");
  return prefix ? `${prefix}_${hex}` : hex;
}

export const PAIR_CODE_LEN = 8;
export const PAIR_CODE_RE = /^\d{8}$/;

/** 8-digit code (~100M possibilities). Long enough that a global guess lock is unnecessary. */
export function pairCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(PAIR_CODE_LEN, "0");
}

export function hashPairCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export function identityKey(platform: string, accountId: string, userId: string): string {
  return `${platform}:${accountId}:${userId}`;
}

export function groupKey(platform: string, accountId: string, chatId: string): string {
  return `${platform}:${accountId}:${chatId}`;
}
