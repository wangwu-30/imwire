# Pi chat in long-running `imwire serve`

`serve` can run the same `PiAgentDriver` as `hub` / `assistantPreset` while keeping
its JSON-RPC interface and optional outbox bridge. Chat configuration comes from
the process environment; no new `serve.json` fields or JSON credentials are needed.
The CLI does not load `.env` or read Keychain itself.

## Selection and defaults

| Environment | Result in `serve` |
| --- | --- |
| `IMWIRE_CHAT=off` | Chat disabled, even with keys or `IMWIRE_USE_PI=1` |
| No nonempty model key and no `IMWIRE_USE_PI=1` | Chat disabled; incoming events are only broadcast to RPC clients |
| `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, or `IMWIRE_USE_PI=1` | Pi chat enabled |
| Pi enabled as above, plus `IMWIRE_PI_PROVIDER=fake` | Local fake pi; replies contain `(offline demo)`; no model API requests |

`IMWIRE_CHAT=on` or `IMWIRE_PI_PROVIDER=fake` alone does **not** enable chat without
a key or `IMWIRE_USE_PI=1`. `IMWIRE_USE_PI=0` does not override an existing key;
use `IMWIRE_CHAT=off` to disable chat. Unlike `serve`, the assistant/hub preset
retains its existing no-key offline demo fallback.

Real pi uses `IMWIRE_PI_PROVIDER`, defaulting to `anthropic` if only
`ANTHROPIC_API_KEY` exists, otherwise `openai`. `IMWIRE_PI_MODEL` and
`IMWIRE_SYSTEM_PROMPT` are passed to the driver. The driver's existing default
model is `gpt-4o-mini`; **set a matching model explicitly for other providers**.
`IMWIRE_USE_PI=1` without credentials selects real pi and can fail on a prompt;
it never silently falls back to fake. Other pi-supported providers can be chosen
explicitly with their own environment credentials.

For an explicit offline demo, set:

```sh
export IMWIRE_CHAT=on
export IMWIRE_USE_PI=1
export IMWIRE_PI_PROVIDER=fake
```

The normal serve command is unchanged:

```sh
node packages/imwire/dist/cli.js serve --adapter telegram --adapter feishu --config ~/.imwire/serve.json
```

That command starts real IM adapters; use the offline tests below to verify this
change without consuming messages or outbox files. Startup reports `chat disabled`,
`pi chat agent (<provider>)`, or `pi chat agent (offline fake provider)` on stderr.

## Identity and persistence

With chat enabled, serve opens the same `SessionGateway` used by the existing
session layer, even when outbox is disabled. `serve.json`'s `dbPath` takes priority
over `IMWIRE_DB`, then `$IMWIRE_HOME/hub.sqlite` / `~/.imwire/hub.sqlite`.
Use the existing person/identity database for an already paired deployment.
Unknown users cannot reach pi: the session layer replies with its private-bot
notice. To bootstrap a new owner, set the existing `IMWIRE_ALLOWLIST` convention
(`platform:accountId:userId,Name`; see [INSTALL.md](../INSTALL.md#41-最小配置)).
The first allowlisted DM creates the owner; send another message to chat.

Inbound events are still broadcast to subscribed RPC clients when pi is active.
Those clients should avoid independently replying to the same messages unless
that is intentional. With chat disabled, serve retains its broadcast-only
behavior (outbox's internal gateway still uses `NoChatDriver` without handling
inbound). Shutdown waits for accepted inbound work and active turns before closing
the database. Outbox delivery logic and configuration are unchanged.

## Mac mini launchd enablement (maintainer, after merge)

Keep the existing `ai.wangwu.imwire` job, adapter credentials, serve command and
`serve.json`. Build the merged revision with `pnpm build` before the maintainer's
normal deployment. launchd does not inherit interactive-shell exports; put the
non-secret selection and credential loading in the job's existing `launch.sh`,
before its existing node/serve invocation.

The following is a **proposed Keychain naming convention**, not a claim about
existing items. In Keychain Access, the maintainer can create a generic password
with service/name `ai.wangwu.imwire` and account `OPENAI_API_KEY`, storing the model
key as the password. For Anthropic instead, use account `ANTHROPIC_API_KEY` under
the same service. Only the chosen provider's account is needed; keep all existing
Telegram/Feishu items unchanged. No model keys belong in `serve.json`, the plist,
the script source, PR text or logs.

Example fragment for OpenAI in `launch.sh` (do not run with shell tracing):

```sh
set +x
export IMWIRE_CHAT=on
export IMWIRE_USE_PI=1
export IMWIRE_PI_PROVIDER=openai
export IMWIRE_PI_MODEL=gpt-4o-mini
# Optional: export IMWIRE_SYSTEM_PROMPT='You are a helpful assistant.'
if ! OPENAI_API_KEY=$(/usr/bin/security find-generic-password \
  -s ai.wangwu.imwire -a OPENAI_API_KEY -w 2>/dev/null); then
  printf '%s\n' 'imwire: model credential unavailable' >&2
  exit 1
fi
if [ -z "$OPENAI_API_KEY" ]; then
  printf '%s\n' 'imwire: model credential empty' >&2
  exit 1
fi
export OPENAI_API_KEY
# Keep the existing node ... serve ... invocation below this fragment.
```

For Anthropic, substitute `ANTHROPIC_API_KEY` in the variable and account names,
set `IMWIRE_PI_PROVIDER=anthropic`, and set `IMWIRE_PI_MODEL` to the intended
Anthropic model ID in pi's catalog. The lookup captures the password directly into
the environment; do not echo it. Let the maintainer manage Keychain access through
the normal UI; do not unlock Keychain from the command line.

After the maintainer deploys and restarts through their normal procedure, check
stderr for the selected pi provider, then send a DM from an already linked account
and verify a model reply. To disable on a future deployment, set `IMWIRE_CHAT=off`.
No launchd edits, production restarts, Keychain reads/writes, or live IM/model tests
are required to review this PR.

## Offline verification

```sh
pnpm exec vitest run packages/imwire/tests packages/agent-pi/tests packages/session/tests
pnpm typecheck
pnpm lint
```

The serve tests use fake adapters and pi sources, temporary SQLite files, and no
production credentials. They cover disabled-chat silence, explicit fake replies
with and without outbox, RPC broadcast coexistence, unpaired users, persistence
and shutdown draining. Preset tests check real-provider selection without making
model API requests.
