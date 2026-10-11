import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "@imwire/core";
import { asNumber, asRecord, asString } from "./util.js";

/**
 * Official reply window after an inbound callback:
 * 「收到消息回调后，24 小时内可以往该会话回复消息。」
 * https://developer.work.weixin.qq.com/document/path/101463
 */
export const WECOM_REPLY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Default in-memory budget for the reply LRU (~1 MiB).
 * Each inbound stores two keys (chatId + msgid); a slot is ~150–400 bytes
 * including Map overhead, so the default holds a few thousand chats.
 * Older-than-TTL slots are dropped first; if the budget is still exceeded,
 * the least-recently-used key is evicted even if it is still inside the 24h window.
 */
export const WECOM_REPLY_MAX_BYTES = 1 * 1024 * 1024;

const ENTRY_OVERHEAD = 64;

export interface ReplySlot {
  reqId: string;
  msgid: string;
  at: number;
}

export interface WecomReplyStoreOptions {
  ttlMs?: number;
  maxBytes?: number;
  persistPath?: string;
  now?: () => number;
  logger?: Logger;
}

export class WecomReplyStore {
  readonly ttlMs: number;
  readonly maxBytes: number;
  private readonly persistPath?: string;
  private readonly nowFn: () => number;
  private readonly logger?: Logger;
  private readonly map = new Map<string, ReplySlot>();
  private bytes = 0;

  constructor(opts: WecomReplyStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? WECOM_REPLY_TTL_MS;
    this.maxBytes = Math.max(256, opts.maxBytes ?? WECOM_REPLY_MAX_BYTES);
    this.persistPath = opts.persistPath;
    this.nowFn = opts.now ?? Date.now;
    this.logger = opts.logger;
    this.load();
  }

  now(): number {
    return this.nowFn();
  }

  get size(): number {
    return this.map.size;
  }

  get byteSize(): number {
    return this.bytes;
  }

  get(key: string): ReplySlot | undefined {
    this.pruneExpired();
    const slot = this.map.get(key);
    if (!slot) return undefined;
    if (this.nowFn() - slot.at > this.ttlMs) {
      this.deleteKey(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, slot);
    return slot;
  }

  set(key: string, slot: ReplySlot): void {
    this.pruneExpired();
    if (this.map.has(key)) this.deleteKey(key);
    this.map.set(key, slot);
    this.bytes += estimateBytes(key, slot);
    this.evictToBudget();
    this.save();
  }

  private pruneExpired(): void {
    const now = this.nowFn();
    for (const [key, slot] of this.map) {
      if (now - slot.at > this.ttlMs) this.deleteKey(key);
    }
  }

  private evictToBudget(): void {
    while (this.bytes > this.maxBytes && this.map.size > 0) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.deleteKey(oldest);
    }
  }

  private deleteKey(key: string): void {
    const slot = this.map.get(key);
    if (!slot) return;
    this.bytes = Math.max(0, this.bytes - estimateBytes(key, slot));
    this.map.delete(key);
  }

  private load(): void {
    if (!this.persistPath) return;
    let raw: string;
    try {
      raw = readFileSync(this.persistPath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger?.warn("wecom reply store: failed to read persist file", {
          path: this.persistPath,
          err: String(err),
        });
      }
      return;
    }
    try {
      const rec = asRecord(JSON.parse(raw));
      const entries = Array.isArray(rec?.entries) ? rec.entries : [];
      const now = this.nowFn();
      for (const item of entries) {
        if (!Array.isArray(item) || item.length < 2) continue;
        const key = asString(item[0]);
        const slotRec = asRecord(item[1]);
        const reqId = asString(slotRec?.reqId);
        const msgid = asString(slotRec?.msgid);
        const at = asNumber(slotRec?.at);
        if (!key || !reqId || !msgid || at === undefined) continue;
        if (now - at > this.ttlMs) continue;
        const slot: ReplySlot = { reqId, msgid, at };
        if (this.map.has(key)) this.deleteKey(key);
        this.map.set(key, slot);
        this.bytes += estimateBytes(key, slot);
      }
      this.evictToBudget();
    } catch (err) {
      this.logger?.warn("wecom reply store: persist file corrupt; starting empty", {
        path: this.persistPath,
        err: String(err),
      });
      this.map.clear();
      this.bytes = 0;
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    const payload = JSON.stringify({
      version: 1,
      entries: [...this.map.entries()],
    });
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, payload);
      renameSync(tmp, this.persistPath);
    } catch (err) {
      this.logger?.warn("wecom reply store: failed to persist", {
        path: this.persistPath,
        err: String(err),
      });
    }
  }
}

function estimateBytes(key: string, slot: ReplySlot): number {
  return (
    ENTRY_OVERHEAD +
    Buffer.byteLength(key, "utf8") +
    Buffer.byteLength(slot.reqId, "utf8") +
    Buffer.byteLength(slot.msgid, "utf8")
  );
}
