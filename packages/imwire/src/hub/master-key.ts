import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface MasterKeyOptions {
  /** 0600 file holding 64 hex chars. */
  path: string;
  /** Create the key if it does not exist (owner init). Default false. */
  create?: boolean;
  /** macOS only, opt-in: use the login Keychain instead of the file. */
  keychain?: boolean;
  /** Injected for tests. */
  platform?: NodeJS.Platform;
}

const KEYCHAIN_SERVICE = "imwire-master-key";
const KEYCHAIN_ACCOUNT = "imwire";

/**
 * Load (or create) the 32-byte credential master key. The file must be
 * owned by us and not readable by group/other; otherwise we refuse to use
 * it. The key is never logged or written to the DB.
 */
export function loadMasterKey(opts: MasterKeyOptions): Buffer {
  const platform = opts.platform ?? process.platform;
  if (opts.keychain) {
    if (platform !== "darwin") throw new Error("--keychain is only supported on macOS");
    try {
      const hex = execFileSync("security", ["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return parseKey(hex);
    } catch (err) {
      if (!opts.create) throw new Error("master key not found in Keychain (run imwire owner init --keychain)");
      void err;
      const hex = randomBytes(32).toString("hex");
      // -w on argv is visible to `ps` for the lifetime of this short call; accepted trade-off, opt-in only.
      execFileSync("security", ["add-generic-password", "-U", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w", hex], {
        stdio: "ignore",
      });
      return parseKey(hex);
    }
  }
  if (existsSync(opts.path)) {
    checkPrivate(opts.path);
    return parseKey(readFileSync(opts.path, "utf8").trim());
  }
  if (!opts.create) throw new Error(`master key ${opts.path} not found (run imwire owner init)`);
  mkdirSync(dirname(opts.path), { recursive: true, mode: 0o700 });
  const hex = randomBytes(32).toString("hex");
  writeFileSync(opts.path, `${hex}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(opts.path, 0o600);
  return parseKey(hex);
}

function parseKey(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("master key is malformed");
  return Buffer.from(hex, "hex");
}

export function checkPrivate(path: string): void {
  const st = statSync(path);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`${path} is not owned by the current user`);
  }
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`${path} permissions are too open (${(st.mode & 0o777).toString(8)}); chmod 600`);
  }
}
