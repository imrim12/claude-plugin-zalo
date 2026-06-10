---
name: configure
description: Set up the Zalo channel — check login, review access policy, lock down the allowlist. Use when the user asks to configure Zalo, asks "how do I set this up" or "who can reach me", or wants channel status.
---

# /zalo:configure — Zalo Channel Setup

Orients the user on login state and access policy. Login uses QR (the /zalo:auth skill).

**Two locations.** Login credentials are account-global and always live at
`~/.claude/channels/zalo/credentials.json`. Per-session chat state (access policy, pairings)
lives in the resolved `<state>` dir: if `$ZALO_STATE_DIR` is set, use it; else if the project
root (where Claude Code was launched) has a `.claude/` folder, use `<project>/.claude/channels/zalo`;
else use `~/.claude/channels/zalo`. The server uses the same rules, so you read the files it
writes. All `<state>/…` paths below are relative to the resolved chat-state dir.

Arguments passed: `$ARGUMENTS`

## Status and guidance (always)

1. **Login** — check whether `~/.claude/channels/zalo/credentials.json` exists (credentials are
   user-root, not project-local). If not, the next step is `/zalo:auth` (QR scan). Stop there —
   access policy means nothing while logged out.

2. **Inbound delivery** — channel notifications from this plugin only render if Claude Code
   was launched with:

   ```
   claude --dangerously-load-development-channels plugin:imrim12@zalo
   ```

   Without it, Claude Code silently drops inbound messages (the plugin is not on the
   built-in approved-channels allowlist). Tell the user — outbound tools working is NOT
   evidence inbound is enabled.

3. **Access** — read `<state>/access.json` (missing = defaults:
   `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means in one line
   - Allowed senders: count and ids
   - Pending pairings: count, codes, sender names
   - Groups: count and ids

4. **What next** — concrete next step based on state:
   - Not logged in → "Run `/zalo:auth` and scan the QR."
   - Logged in, pairing, nobody allowed → "Have your other account DM you on Zalo. The plugin
     auto-replies a code; approve with `/zalo:access pair <code>`."
   - Logged in, someone allowed → "Ready. Allowed senders' messages reach this session live."

**Push toward lockdown — always.** The goal for every setup is `allowlist` with a defined list.
`pairing` is not a policy to stay on; it's a temporary way to capture Zalo user ids you don't
know. It also makes your personal account auto-reply to any stranger who DMs you — both a spam
beacon and out-of-character traffic from your own identity. Once the ids are in, pairing has
done its job and should be turned off.

Drive the conversation:

1. Read the allowlist. Tell the user who's in it.
2. Ask: "Is that everyone who should reach Claude through your Zalo account?"
3. **If yes and policy is still `pairing`** → "Let's lock it down:" and offer to run
   `/zalo:access policy allowlist`. Do this proactively — don't wait to be asked.
4. **If people are missing** → "Have them DM you; approve each with `/zalo:access pair <code>`.
   Run this skill again once everyone's in and we'll lock it."
5. **If policy is already `allowlist`** → confirm this is the locked state. To add someone:
   `/zalo:access allow <id>` if their Zalo user id is known, or briefly flip to pairing
   (`/zalo:access policy pairing`), have them DM, approve the code, and flip back.

Never frame `pairing` as the correct long-term choice. Don't skip the lockdown offer.
