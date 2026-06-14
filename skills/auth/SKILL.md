---
name: auth
description: Authenticate or log in to Zalo personal account. Use when the user says "connect Zalo", "log in to Zalo", "scan QR", "zalo auth", or when a tool errors with "Zalo not logged in".
---

Call `zalo_login` now.

Read the QR code image at the path from the response and show it to the user, then tell them:
> Open Zalo mobile app → More → QR scan → scan the code → confirm on your phone (within ~100 seconds).

Login completes in the background; credentials are saved to `~/.claude/channels/zalo/credentials.json`
automatically. Authentication — credentials and the QR image (`qr-login.png`) — is account-global
(user-root), because the Zalo account is global: one scan works across every project, no re-scan
on restart. (`$ZALO_STATE_DIR` overrides the location, and `zalo_login` returns the QR's full
path anyway, so just use the path it gives you.) Confirm the login worked by sending or receiving
a message, by `/zalo:status`, or by checking that `~/.claude/channels/zalo/credentials.json` now
exists.

## The background daemon

A single **daemon** owns the Zalo connection and logs every message to SQLite. It is
**spawn-on-demand**: the first Claude session that needs it launches it as a detached background
process (no console window), and it stays running across later sessions until you reboot. There
is nothing to install and no background task — the daemon lives and dies with your machine's
uptime once a session has started it. (To fully remove the plugin and its state, use
`/zalo:uninstall`.)

## Inbound delivery: a flag AND an env var

After login, remind the user that **inbound** messages need TWO things on the session that should
answer Zalo:

```
# bash / macOS / Linux
ZALO_INBOUND=1 claude --dangerously-load-development-channels plugin:zalo@imrim12

# Windows PowerShell
$env:ZALO_INBOUND=1; claude --dangerously-load-development-channels plugin:zalo@imrim12
```

1. **`--dangerously-load-development-channels plugin:zalo@imrim12`** — without it, Claude Code
   silently drops incoming Zalo notifications (the plugin isn't on the built-in approved-channels
   allowlist). Outbound tools still work, which makes the failure look like a server bug.
2. **`ZALO_INBOUND=1`** — marks this session as the responder. Only an opted-in session claims
   inbound messages from the shared queue. This matters when you have **other Claude sessions
   open** (different projects): every session runs a Zalo proxy, and without this gate any of them
   could grab an incoming message and black-hole it (it has no channel flag, so Claude Code drops
   the notification and no other session ever sees it). Set `ZALO_INBOUND=1` on exactly the one
   session you want to answer from; the others need no change.

If inbound seems dead, check the proxy log line on connect: `inbound enabled (ZALO_INBOUND)` vs
`inbound disabled — set ZALO_INBOUND=1 …` confirms whether this session is claiming.
