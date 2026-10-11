import type { Logger } from "@imwire/core";

function line(level: string, msg: string, extra?: Record<string, unknown>): string {
  const rest = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(redact(extra))}` : "";
  return `[imwire ${level}] ${msg}${rest}\n`;
}

function redact(extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) {
    const key = k.toLowerCase();
    if (key.includes("token") || key.includes("secret") || key.includes("password")) {
      out[k] = "[redacted]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** All serve / adapter logs go to stderr so stdout stays JSON-RPC. */
export const stderrLogger: Logger = {
  debug(msg, extra) {
    process.stderr.write(line("debug", msg, extra));
  },
  info(msg, extra) {
    process.stderr.write(line("info", msg, extra));
  },
  warn(msg, extra) {
    process.stderr.write(line("warn", msg, extra));
  },
  error(msg, extra) {
    process.stderr.write(line("error", msg, extra));
  },
};

export function sdkStderrLogger(): {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
} {
  const write = (level: string, args: unknown[]): void => {
    process.stderr.write(`[${level}]: ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
  };
  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
    trace: (...args) => write("trace", args),
  };
}
