import { mkdtempSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import type { Clock, Logger } from "@imwire/core";
import type { FakeAdapter } from "@imwire/core/testing";
import { totp } from "@imwire/session";
import { cmd, fakeAdapter, owner } from "../../session/tests/helpers.js";
import { HubAdmin } from "../src/hub/admin.js";
import { startHub, type Hub } from "../src/hub/hub.js";
import { UnixRpcClient } from "../src/hub/unix-server.js";

export class ManualClock implements Clock {
  constructor(public t = Date.UTC(2026, 9, 12, 4, 0, 5)) {}
  now(): number {
    return this.t;
  }
  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, Math.min(ms, 20)));
  }
}

export interface World {
  dir: string;
  db: string;
  sock: string;
  key: Buffer;
  clock: ManualClock;
  hub: Hub;
  tg: FakeAdapter;
  admin: HubAdmin;
  ownerId: string;
  secret: Buffer;
  secretB32: string;
  recovery: string[];
  logs: string[];
  code(): string;
  next(): void;
}

export const open: Array<{ close(): unknown }> = [];
afterEach(async () => {
  for (const o of open.splice(0)) await o.close();
});

function captureLogger(lines: string[]): Logger {
  const w = (lvl: string) => (msg: string, extra?: Record<string, unknown>) => lines.push(`${lvl} ${msg} ${JSON.stringify(extra ?? {})}`);
  return { debug: w("debug"), info: w("info"), warn: w("warn"), error: w("error") };
}

export async function boot(w: Pick<World, "db" | "sock" | "key" | "clock" | "logs">, tg = fakeAdapter("telegram")): Promise<{ hub: Hub; tg: FakeAdapter }> {
  const hub = await startHub({
    dbPath: w.db,
    socketPath: w.sock,
    masterKey: w.key,
    allowlist: [owner("telegram", "ada")],
    adapters: [tg],
    clock: w.clock,
    sweepIntervalMs: 0,
    quietHours: null,
    logger: captureLogger(w.logs),
  });
  open.push(hub);
  return { hub, tg };
}

export async function world(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "imw-hub-"));
  const base = { db: join(dir, "hub.sqlite"), sock: join(dir, "run", "hub.sock"), key: randomBytes(32), clock: new ManualClock(), logs: [] as string[] };
  const { hub, tg } = await boot(base);
  const admin = new HubAdmin(hub.gw.store, base.key, () => base.clock.now());
  // owner init: enrolment must be confirmed with one current code.
  const prepared = admin.prepareOwner("佳恒");
  const secret = prepared.secret;
  const r = admin.commitOwner("佳恒", prepared, totp(secret, base.clock.now()));
  base.clock.t += 30_000;
  await tg.ingest(cmd({ platform: "telegram", userId: "ada", name: "claim", args: `${r.claimCode} ${totp(secret, base.clock.now())}` }));
  await hub.gw.waitForIdle();
  base.clock.t += 30_000;
  expect(hub.gw.store.findIdentity("telegram", "bot", "ada")?.personId).toBe(r.personId);
  return {
    ...base,
    dir,
    hub,
    tg,
    admin,
    ownerId: r.personId,
    secret,
    secretB32: prepared.secretBase32,
    recovery: prepared.recoveryCodes,
    code: () => totp(secret, base.clock.now()),
    next: () => {
      base.clock.t += 30_000;
    },
  };
}

export async function client(w: World, token?: string): Promise<UnixRpcClient> {
  const c = await new UnixRpcClient(w.sock).connect();
  open.push(c);
  if (token) await c.call("a2h.auth", { token });
  return c;
}

export function addAgent(w: World, name = "codex-mac"): { agentId: string; token: string } {
  const r = w.admin.addAgent({ name, grantTo: w.ownerId, scopes: ["send", "ask", "approve", "read"], ownerProof: w.code() });
  w.next();
  return r;
}

export async function rpcError(p: Promise<unknown>): Promise<{ code: number; data?: { reason?: string; code?: string } }> {
  try {
    await p;
  } catch (e) {
    return e as { code: number; data?: { reason?: string } };
  }
  throw new Error("expected RPC error");
}

export function dump(w: World): string {
  const db = w.hub.gw.store.db;
  return [
    JSON.stringify(db.prepare("SELECT * FROM audit_log").all()),
    JSON.stringify(db.prepare("SELECT content FROM message").all()),
    JSON.stringify(db.prepare("SELECT id, name, token_hash, prev_token_hash, bind FROM agent").all()),
    w.logs.join("\n"),
  ].join("\n");
}

