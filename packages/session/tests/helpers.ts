import { FakeAdapter } from "@imwire/core/testing";
import type { Capabilities, ChatRef, Inbound, UserRef } from "@imwire/core";
import { SessionGateway } from "../src/gateway.js";
import { ScriptedDriver } from "../src/scripted-driver.js";
import type { AgentDriver, OwnerAllowlistEntry } from "../src/types.js";

export const caps: Capabilities = {
  streaming: "edit",
  streamingCard: false,
  edit: true,
  editScope: "any",
  proactiveSend: true,
  delete: true,
  buttons: true,
  reactions: true,
  threads: true,
  typing: true,
  media: { image: false, file: false },
  maxTextLength: 4096,
  markdown: "none",
};

export function fakeAdapter(platform: string, accountId = "bot"): FakeAdapter {
  return new FakeAdapter({ platform, accountId, capabilities: caps });
}

export function chat(platform: string, chatId: string, kind: "dm" | "group" = "dm", accountId = "bot"): ChatRef {
  return { platform, accountId, chatId, kind };
}

export function user(platform: string, userId: string, accountId = "bot"): UserRef {
  return { platform, accountId, userId, displayName: userId };
}

let seq = 1;
export function dm(opts: {
  platform: string;
  userId: string;
  text: string;
  chatId?: string;
  accountId?: string;
}): Inbound {
  const accountId = opts.accountId ?? "bot";
  const c = chat(opts.platform, opts.chatId ?? opts.userId, "dm", accountId);
  seq += 1;
  return {
    type: "message",
    id: `e${seq}`,
    ts: Date.now(),
    chat: c,
    from: user(opts.platform, opts.userId, accountId),
    messageId: `m${seq}`,
    text: opts.text,
    mentionsBot: true,
  };
}

export function cmd(opts: {
  platform: string;
  userId: string;
  name: string;
  args?: string;
  chatId?: string;
  kind?: "dm" | "group";
}): Inbound {
  const c = chat(opts.platform, opts.chatId ?? opts.userId, opts.kind ?? "dm");
  seq += 1;
  return {
    type: "command",
    id: `e${seq}`,
    ts: Date.now(),
    chat: c,
    from: user(opts.platform, opts.userId),
    messageId: `m${seq}`,
    name: opts.name,
    args: opts.args ?? "",
  };
}

export function groupMsg(opts: {
  platform: string;
  chatId: string;
  userId: string;
  text: string;
  mentionsBot?: boolean;
}): Inbound {
  seq += 1;
  return {
    type: "message",
    id: `e${seq}`,
    ts: Date.now(),
    chat: chat(opts.platform, opts.chatId, "group"),
    from: user(opts.platform, opts.userId),
    messageId: `m${seq}`,
    text: opts.text,
    mentionsBot: opts.mentionsBot ?? true,
  };
}

export function action(opts: { platform: string; userId: string; actionId: string; value?: string; chatId?: string; messageId?: string }): Inbound {
  seq += 1;
  const c = chat(opts.platform, opts.chatId ?? opts.userId);
  return {
    type: "action",
    id: `e${seq}`,
    ts: Date.now(),
    target: { chat: c, messageId: opts.messageId ?? `m${seq}` },
    from: user(opts.platform, opts.userId),
    actionId: opts.actionId,
    value: opts.value,
  };
}

export function markdownCalls(adapter: FakeAdapter): string[] {
  const out: string[] = [];
  for (const c of adapter.calls) {
    const args = c.args as { msg?: { blocks?: Array<{ kind: string; text?: string }> }; text?: string; note?: string };
    if (typeof args.note === "string") out.push(args.note);
    if (typeof args.text === "string") out.push(args.text);
    const blocks = args.msg?.blocks ?? [];
    const t = blocks.filter((b) => b.kind === "markdown").map((b) => b.text ?? "").join("\n");
    if (t) out.push(t);
  }
  return out;
}

export async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

export function lastApprovalId(adapter: FakeAdapter): string | undefined {
  for (let i = adapter.calls.length - 1; i >= 0; i -= 1) {
    const args = adapter.calls[i]?.args as { msg?: { blocks?: Array<{ kind: string; buttons?: Array<{ value?: string }> }> } };
    const buttons = args.msg?.blocks?.find((b) => b.kind === "buttons")?.buttons;
    const value = buttons?.[0]?.value;
    if (value) return value;
  }
  return undefined;
}

export function owner(platform: string, userId: string): OwnerAllowlistEntry {
  return { platform, accountId: "bot", userId, name: "Owner" };
}

export function openGateway(opts?: { driver?: AgentDriver; dbPath?: string; allowlist?: OwnerAllowlistEntry[] }): {
  gw: SessionGateway;
  driver: ScriptedDriver;
  tg: FakeAdapter;
  fs: FakeAdapter;
} {
  const driver = opts?.driver instanceof ScriptedDriver ? opts.driver : new ScriptedDriver();
  const gw = new SessionGateway({
    dbPath: opts?.dbPath ?? ":memory:",
    driver: opts?.driver ?? driver,
    allowlist: opts?.allowlist ?? [owner("telegram", "ada")],
  });
  const tg = fakeAdapter("telegram");
  const fs = fakeAdapter("feishu");
  gw.attach(tg);
  gw.attach(fs);
  return { gw, driver, tg, fs };
}
