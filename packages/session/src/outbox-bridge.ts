import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, open, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { noopLogger, type Logger } from "@imwire/core";
import type { SessionGateway } from "./gateway.js";
import type { OutboxDelivery } from "./store.js";

export interface OutboxBridgeOptions {
  enabled?: boolean;
  dir?: string;
  pollMs?: number;
}

export interface OutboxItem {
  v: 1;
  outbox_id: string;
  kind: "routed_chat" | "critical_chat" | "expired_notice";
  person_id: string;
  request_id: string;
  card_version: number;
  text: string;
  created_at: string;
  untrusted: true;
  deeplink?: string;
}

export interface OutboxResult {
  v: 1;
  outbox_id: string;
  request_id: string;
  card_version: number;
  kind: OutboxItem["kind"] | "invalid";
  status: OutboxDelivery["status"];
  reason?: string;
  channel?: string;
  message_refs?: OutboxDelivery["refs"];
  attempts: number;
  at: string;
}

const BACKOFF = [30_000, 120_000, 600_000, 1_800_000];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function isOutboxItem(value: unknown): value is OutboxItem {
  const v = record(value);
  return !!v && v.v === 1 && typeof v.outbox_id === "string" && SAFE_ID.test(v.outbox_id)
    && ["routed_chat", "critical_chat", "expired_notice"].includes(v.kind as string)
    && typeof v.person_id === "string" && v.person_id.trim().length > 0
    && typeof v.request_id === "string" && v.request_id.trim().length > 0
    && Number.isSafeInteger(v.card_version) && (v.card_version as number) > 0
    && typeof v.text === "string" && v.text.length > 0
    && typeof v.created_at === "string" && /^\d{4}-\d\d-\d\dT/.test(v.created_at) && Number.isFinite(Date.parse(v.created_at))
    && v.untrusted === true
    && (v.deeplink === undefined || (typeof v.deeplink === "string" && v.deeplink.startsWith("hubcards://")));
}

/** One serial consumer per directory. Producers publish only via tmp -> new rename. */
export class OutboxBridge {
  private readonly dir: string;
  private readonly resultsDir: string;
  private readonly pollMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private initialized?: Promise<void>;
  private stopped = false;
  private readonly publishedRetries = new Map<string, number>();

  constructor(
    private readonly gateway: SessionGateway,
    private readonly options: OutboxBridgeOptions,
    private readonly logger: Logger = noopLogger,
    private readonly now: () => number = Date.now,
  ) {
    if (options.enabled && !options.dir) throw new Error("outboxBridge.dir is required when enabled");
    this.dir = resolve(options.dir ?? ".");
    this.resultsDir = resolve(this.dir, "..", "chat-results");
    this.pollMs = options.pollMs ?? 2000;
    if (!Number.isSafeInteger(this.pollMs) || this.pollMs <= 0) throw new Error("outboxBridge.pollMs must be a positive integer");
  }

  async start(): Promise<void> {
    if (!this.options.enabled || this.timer || this.stopped) return;
    await this.initialize();
    if (this.stopped) return;
    // Adapters start alongside the host; the first poll runs after the interval.
    this.timer = setInterval(() => { void this.poll().catch(() => this.ioWarning()); }, this.pollMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => this.ioWarning());
  }

  /** Also useful for deterministic jobs/tests; overlapping polls share one pass. */
  poll(): Promise<void> {
    if (!this.options.enabled || this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.scan().finally(() => { this.running = undefined; });
    return this.running;
  }

  private initialize(): Promise<void> {
    return this.initialized ??= Promise.all([
      ...["tmp", "new", "cur", "done", "dead"].map((d) => mkdir(join(this.dir, d), { recursive: true })),
      ...["tmp", "new"].map((d) => mkdir(join(this.resultsDir, d), { recursive: true })),
    ]).then(() => undefined);
  }

  private async scan(): Promise<void> {
    await this.initialize();
    // Leftover cur files are pending work, including after a process restart.
    for (const folder of ["cur", "new"]) {
      for (const entry of await readdir(join(this.dir, folder), { withFileTypes: true })) {
        if (this.stopped) return;
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        let name = entry.name;
        if (folder === "new") {
          // Unique claim name avoids overwriting an older cur file with the same filename.
          name = `${randomUUID()}.json`;
          try { await rename(join(this.dir, "new", entry.name), join(this.dir, "cur", name)); }
          catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.ioWarning();
            continue;
          }
        }
        try { await this.process(name); }
        catch { this.ioWarning(); } // keep cur; a storage failure must never undo delivered
      }
    }
  }

