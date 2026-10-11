import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createSdkRealtime } from "../src/realtime.js";

const APP_ID = "cli_0123456789abcdef";
const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, trace: () => undefined };

describe("Feishu realtime options (mock SDK)", () => {
  function fakeSdk() {
    const made: Array<{ opts: Record<string, unknown>; closes: unknown[] }> = [];
    class WSClient {
      closes: unknown[] = [];
      constructor(opts: Record<string, unknown>) {
        made.push({ opts, closes: this.closes });
      }
      start() {
        return Promise.resolve();
      }
      close(params?: unknown) {
        this.closes.push(params);
      }
      getConnectionStatus() {
        return { state: "connected" };
      }
    }
    class EventDispatcher {
      register() {
        return this;
      }
    }
    return { made, loadSdk: async () => ({ WSClient, EventDispatcher, Domain: { Feishu: "https://open.feishu.cn" }, LoggerLevel: { warn: 2 } }) };
  }

  it("turns on the SDK liveness watchdog and handshake timeout by default", async () => {
    const sdk = fakeSdk();
    const rt = await createSdkRealtime({ appId: APP_ID, appSecret: "s", logger: quiet, loadSdk: sdk.loadSdk });
    const ac = new AbortController();
    const run = rt.start({ onEvent: async () => undefined }, ac.signal);
    await new Promise((r) => setTimeout(r, 10));
    expect(sdk.made[0]!.opts.wsConfig).toEqual({ pingTimeout: 30 });
    expect(sdk.made[0]!.opts.handshakeTimeoutMs).toBe(15_000);
    expect(typeof sdk.made[0]!.opts.onReconnecting).toBe("function");
    ac.abort();
    await run;
    // force-close: a polite close() waits for a close frame that a dead link never delivers
    expect(sdk.made[0]!.closes).toContainEqual({ force: true });
  });

  it("pingTimeoutSec: 0 leaves the watchdog off", async () => {
    const sdk = fakeSdk();
    const rt = await createSdkRealtime({ appId: APP_ID, appSecret: "s", logger: quiet, loadSdk: sdk.loadSdk, pingTimeoutSec: 0 });
    const ac = new AbortController();
    const run = rt.start({ onEvent: async () => undefined }, ac.signal);
    await new Promise((r) => setTimeout(r, 10));
    expect(sdk.made[0]!.opts.wsConfig).toBeUndefined();
    ac.abort();
    await run;
  });
});

/**
 * A fake Feishu gateway whose WebSocket accepts the handshake and then goes
 * silent — no pong, no close, no FIN — like a dead upstream behind a TUN proxy
 * where the local TCP leg stays ESTABLISHED.
 */
function blackHoleGateway(): Promise<{ url: string; upgrades: () => number; open: () => number; resume: () => void; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  let upgrades = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const addr = server.address() as { port: number };
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          code: 0,
          data: {
            URL: `ws://127.0.0.1:${addr.port}/ws?device_id=d1&service_id=1`,
            ClientConfig: { PingInterval: 1, ReconnectCount: -1, ReconnectInterval: 1, ReconnectNonce: 0 },
          },
        }),
      );
    });
  });
  server.on("upgrade", (req, socket: Socket) => {
    upgrades += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("end", () => {
      sockets.delete(socket);
      socket.destroy();
    });
    socket.on("error", () => undefined);
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.pause(); // black hole: read nothing, answer nothing
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        upgrades: () => upgrades,
        open: () => sockets.size,
        // Let the server observe what the client did (FIN vs. a pending close handshake).
        resume: () => {
          for (const s of sockets) s.resume();
        },
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

describe("Feishu realtime against a silent link (real SDK, local fake gateway)", () => {
  let gw: Awaited<ReturnType<typeof blackHoleGateway>> | undefined;
  afterEach(async () => {
    await gw?.close();
    gw = undefined;
  });

  it("detects the dead socket and reconnects; abort tears the socket down at once", async () => {
    gw = await blackHoleGateway();
    const rt = await createSdkRealtime({
      appId: APP_ID,
      appSecret: "s",
      logger: quiet,
      loggerLevel: 0,
      wsDomain: gw.url,
      pingTimeoutSec: 0.3,
    });
    const ac = new AbortController();
    const run = rt.start({ onEvent: async () => undefined }, ac.signal);
    expect(await waitFor(() => gw!.upgrades() >= 1, 3_000)).toBe(true);
    // ping at ~1 s gets no answer → watchdog terminates → SDK reconnects
    expect(await waitFor(() => gw!.upgrades() >= 2, 4_000)).toBe(true);

    const t0 = Date.now();
    ac.abort();
    await run;
    gw.resume();
    // force-terminated: FIN arrives at once instead of after ws's 30 s close timeout
    expect(await waitFor(() => gw!.open() === 0, 1_000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1_000);
  }, 15_000);

  it("without the watchdog the SDK never notices (the original bug)", async () => {
    gw = await blackHoleGateway();
    const rt = await createSdkRealtime({
      appId: APP_ID,
      appSecret: "s",
      logger: quiet,
      loggerLevel: 0,
      wsDomain: gw.url,
      pingTimeoutSec: 0,
    });
    const ac = new AbortController();
    const run = rt.start({ onEvent: async () => undefined }, ac.signal);
    expect(await waitFor(() => gw!.upgrades() >= 1, 3_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(gw.upgrades()).toBe(1);
    expect(rt.isAlive()).toBe(true); // still reports "connected"
    ac.abort();
    await run;
  }, 15_000);
});
