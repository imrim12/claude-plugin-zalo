# claude-plugin-zalo

A Claude Code MCP plugin that bridges Zalo into your Claude sessions. Messages from approved
senders appear live in your interactive session as channel events, and Claude replies under
your own identity — this is your **personal** Zalo account, driven over a WebSocket by
[zca-js](https://github.com/RFS-ADRENO/zca-js), not a bot.

## Features

- **Live channel events** — no polling; allowed senders' messages render in the session as they arrive
- **Pairing-code access control** — strangers get a code; you approve with `/zalo:access pair <code>`
- **Allowlist lockdown** — `dmPolicy: allowlist` silently drops anyone you haven't approved
- **Group mention-gating** — opt groups in, optionally only when your account is @mentioned
- **Reply, react, and attachments** — chunked text replies, emoji/reaction codes, and inbound photo/file download
- **Permission relay** — Claude Code permission prompts are forwarded to your DM; reply `yes <id>` / `no <id>`
- **Last session wins** — starting a new Claude session takes over the Zalo connection from the old one

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.2 — must be on your `PATH`; works on Windows, Linux, and macOS
- A Zalo personal account

## Install

```sh
# Add the plugin source (one-time)
claude plugin marketplace add imrim12/claude-plugin-zalo

# Install
claude plugin install zalo
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
claude --dangerously-load-development-channels plugin:imrim12@zalo

# Or YOLO mode

claude --dangerously-load-development-channels plugin:imrim12@zalo --dangerously-skip-permissions
```

A confirmation dialog appears at startup — accept it. Without this flag, **everything else
still works** (QR login, pairing auto-replies, outbound `reply`), which makes the failure look
like a plugin bug: the sender sees the typing indicator but the message never reaches your
session.

To confirm you're hitting this, check the newest file in Claude Code's MCP log directory for
your project (`%LOCALAPPDATA%\claude-cli-nodejs\Cache\<project>\mcp-logs-plugin-zalo-zalo\` on
Windows) for:

```
Channel notifications skipped: plugin imrim12@zalo is not on the approved channels allowlist
```

## Quick start

### 1. Log in (personal account)

1. Run `/zalo:auth` (or call the `zalo_login` tool).
2. Scan the QR code that appears at `~/.claude/channels/zalo/qr-login.png` with the Zalo mobile app (More → QR scan).
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
| `reply` | Reply to an inbound channel message (allowlist-gated, chunks long texts, optional quote via `reply_to`) |
| `react` | React to a received message — common emoji or raw zca reaction codes (allowlist-gated) |
| `download_attachment` | Fetch a received attachment (document/voice/video/…) to the local inbox by `message_id` |
| `zalo_login` | Start the QR login flow; writes the QR image and returns its path |

Access control has no MCP tools — it's managed entirely by the `/zalo:access` skill editing
`~/.claude/channels/zalo/access.json`. This keeps access mutations out of reach of prompt
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
| `ZALO_STATE_DIR` | No | Override the state directory (default `~/.claude/channels/zalo`) |
| `ZALO_ACCESS_MODE=static` | No | Snapshot access at boot; never re-read or written (pairing downgrades to allowlist) |

## State files

All under `~/.claude/channels/zalo/` (mode `0600`, atomic writes):

- `credentials.json` — Zalo session: imei, userAgent, cookie jar (rotated and re-saved on every login)
- `access.json` — `dmPolicy`, `allowFrom`, `groups`, `pending` pairings, delivery/UX config
- `approved/<senderId>` — touch-files dropped by `/zalo:access pair`; the server polls, DMs "Paired!", and removes them
- `qr-login.png` — last QR login code
- `inbox/` — downloaded attachment bytes
- `bot.pid` — current connection owner (last session wins)

## Architecture

`server.ts` is a thin entry shim; the implementation lives in `src/` (entry point
`src/main.ts`). Each module has one responsibility:

| Module | Responsibility |
|---|---|
| `main.ts` | Wires everything together; owns process lifecycle (PID takeover, shutdown, orphan watchdog) |
| `access.ts` | `access.json` types + read/write, static-mode snapshot, outbound chat gate |
| `gate.ts` | The fail-secure inbound gate: pairing / allowlist / group + mention policy |
| `session.ts` | Zalo login/listener lifecycle: cookie re-login with backoff, QR bootstrap, kick stand-down |
| `inbound.ts` | Inbound pipeline: self-filter → cache → gate → pairing auto-reply or channel notification |
| `tools.ts` | The 4 MCP tools |
| `permissions.ts` | Permission-request relay to DMs + `yes/no <id>` reply intercept |
| `attachments.ts` | Attachment kind/href mapping, inbox downloads, sender-name sanitizing |
| `mcp.ts`, `approvals.ts`, `credentials.ts`, `message-cache.ts`, `reactions.ts`, `chunk.ts`, `pidfile.ts`, `paths.ts`, `log.ts` | MCP server instance, approval polling, credential persistence, quote/react cache, emoji→reaction codes, text chunking, PID file, path constants, stderr logging |

**Message flow:** Zalo WebSocket → `api.listener` → self filter → `gate()` →
`notifications/claude/channel` → renders in your session as `<channel source="zalo" ...>`.

**Takeover:** one process owns the Zalo connection (`bot.pid`). Starting a second Claude
session kills the first server and takes over.

**Kick stand-down:** if another Zalo session (phone/browser/second instance) takes the
listener slot, the server stands down instead of fighting for it — re-login would churn the
cookie. Tools error clearly until you run `zalo_login` or restart.

## Development

```sh
pnpm typecheck   # tsc --noEmit
pnpm lint        # oxlint --deny-warnings
bun test         # MCP protocol tests (spawned against a temp state dir)
pnpm start       # bun server.ts
```

## Publishing

The plugin's `.mcp.json` launches the server with `bunx claude-plugin-zalo`, so the package
must be on npm for installs to resolve. To publish a new version:

```sh
npm version <patch|minor|major>   # also bump .claude-plugin/plugin.json to match
npm publish                       # .npmignore controls what ships
```

`npm pack --dry-run` previews the tarball — it should contain `src/`, `server.ts`, `skills/`,
`.claude-plugin/`, `.mcp.json`, `README.md`, and `LICENSE`, and nothing else.
