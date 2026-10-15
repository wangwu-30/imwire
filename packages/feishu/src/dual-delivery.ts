import { createHash } from "node:crypto";
import type { Inbound } from "@imwire/core";
import { asRecord, asString } from "./util.js";

const PAIR_WINDOW_MS = 1_000;
const LATE_COPY_TTL_MS = 25_000;
const MAX_ENTRIES = 10_000;

interface Delivery {
  messageId: string;
  expires: number;
  pending?: { timer: ReturnType<typeof setTimeout>; resolve: (id: string) => void; winner: Promise<string> };
}

/** Inspired by Cindy's dualDelivery idea; independently implemented for L1 admission.
 * State belongs to one adapter and survives transport reconnects. No Agent route leases.
 */
export class FeishuDualDelivery {
  private readonly deliveries = new Map<string, Delivery>();

  constructor(private readonly appId: string) {}

  async accept(event: Inbound): Promise<boolean> {
    if (event.type !== "message" && event.type !== "command") return true;
    if (event.chat.kind !== "group") return true;
    const raw = asRecord(event.raw);
    const payload = asRecord(raw?.event) ?? raw;
    const message = asRecord(payload?.message);
    const sender = asRecord(payload?.sender);
    const ids = asRecord(sender?.sender_id) ?? sender;
    const senderId = asString(ids?.open_id) ?? asString(ids?.user_id) ?? asString(ids?.union_id);
    const time = asString(message?.create_time);
    const type = asString(message?.message_type);
    const content = message?.content;
    // Missing identity must not collapse unrelated messages into one logical send.
    if (!senderId || !time || !type || typeof content !== "string") return true;
    const key = createHash("sha256").update(JSON.stringify([
      this.appId, event.chat.accountId, event.chat.chatId, senderId, time, type, content,
    ])).digest("hex");
    const now = Date.now();
    for (const [oldKey, delivery] of this.deliveries) {
      if (!delivery.pending && delivery.expires <= now) this.deliveries.delete(oldKey);
    }
    let delivery = this.deliveries.get(key);
    if (delivery) {
      if (delivery.pending && event.chat.threadId) this.elect(delivery, event.id);
      const winner = delivery.pending ? await delivery.pending.winner : delivery.messageId;
      // Same-id retries still reach AdapterRuntime's existing message-id dedup.
      return winner === event.id;
    }
    delivery = { messageId: event.id, expires: now + LATE_COPY_TTL_MS };
    this.deliveries.set(key, delivery);
    if (!event.chat.threadId) {
      let resolve!: (id: string) => void;
      const winner = new Promise<string>((done) => { resolve = done; });
      const entry = delivery;
      delivery.pending = {
        winner, resolve,
        timer: setTimeout(() => this.elect(entry, entry.messageId), PAIR_WINDOW_MS),
      };
    }
    // Under pressure, release the oldest pending flat rather than lose it or leak timers.
    while (this.deliveries.size > MAX_ENTRIES) {
      const oldest = this.deliveries.entries().next().value;
      if (!oldest) break;
      this.elect(oldest[1], oldest[1].messageId);
      this.deliveries.delete(oldest[0]);
    }
    const winner = delivery.pending ? await delivery.pending.winner : delivery.messageId;
    return winner === event.id;
  }

  private elect(delivery: Delivery, messageId: string): void {
    delivery.messageId = messageId;
    delivery.expires = Date.now() + LATE_COPY_TTL_MS;
    if (delivery.pending) {
      clearTimeout(delivery.pending.timer);
      delivery.pending.resolve(messageId);
      delivery.pending = undefined;
    }
  }

  /** Test-only: discard pending inputs and clear this instance, without global state. */
  resetDualDeliveryForTest(): void {
    for (const delivery of this.deliveries.values()) this.elect(delivery, "");
    this.deliveries.clear();
  }
}
