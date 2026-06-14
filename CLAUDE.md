# Zalo Claude Plugin — Agent Context

## What this is

An MCP plugin (stdio transport) that bridges Zalo personal-account messaging into Claude Code.
**Two processes, one DB.** A single always-on **daemon** (`src/daemon.ts`) owns the Zalo
WebSocket and a SQLite log (`messages.db`); each Claude session runs a thin **proxy**
(`src/proxy.ts`, launched by `server.ts`) that talks to the daemon *only through the shared
SQLite DB* (no socket). The daemon gates + writes every inbound message to SQLite; a live proxy
atomically claims the messages that should be answered, enriches them with prior context, and
delivers them as `notifications/claude/channel` events (rendered as `<channel source="zalo"
...>`). Claude replies with the `reply` tool → an `outbound` queue row → the daemon sends it.
Replies go out under the user's own personal account — this is not a bot.

Only DMs and group @mentions wake the LLM; unmentioned group messages are logged to SQLite
silently (no notification). The daemon is spawn-on-demand (a detached background process the
first session launches; no scheduled task, no console window, nothing installed on the system),
so opening/closing sessions never drops the connection, and N sessions coexist with exactly one
answering each message (atomic row-claim).

Access control is pairing-code based: strangers get a code, the user approves with
`/zalo:access pair <code>` — all state in `~/.claude/channels/zalo/access.json` (account-global),
managed by skills editing JSON directly (no MCP tools mutate access).

## Distribution

Distributed as a Claude Code plugin via the `imrim12` marketplace (also published to npm as
`claude-plugin-zalo`). The plugin's `.mcp.json` launches the server from the plugin's own
installed checkout — `bun run --cwd ${CLAUDE_PLUGIN_ROOT} --shell=bun --silent start` (the same
run model as the official Telegram channel plugin). `${CLAUDE_PLUGIN_ROOT}` is the plugin's
install dir (the marketplace cache for an installed plugin, or the repo root under
`--plugin-dir`); Claude Code installs plugin deps into that dir at install time, so the cached
checkout has its own `node_modules`. `--silent` is mandatory: without it `bun run` prints
`$ bun server.ts` to stdout and corrupts the MCP transport. `--shell=bun` keeps the `start`
script cross-platform on Windows. The `start` script is `bun server.ts` (which launches the proxy); `bin` is also
`./server.ts` for the npm/`bunx` path. Both proxy and daemon are cwd-independent (all state
resolves from `homedir()`), so `--cwd ${CLAUDE_PLUGIN_ROOT}` only anchors `bun run` to the right
`package.json`. `.npmignore` keeps the tarball to `src/`, `server.ts`, `skills/`, `hooks/`,
`.claude-plugin/`, `.mcp.json`, `README.md`, `LICENSE`, `package.json` — dev tooling
(`.agents/`, `.claude/`, `tests/`, configs, lockfiles, `CLAUDE.md`) is excluded. The optional
PostToolUse hook is loaded automatically from the standard `hooks/hooks.json` path — do NOT add a
`"hooks"` key to `plugin.json` (Claude Code auto-loads the standard file, so a manifest reference
double-loads it and fails with a "Duplicate hooks file detected" error). Keep `package.json`
and `.claude-plugin/plugin.json` versions in lockstep when publishing.

## Local development (running against this repo)

To run the channel from the working tree instead of the installed `zalo@imrim12`, launch Claude
Code from the repo with `--plugin-dir .`:

```
claude --plugin-dir . --dangerously-load-development-channels plugin:zalo
```

`--plugin-dir .` loads this repo as a plugin named `zalo` and **shadows the installed
`zalo@imrim12` for that session** (same name → local wins), so only one instance runs — no
fight over the single Zalo account/listener slot. Because `.mcp.json` runs
`${CLAUDE_PLUGIN_ROOT}/start` and `CLAUDE_PLUGIN_ROOT` is now the repo, this executes the live
local `server.ts`. Note the channel ref is **`plugin:zalo`** (no `@imrim12` suffix) — a
`--plugin-dir` plugin has no marketplace. In other projects, omit `--plugin-dir` and the
installed `zalo@imrim12` runs its cached stock copy as usual.

