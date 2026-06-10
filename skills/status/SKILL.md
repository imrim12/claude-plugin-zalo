---
name: status
description: Check the current status of the Zalo plugin and its subsystems. Use when the user says "Zalo status", "is Zalo connected", "check Zalo", or to diagnose connection issues.
---

There is no status MCP tool — diagnose from state files and logs.

**Two locations.** Authentication (login credentials and the QR image) is account-global and
always lives in `~/.claude/channels/zalo/` (`credentials.json`, `qr-login.png`). Per-session
chat state (access policy, pairings, inbox, pid) lives in the resolved `<state>` dir (the
channel server uses the same rule, so you read the same files it writes):
1. If `$ZALO_STATE_DIR` is set, use it.
2. Else if a `.claude/` directory exists in the project root (where Claude Code was launched),
   use `<project>/.claude/channels/zalo`.
3. Else use `~/.claude/channels/zalo`.

Paths below are relative to the resolved chat-state dir, except `credentials.json` and
`qr-login.png` (user-root).

1. **Login** — does `~/.claude/channels/zalo/credentials.json` exist (user-root, shared across
   projects)? Missing → not logged in, suggest `/zalo:auth`. Present → cookie login is attempted
   at boot (it can still be stale; the server stderr says `cookie login failed` if so).

2. **Owner** — read `bot.pid`. That process holds the Zalo listener (last session wins).

3. **Access** — read `access.json` (missing = defaults). Show dmPolicy, allowed-sender count,
   pending pairing codes. If pending > 0, mention `/zalo:access` to review them.

4. **Inbound delivery** — the most common "everything works except messages don't show up"
   cause. Claude Code only renders channel notifications from plugins on its approved
   allowlist; this plugin needs the session launched with:

   ```
   claude --dangerously-load-development-channels plugin:zalo@imrim12
   ```

   To confirm a drop, check the newest file in Claude Code's MCP log dir for the current
   project (`%LOCALAPPDATA%\claude-cli-nodejs\Cache\<project>\mcp-logs-plugin-zalo-zalo\` on
   Windows) for a line like `Channel notifications skipped: plugin zalo@imrim12 is not on the
   approved channels allowlist`. Server-side stderr lines (`zalo channel: ...`) in the same
   file show login, listener, and kick events.

Summarize each point clearly and end with the single most relevant next step.
