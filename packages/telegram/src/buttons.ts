import { createHash } from "node:crypto";
import type { Button } from "@imwire/core";

const LIMIT = 64;
export const CALLBACK_TABLE_LIMIT = 256;

export interface CallbackEntry {
  id: string;
  value?: string;
}

export interface CallbackPersist {
  get(key: string): CallbackEntry | undefined;
  set(key: string, value: CallbackEntry): void;
}

/**
 * Bounded in-memory LRU for Telegram callback_data hashes.
 * Optional `persist` (typically SQLite via the session store) survives restarts
 * so inbound `h:<hash>` clicks still resolve to the original id/value.
 */
export class BoundedLru<V> {
  private readonly map = new Map<string, V>();

  constructor(
    readonly max: number,
    private readonly persist?: { get(key: string): V | undefined; set(key: string, value: V): void },
  ) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    let value = this.map.get(key);
    if (value === undefined && this.persist) {
      value = this.persist.get(key);
      if (value === undefined) return undefined;
    } else if (value === undefined) {
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    this.persist?.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

export function createCallbackTable(
  max = CALLBACK_TABLE_LIMIT,
  persist?: CallbackPersist,
): BoundedLru<CallbackEntry> {
  return new BoundedLru(max, persist);
}

export function encodeCallbackData(
  button: Button,
  table: BoundedLru<CallbackEntry> | Map<string, CallbackEntry>,
): string {
  const payload = button.value !== undefined ? `${button.id}:${button.value}` : button.id;
  const bytes = new TextEncoder().encode(payload);
  if (bytes.length <= LIMIT) return payload;
  const hash = createHash("sha256").update(payload).digest("hex").slice(0, 16);
  const short = `h:${hash}`;
  table.set(short, { id: button.id, value: button.value });
  return short;
}

export function decodeCallbackData(
  data: string,
  table: BoundedLru<CallbackEntry> | Map<string, CallbackEntry>,
): { actionId: string; value?: string } {
  if (data.startsWith("h:")) {
    const hashed = table.get(data);
    if (hashed) return { actionId: hashed.id, value: hashed.value };
    return { actionId: data };
  }
  const hashed = table.get(data);
  if (hashed) return { actionId: hashed.id, value: hashed.value };
  const idx = data.indexOf(":");
  if (idx === -1) return { actionId: data };
  return { actionId: data.slice(0, idx), value: data.slice(idx + 1) };
}

export function inlineKeyboard(
  buttons: Button[],
  table: BoundedLru<CallbackEntry> | Map<string, CallbackEntry>,
) {
  return {
    inline_keyboard: [
      buttons.map((b) => ({
        text: b.style === "danger" ? `✕ ${b.label}` : b.style === "primary" ? `● ${b.label}` : b.label,
        callback_data: encodeCallbackData(b, table),
      })),
    ],
  };
}
