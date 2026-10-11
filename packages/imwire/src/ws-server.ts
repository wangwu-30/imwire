import { timingSafeEqual, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { WebSocket } from "ws";
import type { JsonRpcMessage } from "./protocol.js";
import type { ServeHost } from "./server.js";

export const WS_MAX_PAYLOAD = 1_048_576;

export interface WsServeHandle {
  url: string;
  token: string;
  close: () => Promise<void>;
}

export interface WsAttachOptions {
  port: number;
  host?: string;
  token?: string;
  allowRemote?: boolean;
  maxPayload?: number;
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "[::1]";
}

export function generateWsToken(): string {
  return randomBytes(24).toString("base64url");
}

export function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function tokenFromRequest(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return undefined;
}

export async function attachWebSocket(
  host: ServeHost,
  portOrOpts: number | WsAttachOptions,
  listenHost?: string,
): Promise<WsServeHandle> {
  const opts: WsAttachOptions =
    typeof portOrOpts === "number" ? { port: portOrOpts, host: listenHost ?? "127.0.0.1" } : portOrOpts;
  const bindHost = opts.host ?? "127.0.0.1";
  const token = opts.token ?? generateWsToken();
  if (!isLoopbackHost(bindHost) && !opts.allowRemote) {
    throw new Error("refusing non-loopback --ws-host without --ws-allow-remote");
  }
  if (!isLoopbackHost(bindHost) && !token) {
    throw new Error("refusing non-loopback --ws-host without a WS token");
  }

  const { WebSocketServer } = await import("ws");
  const http = createServer();
  const wss = new WebSocketServer({
    server: http,
    maxPayload: opts.maxPayload ?? WS_MAX_PAYLOAD,
    verifyClient: (info: { req: IncomingMessage; origin?: string }) => {
      if (info.origin || info.req.headers.origin) return false;
      const presented = tokenFromRequest(info.req);
      return Boolean(presented && tokensEqual(presented, token));
    },
  });

  wss.on("connection", (socket: WebSocket, _req: IncomingMessage) => {
    socket.on("error", () => undefined);
    const write = (msg: JsonRpcMessage): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const detach = host.addWriter(write, { subscribe: false });
    socket.on("message", (data) => {
      const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      void host.handleLine(text, write);
    });
    socket.on("close", () => detach());
  });

  await new Promise<void>((resolve) => {
    http.listen(opts.port, bindHost, () => resolve());
  });
  const address = http.address();
  const actualPort = typeof address === "object" && address ? address.port : opts.port;
  return {
    url: `ws://${bindHost}:${actualPort}`,
    token,
    close: async () => {
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