The repo's `.mcp.json` is ALSO auto-discovered by Claude Code as a project-scoped MCP server
named `zalo` — but a project server is not a plugin and can never deliver channel
notifications (inbound is plugin-gated), and it would collide with the `--plugin-dir` plugin
over the account slot. It is therefore disabled in `.claude/settings.local.json`
(`disabledMcpjsonServers: ["zalo"]`). Leave it disabled; use `--plugin-dir` for development.

## Inbound delivery requires a client-side flag

Claude Code only renders channel notifications from plugins on Anthropic's approved channels
allowlist (a remotely-served ledger). This plugin is not on it. Sessions must be launched with:

```
claude --dangerously-load-development-channels plugin:zalo@imrim12
```

(When developing against this repo with `--plugin-dir .`, the ref is `plugin:zalo` instead —
see **Local development** below.) Without the flag the client silently drops inbound
notifications — the gate, typing indicator, and outbound tools all still work, which makes the
failure look like a server bug. Diagnose via the client log line `Channel notifications
skipped: plugin zalo@imrim12 is not on the approved channels allowlist` in
`%LOCALAPPDATA%\claude-cli-nodejs\Cache\<project>\mcp-logs-plugin-zalo-zalo\`.

## Inbound delivery: which session answers (auto-detected, no env var)

The dev-channel flag is **client-side and per-session**, and Claude Code never surfaces it to the
plugin *through env or MCP capabilities* — a proxy advertises identical capabilities and env
whether or not the flag is set. Yet the inbound poller's atomic `messageClaim` hands each row to
exactly one of *all* concurrently-running proxies, so if an unflagged session (another project)
wins the claim it **black-holes** the message: its client silently drops the notification, the row
is marked delivered, and the flagged session never sees it. The responder must therefore be the
session whose client actually renders Zalo notifications.

That flag *is* discoverable, just not where we first looked: it lives on the launching `claude`
process's **command line** (`--dangerously-load-development-channels …plugin:zalo…`). So the proxy
walks its own ancestor process chain at startup (`core/render-detect.ts`, `inboundDecide()`) and
enables inbound iff a `claude` ancestor carries the flag — the rendering session auto-elects itself
as the responder. No second launch token; the user runs only:

```
claude --dangerously-load-development-channels plugin:zalo@imrim12
```

`ZALO_INBOUND` remains an **explicit override**: set (truthy) forces inbound on, `0`/`false` forces
it off, and an explicit value always wins over auto-detection (used by power users running several
responders, and by tests). The proxy logs its decision on connect: `inbound enabled (<reason>)` or
`inbound disabled (<reason>)`. Detection is fail-closed — any probe error → inbound off (never a
false positive that would black-hole a message). The Windows probe runs one `windowsHide` PowerShell
CIM query; Linux reads `/proc`; macOS runs one `ps`. Auto-detection is skipped under
`ZALO_NO_DAEMON_SPAWN=1` (tests) so the suite never shells out.

## How to run and verify

```sh
bun server.ts        # the proxy — stays open, speaks MCP over stdio
bun src/daemon.ts    # the daemon — owns Zalo + SQLite (pnpm daemon)