  private async process(name: string): Promise<void> {
    let value: unknown;
    const raw = await readFile(join(this.dir, "cur", name), "utf8");
    try { value = JSON.parse(raw); } catch { /* quarantined below */ }
    if (!isOutboxItem(value)) {
      await this.invalid(name, value);
      return;
    }
    const item = value;
    const prior = this.gateway.store.getOutboxDelivery(item.outbox_id);
    if (prior?.status === "delivered" || prior?.status === "dead") {
      await this.finish(name, item, prior);
      return;
    }
    if (!this.gateway.store.getPerson(item.person_id)) {
      const row: OutboxDelivery = {
        outboxId: item.outbox_id, status: "dead", reason: "invalid", attempts: prior?.attempts ?? 0,
        nextTryAt: null, refs: [], updatedAt: this.now(),
      };
      this.gateway.store.putOutboxDelivery(row);
      await this.finish(name, item, row);
      return;
    }
    if (prior?.nextTryAt && prior.nextTryAt > this.now()) {
      // Retry failed result publication (and replay it after restart) without sending early.
      if (this.publishedRetries.get(item.outbox_id) !== prior.updatedAt) await this.finish(name, item, prior);
      return;
    }
    const attempts = prior?.attempts ?? 0;
    let errorCode: string | undefined;
    let row: OutboxDelivery = {
      outboxId: item.outbox_id, status: "dead", reason: "exhausted", attempts,
      nextTryAt: null, refs: [], updatedAt: this.now(),
    };
    if (attempts < 5) {
      row = { ...row, status: "retrying", reason: undefined, attempts: attempts + 1 };
      // Count attempts before the external effect so restart cannot reset the budget.
      this.gateway.store.putOutboxDelivery(row);
      const result = await this.gateway.sendProactiveTo(item.person_id, item.text, { idempotencyKey: item.outbox_id });
      row.updatedAt = this.now();
      if (result.status === "delivered") {
        // Gateway commits refs + addDelivery in the same transaction.
        row = this.gateway.store.getOutboxDelivery(item.outbox_id)!;
      } else {
        errorCode = result.status === "dead" ? result.detail : result.reason;
        row.channel = result.channel;
        row.status = result.status;
        row.reason = result.reason === "no_surface" ? "unsupported" : result.reason;
        if (result.status === "retrying") {
          if (row.attempts >= 5) { row.status = "dead"; row.reason = "exhausted"; }
          else row.nextTryAt = this.now() + Math.max(BACKOFF[row.attempts - 1]!, result.retryAfterMs ?? 0);
        }
      }
    }
    this.gateway.store.putOutboxDelivery(row);
    await this.finish(name, item, row, errorCode);
  }

  private async finish(name: string, item: OutboxItem, row: OutboxDelivery, errorCode?: string): Promise<void> {
    await this.publish({
      v: 1, outbox_id: item.outbox_id, request_id: item.request_id, card_version: item.card_version,
      kind: item.kind, status: row.status, reason: row.reason, channel: row.channel,
      message_refs: row.refs.length ? row.refs : undefined, attempts: row.attempts,
      at: new Date(row.updatedAt).toISOString(),
    });
    if (row.status === "retrying") this.publishedRetries.set(item.outbox_id, row.updatedAt);
    else this.publishedRetries.delete(item.outbox_id);
    if (row.status === "dead") await writeFile(join(this.dir, "cur", `${name}.reason`), `${row.reason}\n`, { mode: 0o600 });
    if (row.status !== "retrying") {
      const dest = row.status === "delivered" ? "done" : "dead";
      if (dest === "dead") await rename(join(this.dir, "cur", `${name}.reason`), join(this.dir, dest, `${name}.reason`));
      await rename(join(this.dir, "cur", name), join(this.dir, dest, name));
    }
    this.logger.info("outbox delivery", { outbox_id: item.outbox_id, channel: row.channel, status: row.status, code: errorCode ?? row.reason });
  }

  private async invalid(name: string, value: unknown): Promise<void> {
    const v = record(value);
    const id = typeof v?.outbox_id === "string" && SAFE_ID.test(v.outbox_id)
      ? v.outbox_id : `invalid-${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
    await this.publish({
      v: 1, outbox_id: id, request_id: typeof v?.request_id === "string" ? v.request_id : "",
      card_version: Number.isSafeInteger(v?.card_version) ? v!.card_version as number : 0,
      kind: ["routed_chat", "critical_chat", "expired_notice"].includes(v?.kind as string) ? v!.kind as OutboxItem["kind"] : "invalid",
      status: "dead", reason: "invalid", attempts: 0, at: new Date(this.now()).toISOString(),
    });
    await writeFile(join(this.dir, "dead", `${name}.reason`), "invalid\n", { mode: 0o600 });
    await rename(join(this.dir, "cur", name), join(this.dir, "dead", name));
    this.logger.warn("outbox delivery", { outbox_id: id, status: "dead", code: "invalid" });
  }

  private async publish(result: OutboxResult): Promise<void> {
    const temp = join(this.resultsDir, "tmp", `${result.outbox_id}-${randomUUID()}.json`);
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(result) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, join(this.resultsDir, "new", `${result.outbox_id}.json`));
  }

  private ioWarning(): void {
    this.logger.warn("outbox storage failure", { status: "retrying", code: "storage" });
  }
}
