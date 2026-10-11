import { sendJson, listenJson, type JsonServer, type MockRequest } from "./http.js";

export interface FeishuMock extends JsonServer {
  texts: () => string[];
  lastApprovalId: () => string | undefined;
}

export async function startFeishuMock(): Promise<FeishuMock> {
  let seq = 0;
  const server = await listenJson((req, res) => {
    if (req.path.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
      sendJson(res, { code: 0, tenant_access_token: "t-e2e", expire: 7200 });
      return;
    }
    if (req.path.endsWith("/open-apis/bot/v3/info")) {
      sendJson(res, { code: 0, data: { bot: { open_id: "ou_bot" } } });
      return;
    }
    if (req.method === "POST" && req.path === "/open-apis/cardkit/v1/cards") {
      seq += 1;
      sendJson(res, { code: 0, data: { card_id: `card-${seq}` } });
      return;
    }
    if (req.method === "POST" && (req.path === "/open-apis/im/v1/messages" || req.path.includes("/reply"))) {
      seq += 1;
      sendJson(res, { code: 0, data: { message_id: `om-${seq}` } });
      return;
    }
    if (req.path.includes("/open-apis/im/v1/chats/")) {
      sendJson(res, { code: 0, data: { chat_mode: "p2p" } });
      return;
    }
    sendJson(res, { code: 0, data: {} });
  });

  return {
    ...server,
    texts: () => collectFeishuTexts(server.requests),
    lastApprovalId: () => lastFeishuApproval(server.requests),
  };
}

function collectFeishuTexts(requests: MockRequest[]): string[] {
  const out: string[] = [];
  for (const req of requests) {
    const body = asRecord(req.body);
    if (!body) continue;
    if (typeof body.content === "string") {
      out.push(...textsFromCard(body.content));
    }
    if (typeof body.content === "string" && !body.content.startsWith("{")) {
      out.push(body.content);
    }
    if (typeof body.data === "string") {
      out.push(...textsFromCard(body.data));
    }
    if (typeof body.elements === "string") {
      out.push(...textsFromCard(body.elements));
    }
  }
  return out;
}

function textsFromCard(raw: string): string[] {
  const parsed = safeJson(raw);
  if (!parsed) return raw.length > 0 && !raw.startsWith("{") ? [raw] : [];
  const out: string[] = [];
  walk(parsed, out);
  return out;
}

function walk(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value && value !== "card" && !value.startsWith("card-")) out.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, out);
    return;
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.content === "string") out.push(rec.content);
  if (typeof rec.text === "string") out.push(rec.text);
  for (const v of Object.values(rec)) {
    if (v && typeof v === "object") walk(v, out);
  }
}

function lastFeishuApproval(requests: MockRequest[]): string | undefined {
  for (let i = requests.length - 1; i >= 0; i -= 1) {
    const found = findApproval(requests[i]?.body);
    if (found) return found;
  }
  return undefined;
}

function findApproval(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    const parsed = safeJson(value);
    return parsed ? findApproval(parsed) : undefined;
  }
  if (typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findApproval(item);
      if (found) return found;
    }
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  const inner = asRecord(rec.value);
  if (asString(inner?.actionId) && asString(inner?.value)) return asString(inner?.value);
  for (const v of Object.values(rec)) {
    const found = findApproval(v);
    if (found) return found;
  }
  return undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