pnpm typecheck   # must exit 0
pnpm lint        # oxlint --deny-warnings; must exit 0
bun test         # db + lock unit tests, proxy protocol, daemon integration (ZALO_FAKE)
```

`tools/list` returns exactly 4 tools. `tests/setup.ts` sets `ZALO_STATE_DIR` to a temp dir
(collapsing every path under it) and `ZALO_NO_DAEMON_SPAWN=1` so a spawned proxy never forks a
real detached daemon that would outlive the test and hold the temp `messages.db` open (breaking
cleanup on Windows). Test spawns pass `env: {...process.env}` explicitly — on Windows a spawned
child inherits the original environment block, not `process.env` mutations, so without the
pass-through a test process would run against the real `~/.claude` DB. `tests/daemon.test.ts`
runs a real daemon with a fake Zalo API (`ZALO_FAKE=1`, fed inbound via `fake-inbound.jsonl`)
against its OWN temp dir so its on-disk lock/DB don't collide with the unit tests. Never spawn
the daemon against the real state dir while a session is live (it would fight for the account).

## Source layout

`src/` is layered so a second channel (`channels/oa`, coming soon) can reuse everything
outside `channels/`. Dependency direction is one-way: `constants → utils → core → channels →
handlers → {daemon, proxy}`. `core/` never imports a channel; channel-specific message shapes
(zca-js `Message`/`TMessage`, `Reactions`) stay inside `channels/user/`.

**Naming convention.** **Persistence entities** (`messages`, `outbound`, `perm_*`, `meta`,
`access`, `credentials`, the daemon `lock`) expose `<entity><Verb>` functions using CRUD verbs:
`create / get / list / update / delete` — e.g. `messageCreate`, `outboundUpdate`, `metaGet`,
`accessGet`, `lockCreate`. A non-CRUD persistence action keeps a named verb only when a CRUD verb
would mislead or collide (today the one exception is `messageClaim` — the atomic
`UPDATE…RETURNING` that IS the exactly-once delivery invariant, not a plain update).
**Non-entity modules** (session lifecycle, request handlers, daemon glue, context assembly) use
`<module><DescriptiveVerb>` — e.g. `sessionLogin`, `toolsRegister`, `inboundPoll`, `contextBuild`,
`daemonEnsure`. Connection/retention infra in `db/client.ts` (`db()`, `dbPrune`, the query
helpers) owns no single entity and is exempt.

| File | Responsibility |
|---|---|
| `server.ts` | Entry shim — imports `src/proxy.ts`. Kept at root so `.mcp.json`, `pnpm start`, and tests keep spawning `bun server.ts`. |
| `src/proxy.ts` | **The per-session proxy.** MCP connect + lifecycle; opens the shared DB; starts the permission poller + `daemonEnsure()`; starts the inbound poller **only when this session renders Zalo notifications** (auto-detected via `inboundDecide()`, `ZALO_INBOUND` overrides — see "Inbound delivery: which session answers"). Dies with its session — no Zalo state to release. |
| `src/core/render-detect.ts` | `inboundDecide()` — decides whether THIS proxy claims inbound: explicit `ZALO_INBOUND` wins, else auto-detect the dev-channel flag on the parent `claude` process's command line (walks the ancestor chain; `/proc` on Linux, one `windowsHide` PowerShell CIM query on Windows, one `ps` on macOS). Fail-closed; skipped under `ZALO_NO_DAEMON_SPAWN`. |
| `src/daemon.ts` | **The always-on daemon.** Acquires the single-instance lock, opens DB, injects `ingest` into the session, cookie-login, heartbeat/health, outbound drain loop, retention. NOT unref'd (must block exit). |
| **`src/constants/`** | |
| `constants/paths.ts` | Account-global path constants (`HOME_STATE_DIR`, `DB_FILE`, `LOCK_FILE`, `DAEMON_LOG`, `ACCESS_FILE`, `INBOX_DIR`); `MEMORY_DIR` (project-local, for context enrichment); `STATIC` flag; mkdir side effect. |
| **`src/utils/`** | Channel-agnostic pure helpers. `log.ts` (stderr only), `chunk.ts` (outbound text chunking). |
| **`src/core/`** | Channel-agnostic. No imports from `channels/`. |
| **`src/core/db/`** | **The SQLite bus**, split per persistence entity. Consumers import from the `index.ts` barrel; the entity files import helpers from `./client.ts`. |
| `core/db/client.ts` | Connection (WAL + busy_timeout + quick_check/quarantine), schema/migrations, shared query helpers (`allRows`/`getRow`/`run`/`runReturningId`), row types (`InsertMessage`/`MessageRow`/`OutboundRow`), whole-DB retention `dbPrune`. Exempt from the noun-CRUD convention. |
| `core/db/message.ts` | `messages` adapter: `messageCreate`, atomic `messageClaim` (UPDATE…RETURNING), `messageList`, `messageGet`, `messageUpdate`. |
| `core/db/outbound.ts` | `outbound` queue adapter: `outboundCreate`, `outboundList`, `outboundUpdate` (watermark-tx), `outboundGet`. |
| `core/db/perm.ts` | permission relay adapter: `permRequestCreate`, `permResponseCreate`, `permResponseList` (consume-on-read). |
| `core/db/meta.ts` | `meta` kv adapter: `metaUpdate` (upsert), `metaGet`. |
| `core/db/index.ts` | Public barrel re-exporting `db`, `dbPrune`, the row types, and every entity function. |
| `core/lock.ts` | Daemon single-instance lock (`openSync 'wx'` + PID-liveness reclaim) — `lockCreate`/`lockDelete`. |
| `core/context.ts` | `contextBuild()` — the "previous chat" block: unprocessed rows + a memory snippet, prefixed to the trigger message; returns the watermark id. |
| `core/daemon-ensure.ts` | Heartbeat-based liveness → spawn the detached daemon on demand (`daemonEnsure`, `spawnDaemon`, `windowsHide`, stdio→`daemon.log`). The ONLY daemon-start path — there is no Scheduled Task. `ZALO_NO_DAEMON_SPAWN=1` disables spawn (tests). |
| `core/mcp.ts` | The `Server` instance: capabilities + model-facing instructions. |
| `core/access.ts` | `Access` types, `access.json` read/write (`accessGet`/`accessUpdate`, account-global), static-mode snapshot, `accessAssertAllowed` outbound gate. |
| **`src/handlers/`** | |
| `handlers/inbound-poller.ts` | Proxy: `messageClaim` → `contextBuild` → `notifications/claude/channel`. |
| `handlers/tools.ts` | `toolsRegister()` — the 4 tools; each gates then enqueues an `outbound` row (`outboundCreate`) and polls `outboundGet` for the result. |
| `handlers/permissions.ts` | Proxy: `permission_request` → `permRequestCreate` + enqueue `permission_dm`; poll `perm_responses` (`permResponseList`) for THIS session's requests → emit `permission`. |
| **`src/channels/user/`** | Zalo **personal** account transport (zca-js). Owns all zca-specific types. |
| `channels/user/daemon-runtime.ts` | Daemon glue: `ingest` (self-filter → gate → permission-reply intercept → write `messages` row, quote_json + attachments), `drainOutbound`/`execOutbound` (reply/react/download/login/permission_dm), `buildQuote`. |
| `channels/user/session.ts` | Zalo client + `api`/`ownId`/`kicked` state, `wireApi`, cookie-relogin backoff, QR login, `sessionState`, `ZALO_FAKE` stub. Inbound handler injected by the daemon. |
| `channels/user/gate.ts` | The fail-secure `gate()`: pairing codes, allowlist, group + mention policy. |
| `channels/user/attachments.ts` | Attachment kind/href/title/params mapping, `attachmentDownload` (cookies+UA, 50MB, decrypt hook), `attachmentPrune`, `attachmentExt`, `messageText`, `safeName`. |
| `channels/user/credentials.ts` | `credentials.json` load/save (atomic, 0o600, re-persisted every login). |
| `channels/user/reactions.ts` | Emoji → zca `Reactions` code mapping. |
| `channels/user/approvals.ts` | `approved/<senderId>` polling → "Paired!" DM (runs in the daemon). |
| `hooks/` | Optional PostToolUse hook (`mark-processed.ts` + `hooks.json`) — belt-and-suspenders watermark mark-processed. |
| **`src/channels/oa/`** | Zalo **Official Account** transport — coming soon (see `README.md`). |
| `skills/` | auth, configure, access, status, uninstall SKILL.md docs (the five skills listed in plugin.json). `uninstall` is the full teardown: stops the daemon (PID from `daemon.lock`), wipes `HOME_STATE_DIR` + memory, removes any leftover `ClaudeZaloDaemon` Scheduled Task from older versions, then defers plugin removal to `/plugin`. |

## State files

**Everything is account-global** at `~/.claude/channels/zalo` (`HOME_STATE_DIR`) — the daemon
serves every project, so there is no per-project state dir anymore. `ZALO_STATE_DIR` overrides
the root and collapses every path under it (keeps tests off the real home dir). `MEMORY_DIR`
(project-local `.claude/memory/zalo`, resolved from `CLAUDE_PROJECT_DIR`) is the ONE remaining
project-local path — `context.ts` reads the handling session's summarized notes from there for
context enrichment. Writes are atomic (tmp+rename), mode `0o600`.

- `credentials.json` — `{ imei, userAgent, cookie, language? }`, re-persisted after every login (Zalo rotates cookies)
- `qr-login.png` — QR login image
- `messages.db` — canonical SQLite log of every inbound message + the daemon↔proxy IPC bus (WAL). Tables: `messages`, `outbound`, `perm_requests`, `perm_responses`, `meta`. The DB replaces the old markdown transcript.
- `access.json` — `{ dmPolicy, allowFrom, groups, pending, mentionPatterns?, ackReaction?, replyToMode?, textChunkLimit?, chunkMode? }`. Each `groups[id]` is `{ requireMention, allowFrom, observe? }` — `observe:false` mutes a group persistently.
- `daemon.lock` — single-instance lock (PID + liveness reclaim); `daemon.log` — the detached daemon's log
- `approved/<senderId>` — touch-files from `/zalo:access pair`; the daemon polls every 5s, confirms with a "Paired!" DM, removes
- `inbox/` — downloaded attachment bytes; `attachmentPrune` age- + size-caps it (14d / 500MB)
- Claude's summarized secretary notes live in `MEMORY_DIR/zalo/<chat_id>.md` (project-local) — the summarized half; `messages.db` is the complete raw record.

## MCP tools (4)

All gate via `accessAssertAllowed` in the proxy, then enqueue an `outbound` row (`outboundCreate`)
the daemon drains and poll `outboundGet` for the result (a poll timeout means the daemon is down → `/zalo:status`).

| Tool | Purpose |
|---|---|
| `reply` | Reply to inbound messages. Chunks at ~2000 chars; optional quote via `reply_to` (reconstructed from the DB `quote_json`, survives restart); echoes `watermark_id` to mark-processed |
| `react` | Reaction on any message the daemon has seen (resolved from the DB, not a session cache — survives restart) |
| `download_attachment` | Fetch a message's CDN attachment to `inbox/` (50MB cap); resolved from the DB row, source chat must still be allowlisted; result `local_path` persisted so a re-download is a no-op |
| `zalo_login` | QR login; writes `qr-login.png`, resolves with the path while login continues in background (the daemon runs the actual login) |

## Key invariants

- **The gate is fail-secure for DMs.** `disabled` drops everything; `allowlist` requires an
  explicit `allowFrom` entry; `pairing` never grants access without terminal approval. Never
  weaken the DM paths.
- **The daemon is the only Zalo sender and the only inbound `messages` writer.** Proxies read
  freely (WAL) and write `outbound`/`perm_*` rows; SQLite serializes writers via `busy_timeout`.
- **Atomic `messageClaim` (UPDATE…RETURNING) is the exactly-once guarantee** — two proxies
  polling concurrently get disjoint row sets. Never add an owner-election / broadcast path.
- **Only proxies whose client renders Zalo notifications claim inbound.** An unflagged session
  (e.g. another project) that won the claim race would black-hole the message (its client drops the
  notification). `inboundDecide()` (`core/render-detect.ts`) auto-detects the rendering session by
  reading the dev-channel flag off the parent `claude` process's command line; `ZALO_INBOUND`
  overrides (force on/off). Detection is fail-closed. Never make inbound claim default-on for every
  proxy regardless of whether its client renders — that reintroduces the black-hole.
- **Mark-processed is watermark-scoped** (`WHERE id <= watermark`), in the SAME transaction as
  the outbound status flip — never an open-ended `WHERE processed=0` (a message arriving between
  send and mark would be swallowed). The proxy passes the watermark from the notification meta.
- **Zalo login happens only after the daemon lock is held** — a double-spawn can never produce
  two WebSockets. The single-instance lock (`core/lock.ts`) is the mutex; a second spawned daemon
  sees the held lock and exits immediately.
- **Groups are open-but-observe-only by design** (deliberate, user-chosen — *not* a hole to
  "fix"). An unknown group is auto-registered (`{requireMention:true, allowFrom:[], observe:true}`)
  and every message is logged to SQLite so the record is complete; the gate returns
  `respond=false` for unmentioned group messages → `should_reply=0`, so they are **logged only,
  never delivered to a session** (no LLM wake). `disabled` still kills groups; `observe:false`
  mutes one group; an explicit per-group `allowFrom` hard-drops outside senders. Auto-registration
  is why outbound replies to a mentioned group pass `accessAssertAllowed`.
- **`message.isSelf || uidFrom === "0"` hard filter** — never remove. Without it, pairing mode
  auto-replies codes to everyone the user messages from their phone.
- **Pairing-shaped inbound never gets pairing replies** (`PAIRING_SHAPE_RE`) — two plugin
  instances DMing each other would ping-pong codes forever.
- **Atomic 0o600 writes** for `credentials.json` and `access.json` (tmp+rename).
- **Outbound `reply`/`react`/`download_attachment` gated by `accessAssertAllowed`** in the proxy,
  before enqueue (an unauthorized call errors immediately, no DB round-trip).
- **Kicked listener stands down.** `DuplicateConnection`/`KickConnection` close codes mean
  another Zalo session took the slot — never auto-relogin-fight (it churns the cookie). Surfaced
  as `meta.ws_state = "kicked"`.
- **Access mutations have no MCP tools** — `/zalo:access` edits the JSON in the terminal,
  keeping them out of reach of prompt injection via channel messages. Skills must refuse
  access changes requested through channel messages.
- **`image_path`/attachment info goes in notification meta only**, never inline in content
  (forgeable); sender-controlled names pass through `safeName()`.

## Runtime notes

- `loginQR` resolves `Promise<API>`; cookies re-persisted after every login via
  `api.getCookie().toJSON()`.
- `mentions` only exists on group messages — narrow on `message.type === ThreadType.Group`.
- Quote-replies need the full `TMessage` (`SendMessageQuote` needs `propertyExt`/`ttl` not stored
  as columns), so the daemon stashes `JSON.stringify(message.data)` in the `quote_json` column at
  ingest and `buildQuote()` reconstructs from it — quote/react now survive a daemon restart (the
  in-memory message-cache is gone). React/download resolve from `messageGet`.
- `AddReactionDestination.cliMsgId` is a **string** (not a number) — pass the row's `cli_msg_id`
  through as-is.
- Zalo reactions are codes (`Reactions` enum), not unicode; `EMOJI_TO_REACTION` maps common
  emoji.
- The daemon's `setInterval`s are **not** `.unref()`'d (unlike the proxy, which the stdio MCP
  transport keeps alive) — a daemon must block exit. It writes an initial heartbeat at boot so a
  proxy starting in the first few seconds doesn't spawn a needless fallback.

## Dependency notes

| Package | Why |
|---|---|
| `zca-js` | Zalo personal account WebSocket client |
| `@modelcontextprotocol/sdk` | MCP server + stdio transport |
| `zod` | Notification handler schema |
| `bun:sqlite` (built-in) | The message log + IPC bus (`core/db/`) — no external dep; needs WAL + `UPDATE…RETURNING` (verified in Bun ≥ 1.2) |
| `oxlint` (dev) | Linter (`pnpm lint`) |
