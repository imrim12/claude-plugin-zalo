---
name: auth
description: Authenticate or log in to Zalo personal account. Use when the user says "connect Zalo", "log in to Zalo", "scan QR", "zalo auth", or when a tool errors with "Zalo not logged in".
---

Call `zalo_login` now.

Read the QR code image at the path from the response and show it to the user, then tell them:
> Open Zalo mobile app → More → QR scan → scan the code → confirm on your phone (within ~100 seconds).

Login completes in the background; credentials are saved to `~/.claude/channels/zalo/credentials.json`
automatically. Everything authentication-related — both the credentials and the QR image
(`qr-login.png`) — lives in the user-root dir, not the project-local state dir, because the Zalo
account is global: one scan works across every project, no re-scan on restart. (`$ZALO_STATE_DIR`
overrides the location, and `zalo_login` returns the QR's full path anyway, so just use the path
it gives you.) There is no status tool — confirm the login worked by sending or receiving a
message, or check that `~/.claude/channels/zalo/credentials.json` now exists.

After login, remind the user: **inbound** messages only render in the session if Claude Code was launched with channel delivery enabled for this plugin:

```
claude --dangerously-load-development-channels plugin:imrim12@zalo
```

Without it, outbound tools work but incoming Zalo messages are silently dropped by Claude Code (the plugin is not on the built-in approved-channels allowlist).
