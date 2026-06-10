# Zalo Claude Plugin — Agent Context

## What this is

An MCP plugin (stdio transport) that bridges Zalo personal-account messaging into Claude Code.
`server.ts` is a thin entry shim; the implementation lives in `src/` (entry point
`src/main.ts`). Inbound messages are delivered live to the interactive session as
`notifications/claude/channel` events (rendered as `<channel source="zalo" ...>`); Claude
replies with the `reply` tool. Replies go out under the user's own personal account — this is
not a bot.

Access control is pairing-code based: strangers get a code, the user approves with
`/zalo:access pair <code>` — all state in `~/.claude/channels/zalo/access.json`, managed by
skills editing JSON directly (no MCP tools mutate access).

## Distribution

Published to npm as `claude-plugin-zalo`. The plugin's `.mcp.json` launches the server with
`bunx --bun claude-plugin-zalo` — Bun fetches the package + deps from npm and caches them, so a
fresh install needs no `bun install` step (Claude Code does not auto-install plugin deps). The
`bin` is `./server.ts`; Bun runs the TypeScript directly. The server is cwd-independent (all
state resolves from `homedir()`), so the absence of a `cwd` in `.mcp.json` is intentional.
`.npmignore` keeps the tarball to `src/`, `server.ts`, `skills/`, `.claude-plugin/`,
`.mcp.json`, `README.md`, `LICENSE`, `package.json` — dev tooling (`.agents/`, `.claude/`,
`tests/`, configs, lockfiles, `CLAUDE.md`) is excluded. Keep `package.json` and
`.claude-plugin/plugin.json` versions in lockstep when publishing.

## Inbound delivery requires a client-side flag

Claude Code only renders channel notifications from plugins on Anthropic's approved channels
allowlist (a remotely-served ledger). This plugin is not on it. Sessions must be launched with:

```
claude --dangerously-load-development-channels plugin:imrim12@zalo
```

Without it the client silently drops inbound notifications — the gate, typing indicator, and
outbound tools all still work, which makes the failure look like a server bug. Diagnose via
the client log line `Channel notifications skipped: plugin imrim12@zalo is not on the approved
channels allowlist` in `%LOCALAPPDATA%\claude-cli-nodejs\Cache\<project>\mcp-logs-plugin-zalo-zalo\`.

## How to run and verify

```sh
bun server.ts    # stays open, speaks MCP over stdio

