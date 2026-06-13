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

## Inbound delivery flag

After login, remind the user: **inbound** messages only render in the session if Claude Code was
launched with channel delivery enabled for this plugin:

```
claude --dangerously-load-development-channels plugin:zalo@imrim12
```

Without it, outbound tools work but incoming Zalo messages are silently dropped by Claude Code
(the plugin is not on the built-in approved-channels allowlist).
