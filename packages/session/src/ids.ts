import { createHash, randomBytes, randomInt } from "node:crypto";

export function newId(prefix = ""): string {
  const hex = randomBytes(12).toString("hex");
  return prefix ? `${prefix}_${hex}` : hex;
}

export function pairCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
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
