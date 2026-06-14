---
name: status
description: Check the current status of the Zalo plugin and its subsystems. Use when the user says "Zalo status", "is Zalo connected", "check Zalo", or to diagnose connection issues.
---

There is no status MCP tool — diagnose from the daemon's health record and state files.

**Everything is account-global now.** A single always-on **daemon** owns the Zalo connection
and a SQLite log at `~/.claude/channels/zalo/` (`messages.db`, `credentials.json`,
`qr-login.png`, `access.json`, `daemon.lock`, `daemon.log`). Per-session Claude proxies talk to
it through that DB. `$ZALO_STATE_DIR` overrides the location (and collapses everything under it).

## 1. Daemon health (the key signal)

The daemon publishes health into the DB `meta` table. Read it (resolve `<plugin>` to
`$CLAUDE_PLUGIN_ROOT`):

```
bun -e "import('<plugin>/src/core/db/index.ts').then(m=>{const g=m.metaGet;console.log(JSON.stringify({ws:g('ws_state'),heartbeat:g('heartbeat'),lastInbound:g('last_inbound_at'),started:g('started_at')},null,2))})"
```

Interpret:
- **heartbeat older than ~15s** → daemon is DOWN. Start it by launching (or reopening) a Claude
  session — the proxy spawns the detached daemon on demand.
- **ws_state = "kicked"** → another Zalo session (phone/browser/second login) took the slot. The
  daemon stood down on purpose (fighting it would churn the cookie). Close the other session,
  then `/zalo:auth` to reconnect.
- **ws_state = "connected"** + recent `lastInbound` → healthy.
- **ws_state = "reconnecting"** → transient; cookie re-login backoff in progress.
- **ws_state = "disconnected"** → no credentials yet, or login hasn't completed. Check login (2).

## 2. Login

Does `~/.claude/channels/zalo/credentials.json` exist? Missing → not logged in, suggest
`/zalo:auth`. Present → the daemon cookie-logs-in at boot (can still be stale; `daemon.log`
says `cookie login failed` if so).

## 3. Daemon lifecycle

The daemon is **spawn-on-demand**: a proxy launches it (detached, no console window) when it
finds no live heartbeat, and it persists across sessions until the machine reboots. There is no
Scheduled Task and nothing installed on the system — if the daemon is down, open a Claude session
to respawn it. (Older versions installed a `ClaudeZaloDaemon` Scheduled Task; if you see one
lingering, it's a leftover and can be removed with `schtasks /delete /tn ClaudeZaloDaemon /f` or
`/zalo:uninstall`.)

## 4. Access

Read `~/.claude/channels/zalo/access.json` (missing = defaults). Show dmPolicy, allowed-sender
count, pending pairing codes. If pending > 0, mention `/zalo:access` to review them.

## 5. Inbound delivery (the most common "everything works but nothing shows up")

Two independent requirements on the session meant to ANSWER Zalo:

**(a) The channel flag.** Claude Code only renders channel notifications from plugins on its
approved allowlist; this plugin needs the session launched with
`--dangerously-load-development-channels plugin:zalo@imrim12`. To confirm a drop, check the newest
file in the MCP log dir (`%LOCALAPPDATA%\claude-cli-nodejs\Cache\<project>\mcp-logs-plugin-zalo-zalo\`)
for `Channel notifications skipped: … not in --channels list for this session`.

**(b) `ZALO_INBOUND=1`.** Only a session launched with this env var claims inbound messages. With
several Claude sessions open (other projects), each runs a Zalo proxy and they race to claim each
incoming message via an atomic DB update; a session without the channel flag that wins the claim
**black-holes** the message (Claude Code drops its notification, and no other session re-claims
it). So the symptom is intermittent: DMs sometimes arrive, sometimes vanish, depending on which
session won. Fix: launch the ONE responder session with both the flag and `ZALO_INBOUND=1`:

```
# PowerShell
$env:ZALO_INBOUND=1; claude --dangerously-load-development-channels plugin:zalo@imrim12
```

Confirm via that session's proxy log on connect: `inbound enabled (ZALO_INBOUND)` (good) vs
`inbound disabled — set ZALO_INBOUND=1 …` (this session won't answer). To check whether messages
are being claimed but not rendered, inspect the DB: a row with `should_reply=1` and a non-null
`delivered_to` that never gets `processed=1` was claimed by a session that couldn't show it.
Daemon-side events live in `~/.claude/channels/zalo/daemon.log`.

Summarize each point clearly and end with the single most relevant next step.
