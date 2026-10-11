import { WebSocketServer, type WebSocket } from "ws";
import { once } from "node:events";

export interface WecomFrame {
  cmd?: string;
  headers?: { req_id?: string };
  body?: unknown;
  errcode?: number;
}

export interface WecomMock {
  url: string;
  frames: WecomFrame[];
  streamContents: () => string[];
  close: () => Promise<void>;
}

export async function startWecomMock(): Promise<WecomMock> {
  const frames: WecomFrame[] = [];
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const addr = wss.address();
  if (!addr || typeof addr === "string") throw new Error("expected TCP address");

  wss.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw) => {
      let frame: WecomFrame;
      try {
        frame = JSON.parse(String(raw)) as WecomFrame;
      } catch {
        return;
      }
      frames.push(frame);
      const reqId = frame.headers?.req_id;
      if (!reqId) return;
      socket.send(JSON.stringify({ errcode: 0, headers: { req_id: reqId } }));
    });
  });

  return {
    url: `ws://127.0.0.1:${addr.port}`,
    frames,
    streamContents: () => {
      const out: string[] = [];
      for (const frame of frames) {
        const body = frame.body && typeof frame.body === "object" ? (frame.body as Record<string, unknown>) : undefined;
        const stream = body?.stream && typeof body.stream === "object" ? (body.stream as Record<string, unknown>) : undefined;
        if (typeof stream?.content === "string") out.push(stream.content);
        const md = body?.markdown && typeof body.markdown === "object" ? (body.markdown as Record<string, unknown>) : undefined;
        if (typeof md?.content === "string") out.push(md.content);
      }
      return out;
    },
    close: () =>
      new Promise((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
