# claude-plugin-zalo

A Claude Code MCP plugin that bridges Zalo into your Claude sessions. Messages from approved
senders appear live in your interactive session as channel events, and Claude replies under
your own identity — this is your **personal** Zalo account, driven over a WebSocket by
[zca-js](https://github.com/RFS-ADRENO/zca-js), not a bot.

## Features

- **Live channel events** — no polling; allowed senders' messages render in the session as they arrive
- **Background daemon** — a single detached process owns the Zalo connection (spawn-on-demand; no console window, no scheduled task, nothing installed), so opening/closing Claude sessions never drops the connection
- **Logs every message to SQLite** — every inbound message is persisted to a canonical SQLite log, independent of whether a session is open
- **Answers only when @mentioned** — DMs and group @mentions wake the LLM; unmentioned group messages are logged silently (no reply, no LLM)
- **Multi-session safe** — N Claude sessions coexist; exactly one answers each message (atomic claim), none fight over the account
- **Pairing-code access control** — strangers get a code; you approve with `/zalo:access pair <code>`
- **Allowlist lockdown** — `dmPolicy: allowlist` silently drops anyone you haven't approved
- **Reply, react, and durable attachments** — chunked text replies, emoji/reaction codes, and inbound photo/file download that survives daemon restarts
- **Permission relay** — Claude Code permission prompts are forwarded to your DM; reply `yes <id>` / `no <id>`

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.2 — must be on your `PATH`; works on Windows, Linux, and macOS
- A Zalo personal account

## Install

```sh
# Add the plugin source (one-time)
claude plugin marketplace add imrim12/claude-plugin-zalo

# Install
claude plugin install zalo@imrim12
```

Verify it loaded:

```sh
claude plugin list   # should show: zalo  ✔ loaded
```

The MCP server runs straight from npm via `bunx claude-plugin-zalo` — Bun fetches the package
and its dependencies on first launch and caches them, so there's no manual `install` step and
nothing OS-specific to configure. State lives under your home directory
(`~/.claude/channels/zalo`), resolved cross-platform, independent of where Claude Code is
launched from.

## Enable inbound delivery (required)

Claude Code only renders `notifications/claude/channel` events from plugins on Anthropic's
**approved channels allowlist**. This plugin is not on it, so inbound messages are silently
dropped unless you launch the session with the development-channels flag:

```sh
claude --dangerously-load-development-channels plugin:zalo@imrim12

# Or YOLO mode

claude --dangerously-load-development-channels plugin:zalo@imrim12 --dangerously-skip-permissions
```

A confirmation dialog appears at startup — accept it. Without this flag, **everything else
still works** (QR login, pairing auto-replies, outbound `reply`), which makes the failure look
like a plugin bug: the sender sees the typing indicator but the message never reaches your
session.

To confirm you're hitting this, check the newest file in Claude Code's MCP log directory for
your project (`%LOCALAPPDATA%\claude-cli-nodejs\Cache\<project>\mcp-logs-plugin-zalo-zalo\` on
Windows) for:

```
Channel notifications skipped: plugin zalo@imrim12 is not on the approved channels allowlist
```

## Quick start

### 1. Log in (personal account)

1. Run `/zalo:auth` (or call the `zalo_login` tool).
2. Scan the QR code at the path `/zalo:auth` reports (`qr-login.png` in the state directory) with the Zalo mobile app (More → QR scan).
3. Confirm on your phone. Credentials are saved automatically — no re-scan needed on restart.

### 2. Pair your other account

The default DM policy is `pairing`: when an unknown sender DMs your account, the plugin
auto-replies with a 6-character code. Approve them in your terminal:

```
/zalo:access pair <code>
```

They get a "Paired!" DM, and from then on their messages appear live in your session
(provided inbound delivery is enabled — see above).

### 3. Lock it down

Once everyone you want is paired, switch to a hard allowlist so strangers are dropped silently:

```
/zalo:access policy allowlist
```

Manage everything else with `/zalo:access` — `allow <id>`, `remove <id>`, `deny <code>`,
`group add <threadId> [--no-mention] [--allow id1,id2]`, `group rm <threadId>`.

## MCP tools

| Tool | Description |
|---|---|
| `reply` | Reply to an inbound channel message (allowlist-gated, chunks long texts, optional quote via `reply_to`, echoes `watermark_id` to mark-processed) |
| `react` | React to any message the daemon has seen — common emoji or raw zca reaction codes (allowlist-gated, survives restarts) |
| `download_attachment` | Fetch a received attachment (document/voice/video/…) to the local inbox by `message_id` (durable — works after a daemon restart) |
| `zalo_login` | Start the QR login flow; writes the QR image and returns its path |

Access control has no MCP tools — it's managed entirely by the `/zalo:access` skill editing
`access.json` in the state directory. This keeps access mutations out of reach of prompt
injection arriving through channel messages.

## Skills

| Skill | Purpose |
|---|---|
| `/zalo:auth` | QR login to your personal account |
| `/zalo:configure` | Orient on login + access state; drive toward an allowlist lockdown |
| `/zalo:access` | Approve pairings, edit the allowlist, set DM/group policy |
| `/zalo:status` | Diagnose connection and inbound-delivery issues from state files and logs |

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `ZALO_STATE_DIR` | No | Force a specific state directory, overriding the resolution below |
| `ZALO_ACCESS_MODE=static` | No | Snapshot access at boot; never re-read or written (pairing downgrades to allowlist) |

## State directory

State is **account-global** — everything lives under `~/.claude/channels/zalo` (a single daemon
serves every project, so there is no per-project state dir). `ZALO_STATE_DIR` overrides the root
(used by the test suite). The `/zalo:*` skills resolve the same path, so they read and write the
same files the daemon does.

> **Migrating from an older version?** Access used to be per-project. If a project still has
> `<project>\.claude\channels\zalo\access.json`, copy it once to
> `%USERPROFILE%\.claude\channels\zalo\access.json` — only the account-global file is read now.
> If both exist, the account-global one wins.

## State files

All under `~/.claude/channels/zalo` (mode `0600`, atomic writes):

- `credentials.json` — Zalo session: imei, userAgent, cookie jar (rotated and re-saved on every login)
- `qr-login.png` — last QR login code
- `messages.db` — the canonical SQLite log of every inbound message **and** the IPC bus between
  the daemon and per-session proxies (WAL mode)
- `access.json` — `dmPolicy`, `allowFrom`, `groups`, `pending` pairings, delivery/UX config
- `daemon.lock` — the daemon's single-instance lock; `daemon.log` — the daemon's own log (it runs detached, never on a proxy's stdout)
- `approved/<senderId>` — touch-files dropped by `/zalo:access pair`; the daemon polls, DMs "Paired!", and removes them
- `inbox/` — downloaded attachment bytes (age- and size-capped)

## Background daemon

A single **daemon** owns the Zalo connection and the SQLite log; each Claude session runs a thin
**proxy** that talks to the daemon only through `messages.db` (no socket). The daemon is
**spawn-on-demand**: the first session that needs it launches it as a detached background process
(no console window), and it keeps running across later sessions until you reboot. Nothing is
installed on your machine — there is no Scheduled Task, nothing runs on a timer, and there is no
background process at all until a session starts one. Closing every session leaves the daemon
running (so messages keep logging) until the next reboot; the next session you open re-spawns it
if needed. This is the only mode, on every platform.

## Architecture

`server.ts` is a thin entry shim that launches the per-session **proxy** (`src/proxy.ts`); the
always-on **daemon** is `src/daemon.ts`. Two processes, one DB:

| Module | Responsibility |
|---|---|
| `proxy.ts` | Per-session MCP server: claims inbound rows, enriches with context, emits channel notifications; tool calls enqueue `outbound` rows and poll for results; ensures the daemon is running |
| `daemon.ts` / `channels/user/daemon-runtime.ts` | The single Zalo owner: login/listener, gate → write `messages` rows, drain the `outbound` queue, mark-processed on send, publish health |
| `core/db/` | The SQLite bus (client + per-entity adapters): schema, atomic `messageClaim`, `outbound` queue, watermark mark-processed, retention |
| `core/lock.ts` | Daemon single-instance lock (Zalo login happens only after the lock is held) |
| `core/context.ts` | Builds the "previous chat" context block (unprocessed rows + memory) fed before answering |
| `core/daemon-ensure.ts` | Heartbeat-based daemon liveness; spawns the detached daemon on demand |
| `access.ts` / `gate.ts` | `access.json` types + outbound gate; the fail-secure inbound gate (pairing / allowlist / group + mention) |
| `session.ts` | Zalo login/listener lifecycle: cookie re-login with backoff, QR bootstrap, kick stand-down, `ws_state` |
| `tools.ts` / `permissions.ts` | The 4 MCP tools (enqueue + poll); permission DM relay + `yes/no <id>` reply routing |
| `attachments.ts`, `mcp.ts`, `approvals.ts`, `credentials.ts`, `reactions.ts`, `chunk.ts`, `paths.ts`, `log.ts` | Inbox download + retention, MCP server instance, approval polling, credential persistence, emoji→reaction codes, text chunking, path constants, stderr logging |

**Message flow:** Zalo WebSocket → daemon `ingest()` → `gate()` → `messages` row. A live
proxy atomically claims `should_reply` rows → enriches with context → `notifications/claude/channel`
→ renders in your session as `<channel source="zalo" ...>`. Replies go the other way: tool →
`outbound` row → daemon drains it → Zalo.

**No more session-kills-session.** The daemon owns the single Zalo listener slot; proxies never
fight over it. Exactly one proxy answers each message via an atomic row-claim — no owner election.

**Kick stand-down:** if another Zalo session (phone/browser) takes the listener slot, the daemon
stands down instead of fighting for it — re-login would churn the cookie. `/zalo:status` reports
`ws_state: kicked`; run `/zalo:auth` after closing the other session.

## Development

```sh
pnpm typecheck   # tsc --noEmit
pnpm lint        # oxlint --deny-warnings
bun test         # db + lock + proxy protocol + daemon integration (temp state dir, ZALO_FAKE)
pnpm start       # bun server.ts  (the proxy)
pnpm daemon      # bun src/daemon.ts  (manual daemon start / debugging)
```

## Publishing

The plugin's `.mcp.json` launches the server with `bunx claude-plugin-zalo`, so the package
must be on npm for installs to resolve. To publish a new version:

```sh
npm version <patch|minor|major>   # also bump .claude-plugin/plugin.json to match
npm publish                       # .npmignore controls what ships
```

`npm pack --dry-run` previews the tarball — it should contain `src/`, `server.ts`, `skills/`,
`hooks/`, `.claude-plugin/`, `.mcp.json`, `README.md`, and `LICENSE`, and nothing else.
