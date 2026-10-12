import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { onShutdownSignal } from "@imwire/core";
import { SessionStore, type A2hScope } from "@imwire/session";
import { stderrLogger } from "../logger.js";
import { HubAdmin } from "./admin.js";
import { defaultHubDir, defaultSocketPath, startHub } from "./hub.js";
import { loadMasterKey } from "./master-key.js";
import { assistantPreset } from "./preset.js";
import { redactText, redactingLogger } from "./redact.js";
import { parseDuration } from "./tokens.js";

export interface CliIo {
  out(s: string): void;
  err(s: string): void;
  /** Read one line from the terminal (TOTP / recovery code). */
  prompt(question: string): Promise<string>;
  env: Record<string, string | undefined>;
}

export const processIo: CliIo = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  prompt: async (q) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return (await rl.question(q)).trim();
    } finally {
      rl.close();
    }
  },
  env: process.env,
};

class Args {
  readonly positional: string[] = [];
  private readonly flags = new Map<string, string | true>();
  constructor(argv: string[]) {
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i]!;
      if (a.startsWith("--")) {
        const eq = a.indexOf("=");
        if (eq > 0) this.flags.set(a.slice(2, eq), a.slice(eq + 1));
        else {
          const next = argv[i + 1];
          if (next !== undefined && !next.startsWith("--")) {
            this.flags.set(a.slice(2), next);
            i += 1;
          } else this.flags.set(a.slice(2), true);
        }
      } else this.positional.push(a);
    }
  }
  str(k: string): string | undefined {
    const v = this.flags.get(k);
    return typeof v === "string" ? v : undefined;
  }
  has(k: string): boolean {
    return this.flags.has(k);
  }
}

interface Paths {
  home: string;
  db: string;
  key: string;
  socket: string;
}

function paths(a: Args, env: CliIo["env"]): Paths {
  const home = a.str("home") ?? env.IMWIRE_HOME ?? defaultHubDir();
  return {
    home,
    db: a.str("db") ?? env.IMWIRE_DB ?? join(home, "hub.sqlite"),
    key: a.str("master-key") ?? env.IMWIRE_MASTER_KEY_FILE ?? join(home, "master.key"),
    socket: a.str("socket") ?? env.IMWIRE_SOCKET ?? defaultSocketPath(home),
  };
}

function key(a: Args, p: Paths, create = false): Buffer | undefined {
  const keychain = a.has("keychain");
  if (!create && !keychain && !existsSync(p.key)) return undefined;
  return loadMasterKey({ path: p.key, create, keychain });
}

async function proof(a: Args, io: CliIo, what = "owner TOTP (or recovery code)"): Promise<string> {
  return a.str("code") ?? (await io.prompt(`${what}: `));
}

const HELP = `imwire hub    [--preset assistant] [--identity totp|legacy] [--socket PATH] [--db PATH] [--home DIR]
imwire owner  init --name NAME | enroll-totp [--person ID] | reset [--person ID] [--rotate-totp]
imwire agent  add NAME [--scopes send,ask,approve,read] [--ttl 90d] [--bind-uid UID]
              list | revoke NAME | rotate NAME [--ttl 90d] | level NAME im_account|verified
imwire audit  [--since 24h] [--cursor N] [--agent NAME] [--json]

Owner-gated commands ask for a current TOTP (or pass --code). Tokens are
printed once to stdout and only their sha256 is stored. Master key:
<home>/master.key (0600) or --keychain on macOS.`;

