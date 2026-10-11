import { sendJson, listenJson, type JsonServer, type MockRequest } from "./http.js";

export interface DingTalkMock extends JsonServer {
  streamContents: () => string[];
  texts: () => string[];
  delivered: () => { contents: string[]; lastButtonIds: string[] };
}

export async function startDingTalkMock(): Promise<DingTalkMock> {
  const server = await listenJson((req, res) => {
    if (req.path === "/v1.0/oauth2/accessToken") {
      sendJson(res, { accessToken: "dt-e2e", expireIn: 7200 });
      return;
    }
    sendJson(res, { errcode: 0 });
  });
  return {
    ...server,
    streamContents: () =>
      server.requests
        .filter((r) => r.path === "/v1.0/card/streaming")
        .map((r) => asString(asRecord(r.body)?.content))
        .filter((s): s is string => Boolean(s)),
    texts: () => collectDingTalkTexts(server.requests),
    delivered: () => collectDingTalkDelivered(server.requests),
  };
}

function collectDingTalkTexts(requests: MockRequest[]): string[] {
  const out: string[] = [];
  for (const req of requests) {
    const body = asRecord(req.body);
    if (!body) continue;
    const content = asString(body.content);
    if (content) out.push(content);
    const map = asRecord(asRecord(body.cardData)?.cardParamMap);
    const mapped = asString(map?.content);
    if (mapped) out.push(mapped);
    const param = asString(body.msgParam);
    if (param) {
      try {
        const parsed = JSON.parse(param) as { text?: string };
        if (parsed.text) out.push(parsed.text);
      } catch {
        out.push(param);
      }
    }
  }
  return out;
}

function collectDingTalkDelivered(requests: MockRequest[]): { contents: string[]; lastButtonIds: string[] } {
  const contents: string[] = [];
  let lastButtonIds: string[] = [];
  for (const req of requests) {
    const body = asRecord(req.body);
    if (!body) continue;
    const content = asString(body.content);
    if (content) contents.push(content);
    const map = asRecord(asRecord(body.cardData)?.cardParamMap);
    const mapped = asString(map?.content);
    if (mapped) contents.push(mapped);
    const rawButtons = asString(map?.buttons);
    if (rawButtons) {
      try {
        const parsed = JSON.parse(rawButtons) as Array<{ id?: string }>;
        const ids = parsed.map((b) => b.id).filter((id): id is string => Boolean(id));
        if (ids.length > 0) lastButtonIds = ids;
      } catch {
        // ignore malformed button JSON
      }
    }
    const param = asString(body.msgParam);
    if (param) {
      try {
        const parsed = JSON.parse(param) as { text?: string };
        if (parsed.text) contents.push(parsed.text);
      } catch {
        contents.push(param);
      }
    }
  }
  return { contents, lastButtonIds };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
