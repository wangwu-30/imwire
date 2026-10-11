import { sendJson, listenJson, type JsonServer, type MockRequest } from "./http.js";

export interface SlackMock extends JsonServer {
  texts: () => string[];
}

export async function startSlackMock(): Promise<SlackMock> {
  let seq = 0;
  const server = await listenJson((req, res) => {
    const method = req.path.replace(/^\//, "");
    if (method === "auth.test") {
      sendJson(res, { ok: true, user_id: "U_BOT" });
      return;
    }
    if (method === "chat.postMessage") {
      seq += 1;
      sendJson(res, { ok: true, ts: `1710000000.${String(seq).padStart(6, "0")}` });
      return;
    }
    if (method === "chat.update" || method === "chat.delete" || method === "reactions.add") {
      sendJson(res, { ok: true });
      return;
    }
    sendJson(res, { ok: true });
  });
  return {
    ...server,
    texts: () => collectSlackTexts(server.requests),
  };
}

function collectSlackTexts(requests: MockRequest[]): string[] {
  const out: string[] = [];
  for (const req of requests) {
    const body = asRecord(req.body);
    const text = asString(body?.text);
    if (text) out.push(text);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
