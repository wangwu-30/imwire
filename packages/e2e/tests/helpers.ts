import { FeishuAdapter } from "@imwire/feishu";
import { TelegramAdapter } from "@imwire/telegram";
import { SessionGateway, ScriptedDriver, type AgentDriver, type OwnerAllowlistEntry } from "@imwire/session";
import { startFeishuMock, type FeishuMock } from "./mocks/feishu.js";
import { startTelegramMock, type TelegramMock } from "./mocks/telegram.js";

export const PAIR_CODE_RE = /\b(\d{8})\b/;

export function extractPairCode(...texts: string[]): string | undefined {
  let found: string | undefined;
  for (const t of texts) {
    const matches = t.match(new RegExp(PAIR_CODE_RE.source, "g"));
    if (matches) found = matches.at(-1);
  }
  return found;
}

export async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let seq = 1;

export function tgMessage(opts: { userId?: number; text: string; chatId?: number }): unknown {
  seq += 1;
  const id = opts.userId ?? 111;
  return {
    update_id: 1000 + seq,
    message: {
      message_id: seq,
      from: { id, is_bot: false, first_name: "Ada" },
      chat: { id: opts.chatId ?? id, type: "private" },
      date: 1710000000,
      text: opts.text,
    },
  };
}

export function tgCallback(opts: { userId?: number; data: string; messageId?: number }): unknown {
  seq += 1;
  const id = opts.userId ?? 111;
  return {
    update_id: 1000 + seq,
    callback_query: {
      id: `cb${seq}`,
      from: { id, is_bot: false, first_name: "Ada" },
      message: {
        message_id: opts.messageId ?? seq,
        chat: { id, type: "private" },
      },
      data: opts.data,
    },
  };
}

export function fsMessage(opts: { userId?: string; chatId?: string; text: string }): unknown {
  seq += 1;
  return {
    schema: "2.0",
    header: {
      event_id: `evt_${seq}`,
      event_type: "im.message.receive_v1",
      create_time: String(Date.now()),
    },
    event: {
      sender: {
        sender_id: { open_id: opts.userId ?? "ou_ada" },
        sender_type: "user",
      },
      message: {
        message_id: `om_in_${seq}`,
        chat_id: opts.chatId ?? "oc_dm_1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: opts.text }),
      },
    },
  };
}

export function fsAction(opts: { userId?: string; chatId?: string; actionId: string; value?: string }): unknown {
  seq += 1;
  return {
    schema: "2.0",
    header: {
      event_id: `act_${seq}`,
      event_type: "card.action.trigger",
      create_time: String(Date.now()),
    },
    event: {
      operator: { open_id: opts.userId ?? "ou_ada" },
      action: {
        value: { actionId: opts.actionId, value: opts.value },
        tag: "button",
      },
      context: {
        open_message_id: `om_card_${seq}`,
        open_chat_id: opts.chatId ?? "oc_dm_1",
      },
    },
  };
}

export const owner: OwnerAllowlistEntry = {
  platform: "telegram",
  accountId: "telegram",
  userId: "111",
  name: "Owner",
};

export function noopRealtime() {
  return { start: async () => undefined, isAlive: () => false, stop() {} };
}

export async function openPlatformSession(opts?: {
  driver?: AgentDriver;
  approvalTimeoutMs?: number;
}): Promise<{
  gw: SessionGateway;
  driver: ScriptedDriver;
  tg: TelegramAdapter;
  fs: FeishuAdapter;
  tgMock: TelegramMock;
  fsMock: FeishuMock;
  close: () => Promise<void>;
}> {
  const tgMock = await startTelegramMock();
  const fsMock = await startFeishuMock();
  const driver = opts?.driver instanceof ScriptedDriver ? opts.driver : new ScriptedDriver();
  const gw = new SessionGateway({
    dbPath: ":memory:",
    driver: opts?.driver ?? driver,
    allowlist: [owner],
    approvalTimeoutMs: opts?.approvalTimeoutMs,
  });
  const tg = new TelegramAdapter({
    token: tgMock.token,
    accountId: "telegram",
    baseUrl: tgMock.url,
    draftThrottleMs: 0,
  });
  const fs = new FeishuAdapter({
    appId: "cli_e2e",
    appSecret: "secret",
    accountId: "cli_e2e",
    apiBase: fsMock.url,
    realtime: noopRealtime(),
    draftThrottleMs: 0,
  });
  gw.attach(tg);
  gw.attach(fs);
  return {
    gw,
    driver,
    tg,
    fs,
    tgMock,
    fsMock,
    close: async () => {
      gw.close();
      await Promise.all([tgMock.close(), fsMock.close()]);
    },
  };
}

export async function bootstrapAndPair(
  tg: TelegramAdapter,
  fs: FeishuAdapter,
  tgMock: TelegramMock,
): Promise<string> {
  await tg.ingest(tgMessage({ text: "hello" }));
  await tg.ingest(tgMessage({ text: "/pair" }));
  await waitFor(() => Boolean(extractPairCode(...tgMock.texts())));
  const code = extractPairCode(...tgMock.texts());
  if (!code) throw new Error("no pairing code");
  await fs.ingest(fsMessage({ text: code }));
  return code;
}