/** Returns the process exit code. */
export async function runHubCli(argv: string[], io: CliIo = processIo): Promise<number> {
  const [cmd, sub, ...rest] = argv;
  if (argv.includes("--help") || argv.includes("-h")) {
    io.err(HELP);
    return 0;
  }
  const a = new Args(cmd === "hub" || cmd === "audit" ? argv.slice(1) : rest);
  const p = paths(a, io.env);
  try {
    switch (cmd) {
      case "hub":
        return await cmdHub(a, p, io);
      case "owner":
        return await cmdOwner(sub, a, p, io);
      case "agent":
        return await cmdAgent(sub, a, p, io);
      case "audit":
        return cmdAudit(a, p, io);
      default:
        io.err(HELP);
        return cmd === "help" ? 0 : 1;
    }
  } catch (err) {
    io.err(`error: ${redactText(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
}

function openAdmin(a: Args, p: Paths, create = false): HubAdmin {
  const masterKey = key(a, p, create);
  return new HubAdmin(new SessionStore(p.db), masterKey);
}

async function cmdHub(a: Args, p: Paths, io: CliIo): Promise<number> {
  const identity = (a.str("identity") ?? io.env.IMWIRE_IDENTITY ?? "totp") as "totp" | "legacy";
  if (identity !== "totp" && identity !== "legacy") throw new Error("--identity must be totp or legacy");
  const preset = a.str("preset") === "assistant" || a.str("preset") === undefined ? assistantPreset(io.env) : undefined;
  if (!preset) throw new Error(`unknown preset ${a.str("preset")}`);
  const masterKey = key(a, p);
  if (identity === "totp" && !masterKey) throw new Error(`no master key at ${p.key}; run \`imwire owner init\` first (or --identity legacy)`);
  const logger = redactingLogger(stderrLogger);
  const hub = await startHub({
    dbPath: p.db,
    socketPath: p.socket,
    identityMode: identity,
    masterKey,
    allowlist: preset.allowlist,
    driver: preset.driver,
    adapters: (gw) => preset.adapters(() => gw.store),
    logger,
  });
  for (const d of preset.describe) io.err(d);
  io.err(`imwire hub: listening on ${p.socket} (identity ${identity})`);
  const ac = new AbortController();
  onShutdownSignal(() => {
    ac.abort();
    void hub.close();
  });
  await hub.run(ac.signal);
  return 0;
}

async function cmdOwner(sub: string | undefined, a: Args, p: Paths, io: CliIo): Promise<number> {
  if (sub === "init") {
    const name = a.str("name") ?? (await io.prompt("owner name: "));
    const admin = openAdmin(a, p, true);
    try {
      const prepared = admin.prepareOwner(name, a.str("account"));
      showEnrollment(io, prepared);
      const code = a.str("confirm-code") ?? (await io.prompt("type the current 6-digit code from your authenticator to confirm: "));
      const r = admin.commitOwner(name, prepared, code);
      io.out(`owner ${r.personId} created.`);
      io.out(`claim code (10 min, one use): ${r.claimCode}`);
      io.out(`DM the bot from an allowlisted account: /claim ${r.claimCode} <current TOTP>`);
      return 0;
    } finally {
      admin.store.close();
    }
  }
  if (sub === "enroll-totp") {
    const admin = openAdmin(a, p, true);
    try {
      const personId = a.str("person") ?? admin.ownerId();
      const existing = admin.store.totpCredential(personId) ? await proof(a, io, "current TOTP (or recovery code)") : undefined;
      const prepared = admin.prepareReenroll(personId, existing);
      showEnrollment(io, prepared);
      const code = a.str("confirm-code") ?? (await io.prompt("type the current code from the NEW authenticator entry: "));
      admin.commitReenroll(personId, prepared, code);
      io.out("TOTP enrolled. Old secret and recovery codes are revoked.");
      return 0;
    } finally {
      admin.store.close();
    }
  }
  if (sub === "reset") {
    const admin = openAdmin(a, p);
    try {
      const personId = a.str("person") ?? admin.ownerId();
      const r = admin.resetOwner(personId, await proof(a, io));
      io.out(`unlinked ${r.unlinked} IM account(s), cancelled ${r.cancelled} open request(s).`);
      io.out(`new claim code (10 min, one use): ${r.claimCode}`);
      if (a.has("rotate-totp")) io.out("now run: imwire owner enroll-totp");
      return 0;
    } finally {
      admin.store.close();
    }
  }
  io.err(HELP);
  return 1;
}

function showEnrollment(io: CliIo, e: { secretBase32: string; otpauthUrl: string; recoveryCodes: string[] }): void {
  // Shown once on the controlling terminal; never logged.
  io.out("Add this to your authenticator app (shown once):");
  io.out(`  secret: ${e.secretBase32}`);
  io.out(`  url:    ${e.otpauthUrl}`);
  io.out("Recovery codes (shown once, store offline):");
  for (const c of e.recoveryCodes) io.out(`  ${c}`);
}

const SCOPES: A2hScope[] = ["send", "ask", "approve", "read"];

async function cmdAgent(sub: string | undefined, a: Args, p: Paths, io: CliIo): Promise<number> {
  const admin = openAdmin(a, p);
  try {
    const name = a.positional[0];
    switch (sub) {
      case "add": {
        if (!name) throw new Error("usage: imwire agent add NAME");
        const scopes = (a.str("scopes") ?? "send,ask,approve,read").split(",").map((s) => s.trim()) as A2hScope[];
        if (scopes.some((s) => !SCOPES.includes(s))) throw new Error(`scopes: ${SCOPES.join(",")}`);
        const personId = a.str("person") ?? admin.ownerId();
        const bindUid = a.str("bind-uid");
        const r = admin.addAgent({
          name,
          grantTo: personId,
          scopes,
          ttlMs: a.str("ttl") ? parseDuration(a.str("ttl"), 0) : undefined,
          bindUid: bindUid === undefined ? undefined : Number(bindUid),
          ownerProof: await proof(a, io),
        });
        io.err(`agent ${name} (${r.agentId}) expires ${new Date(r.expiresAt).toISOString()}. Token (shown once):`);
        io.out(r.token);
        return 0;
      }
      case "rotate": {
        if (!name) throw new Error("usage: imwire agent rotate NAME");
        const r = admin.rotateAgent(name, await proof(a, io), a.str("ttl") ? parseDuration(a.str("ttl"), 0) : undefined);
        io.err(`old token valid until ${new Date(r.previousValidUntil).toISOString()}; new token (shown once):`);
        io.out(r.token);
        return 0;
      }
      case "revoke": {
        if (!name) throw new Error("usage: imwire agent revoke NAME");
        const r = admin.revokeAgent(name);
        io.out(`revoked ${name}; cancelled ${r.cancelled} open request(s).`);
        return 0;
      }
      case "level": {
        const level = a.positional[1];
        if (!name || (level !== "im_account" && level !== "verified")) throw new Error("usage: imwire agent level NAME im_account|verified");
        admin.setAgentLevel(name, level, await proof(a, io));
        io.out(`${name}: approvals need ${level === "verified" ? "TOTP" : "IM account only"}`);
        return 0;
      }
      case "list": {
        const now = Date.now();
        for (const ag of admin.listAgents()) {
          const state = ag.revokedAt ? "revoked" : ag.expiresAt !== undefined && ag.expiresAt <= now ? "expired" : "active";
          io.out(
            [ag.name, ag.id, state, ag.expiresAt ? new Date(ag.expiresAt).toISOString() : "-", ag.approvalLevel ?? "verified", ag.bind ?? "-"].join("\t"),
          );
        }
        return 0;
      }
      default:
        io.err(HELP);
        return 1;
    }
  } finally {
    admin.store.close();
  }
}

function cmdAudit(a: Args, p: Paths, io: CliIo): number {
  const store = new SessionStore(p.db);
  try {
    let agentId: string | undefined;
    if (a.str("agent")) agentId = (store.agentByName(a.str("agent")!) ?? store.getAgent(a.str("agent")!))?.id ?? "-";
    const since = a.str("since") ? Date.now() - parseDuration(a.str("since"), 0) : 0;
    let cursor = Number(a.str("cursor") ?? 0);
    for (;;) {
      const batch = store.eventsAfter(cursor, { agentId, limit: 500 });
      if (batch.length === 0) break;
      for (const e of batch) {
        cursor = e.id;
        if (e.at < since) continue;
        if (a.has("json")) io.out(redactText(JSON.stringify(e)));
        else
          io.out(
            redactText(
              [e.id, new Date(e.at).toISOString(), e.action, e.decision, e.agentId ?? "-", e.personId ?? "-", e.requestId ?? "-", e.object ?? "-", e.bindingHash ?? "-"].join("\t"),
            ),
          );
      }
    }
    return 0;
  } finally {
    store.close();
  }
}
