import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { WebSocket } from "ws";
import type { JsonRpcMessage } from "./protocol.js";
import type { ServeHost } from "./server.js";

export interface WsServeHandle {
  url: string;
  close: () => Promise<void>;
}

export async function attachWebSocket(host: ServeHost, port: number, listenHost = "127.0.0.1"): Promise<WsServeHandle> {
  const { WebSocketServer } = await import("ws");
  const http = createServer();
  const wss = new WebSocketServer({ server: http });

  wss.on("connection", (socket: WebSocket, _req: IncomingMessage) => {
    const write = (msg: JsonRpcMessage): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const detach = host.addWriter(write);
    socket.on("message", (data) => {
      const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      void host.handleLine(text);
    });
    socket.on("close", () => detach());
  });

  await new Promise<void>((resolve) => {
    http.listen(port, listenHost, () => resolve());
  });
  const address = http.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    url: `ws://${listenHost}:${actualPort}`,
    close: async () => {
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
