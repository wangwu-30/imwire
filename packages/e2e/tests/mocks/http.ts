import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

export interface MockRequest {
  method: string;
  url: string;
  path: string;
  body: unknown;
  raw: string;
  at: number;
}

export interface JsonServer {
  url: string;
  port: number;
  requests: MockRequest[];
  close: () => Promise<void>;
}

export async function listenJson(
  handler: (req: MockRequest, res: ServerResponse) => void | Promise<void>,
): Promise<JsonServer> {
  const requests: MockRequest[] = [];
  const server = createServer((req, res) => {
    void handle(req, res, requests, handler);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("expected TCP address");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  requests: MockRequest[],
  handler: (req: MockRequest, res: ServerResponse) => void | Promise<void>,
): Promise<void> {
  const raw = await readBody(req);
  let body: unknown = undefined;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  const url = req.url ?? "/";
  const recorded: MockRequest = {
    method: (req.method ?? "GET").toUpperCase(),
    url,
    path: url.split("?")[0] ?? "/",
    body,
    raw,
    at: Date.now(),
  };
  requests.push(recorded);
  try {
    await handler(recorded, res);
    if (!res.writableEnded) sendJson(res, {});
  } catch (err) {
    if (!res.writableEnded) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
