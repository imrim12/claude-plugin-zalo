---
name: status
description: Check the current status of the Zalo plugin and its subsystems. Use when the user says "Zalo status", "is Zalo connected", "check Zalo", or to diagnose connection issues.
---

There is no status MCP tool — diagnose from state files and logs. State dir:
`~/.claude/channels/zalo/` (`ZALO_STATE_DIR` overrides).

1. **Login** — does `credentials.json` exist in the state dir? Missing → not logged in,
   suggest `/zalo:auth`. Present → cookie login is attempted at boot (it can still be stale;
   the server stderr says `cookie login failed` if so).

2. **Owner** — read `bot.pid`. That process holds the Zalo listener (last session wins).

3. **Access** — read `access.json` (missing = defaults). Show dmPolicy, allowed-sender count,
   pending pairing codes. If pending > 0, mention `/zalo:access` to review them.

4. **Inbound delivery** — the most common "everything works except messages don't show up"
   cause. Claude Code only renders channel notifications from plugins on its approved
   allowlist; this plugin needs the session launched with:

   ```
   claude --dangerously-load-development-channels plugin:zalo@zalo
   ```

   To confirm a drop, check the newest file in Claude Code's MCP log dir for the current
   project (`%LOCALAPPDATA%\claude-cli-nodejs\Cache\<project>\mcp-logs-plugin-zalo-zalo\` on
   Windows) for a line like `Channel notifications skipped: plugin zalo@zalo is not on the
   approved channels allowlist`. Server-side stderr lines (`zalo channel: ...`) in the same
   file show login, listener, and kick events.

Summarize each point clearly and end with the single most relevant next step.