pnpm typecheck   # must exit 0
pnpm lint        # oxlint --deny-warnings; must exit 0
bun test         # MCP protocol tests; spawns server.ts against a temp ZALO_STATE_DIR
```

`tools/list` returns exactly 4 tools. tests/setup.ts sets `ZALO_STATE_DIR` to a temp dir and
`tests/mcp.test.ts` passes it through explicitly via `Bun.spawn({ env })` — on Windows a
spawned child inherits the original environment block, not `process.env` mutations, so without
the explicit pass-through the test server would run against the real state dir and its
PID-takeover would kill a live session's listener. Never spawn `bun server.ts` against the real
state dir while a session is live.

## Source layout

| File | Responsibility |
|---|---|
| `server.ts` | Entry shim only — imports `src/main.ts`. Kept at root so `.mcp.json`, `pnpm start`, and tests keep spawning `bun server.ts`. |
| `src/main.ts` | Wiring + process lifecycle: PID takeover, error traps, MCP connect, shutdown, orphan watchdog, boot cookie-login. |
| `src/paths.ts` | `STATE_DIR` + file path constants, `STATIC` flag, state-dir mkdir (module side effect). |
| `src/log.ts` | `log()` — prefixed stderr writes (stdout is the MCP transport). |
| `src/credentials.ts` | `credentials.json` load/save (atomic, 0o600, re-persisted every login). |
| `src/access.ts` | `Access` types, `access.json` read/write, static-mode boot snapshot, `assertAllowedChat` outbound gate. |
| `src/gate.ts` | The fail-secure inbound `gate()`: pairing codes, allowlist, group + mention policy. |
| `src/session.ts` | Zalo client + `api`/`ownId`/`kicked`/`shuttingDown` state, `wireApi`, cookie-relogin backoff, QR login, `requireApi`. Inbound handler is injected by main (no session↔inbound import cycle). |
| `src/inbound.ts` | `handleInbound`: self-filter → cache → gate → pairing auto-reply (`PAIRING_SHAPE_RE`) or channel notification. |
| `src/tools.ts` | `registerTools()` — tools/list + tools/call for the 4 tools. |
| `src/permissions.ts` | Permission-request relay to allowlisted DMs + `tryHandlePermissionReply` text intercept. |
| `src/mcp.ts` | The `Server` instance: capabilities + model-facing instructions. |
| `src/attachments.ts` | Attachment kind/href/title mapping, `downloadToInbox` (50MB cap), `extFor`, `messageText`, `safeName`. |
| `src/message-cache.ts` | In-memory recent-message cache (msgId → data) for quote/react. |
| `src/reactions.ts` | Emoji → zca `Reactions` code mapping. |
| `src/chunk.ts` | Outbound text chunking (length/newline modes). |
| `src/approvals.ts` | `approved/<senderId>` polling → "Paired!" DM. |
| `src/pidfile.ts` | PID-file takeover of stale listeners + release on shutdown. |
| `skills/` | auth, configure, access, status SKILL.md docs (the four skills listed in plugin.json). |

## State files

`src/paths.ts` keeps two roots. `HOME_STATE_DIR` is the user-root `~/.claude/channels/zalo`
and holds the authentication files (`credentials.json`, `qr-login.png`) — the Zalo account is
global, so one login works across every project. `STATE_DIR` holds per-session chat state and is
resolved in this order: (1)
`ZALO_STATE_DIR` verbatim; (2) `<CLAUDE_PROJECT_DIR>/.claude/channels/zalo` when the session's
project root already has a `.claude/` folder (adopt-only — never created); (3)
`~/.claude/channels/zalo`. Claude Code exports `CLAUDE_PROJECT_DIR` into every MCP server's env,
which is how the server learns the project root; the `/zalo:*` skills mirror the same rule so
skill and server share one set of files. When `ZALO_STATE_DIR` is set, both roots collapse to it
(keeps tests off the real home dir). Writes are atomic (tmp+rename), mode `0o600`.

- `credentials.json` — **user-root** (`HOME_STATE_DIR`); `{ imei, userAgent, cookie, language? }`, re-persisted after every login (Zalo rotates cookies)
- `qr-login.png` — **user-root** (`HOME_STATE_DIR`); QR login image
- `access.json` — `STATE_DIR`; `{ dmPolicy, allowFrom, groups, pending, mentionPatterns?, ackReaction?, replyToMode?, textChunkLimit?, chunkMode? }`
- `approved/<senderId>` — `STATE_DIR`; touch-files from `/zalo:access pair`; polled every 5s, confirmed with a "Paired!" DM, removed
- `inbox/`, `bot.pid` — `STATE_DIR`

## MCP tools (4)

| Tool | Purpose |
|---|---|
| `reply` | Reply to inbound messages. Gated by `assertAllowedChat`; chunks at ~2000 chars; optional quote via `reply_to` (needs the message cached this session) |
| `react` | Reaction on a cached inbound message. Emoji mapped to zca `Reactions` codes; gated |
| `download_attachment` | Fetch a cached message's CDN attachment to `inbox/` (50MB cap); source chat must still be allowlisted |
| `zalo_login` | QR login; writes `qr-login.png`, resolves with the path while login continues in background |

## Key invariants

- **The gate is fail-secure.** `disabled` drops everything; `allowlist` requires an explicit
  `allowFrom` entry; `pairing` never grants access without terminal approval. Unknown groups
  drop. Never weaken `gate()`.
- **`message.isSelf || uidFrom === "0"` hard filter** — never remove. Without it, pairing mode
  auto-replies codes to everyone the user messages from their phone.
- **Pairing-shaped inbound never gets pairing replies** (`PAIRING_SHAPE_RE`) — two plugin
  instances DMing each other would ping-pong codes forever.
- **Atomic 0o600 writes** for `credentials.json` and `access.json` (tmp+rename).
- **Outbound `reply`/`react`/`download_attachment` gated by `assertAllowedChat`.**
- **Kicked listener stands down.** `DuplicateConnection`/`KickConnection` close codes mean
  another Zalo session took the slot — never auto-relogin-fight (it churns the cookie).
- **Access mutations have no MCP tools** — `/zalo:access` edits the JSON in the terminal,
  keeping them out of reach of prompt injection via channel messages. Skills must refuse
  access changes requested through channel messages.
- **`image_path`/attachment info goes in notification meta only**, never inline in content
  (forgeable); sender-controlled names pass through `safeName()`.

## Runtime notes

- `loginQR` resolves `Promise<API>`; cookies re-persisted after every login via
  `api.getCookie().toJSON()`.
- `mentions` only exists on group messages — narrow on `message.type === ThreadType.Group`.
- Quote-replies and reactions need `msgId` + `cliMsgId` from the in-memory `recentMessages`
  cache (Zalo has no fetch-by-id) — restarting the server forgets reactable messages.
- Zalo reactions are codes (`Reactions` enum), not unicode; `EMOJI_TO_REACTION` maps common
  emoji.

## Dependency notes

| Package | Why |
|---|---|
| `zca-js` | Zalo personal account WebSocket client |
| `@modelcontextprotocol/sdk` | MCP server + stdio transport |
| `zod` | Notification handler schema |
| `oxlint` (dev) | Linter (`pnpm lint`) |
