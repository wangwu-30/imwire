/**
 * The assistant is now a preset of `imwire hub` (Telegram + Feishu from env,
 * optional pi chat agent, a2h socket for local agents).
 *
 * Compat: this entry point defaults to `--identity legacy` and the old DB
 * path (./imwire.sqlite) so an existing deployment behaves exactly as before
 * (no master key → v1 approver check). Set IMWIRE_IDENTITY=totp after
 * `imwire owner init` to require TOTP for agent approvals.
 */
import { runHubCli, parseAllowlist } from "imwire";

export { parseAllowlist };

function installProcessSafety(): void {
  process.on("unhandledRejection", (err) => {
    console.error("unhandledRejection", err);
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    console.error("uncaughtException", err);
    process.exit(1);
  });
}

const env = (k: string) => (process.env[k] && process.env[k]!.length > 0 ? process.env[k] : undefined);

async function main(): Promise<void> {
  installProcessSafety();
  const telegram = env("TELEGRAM_BOT_TOKEN") ?? env("IMWIRE_TELEGRAM_BOT_TOKEN");
  if (!telegram && !(env("FEISHU_APP_ID") && env("FEISHU_APP_SECRET"))) {
    console.error(`imwire assistant (imwire hub --preset assistant)

Set env vars (see .env.example):

  TELEGRAM_BOT_TOKEN / IMWIRE_TELEGRAM_BOT_TOKEN
  FEISHU_APP_ID + FEISHU_APP_SECRET
  IMWIRE_ALLOWLIST          platform:accountId:userId[,Name]  (comma or semicolon)
  IMWIRE_DB                 sqlite path (default ./imwire.sqlite)
  IMWIRE_USE_PI=1           + OPENAI_API_KEY or ANTHROPIC_API_KEY
  IMWIRE_IDENTITY           legacy (default here) | totp
`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runHubCli([
    "hub",
    "--preset",
    "assistant",
    "--identity",
    env("IMWIRE_IDENTITY") ?? "legacy",
    "--db",
    env("IMWIRE_DB") ?? "./imwire.sqlite",
    ...process.argv.slice(2),
  ]);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
