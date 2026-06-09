/**
 * Zalo channel for Claude Code — entry point.
 *
 * Self-contained MCP server with full access control: pairing, allowlists,
 * group support with mention-triggering. State lives in
 * ~/.claude/channels/zalo/access.json — managed by the /zalo:access skill.
 *
 * Structural port of telegram.ts. Differences from Telegram:
 * - Auth: no bot token. zca-js logs into the user's PERSONAL account via QR
 *   scan (zalo_login tool), then persists { imei, userAgent, cookie } to
 *   credentials.json for cookie re-login on later boots.
 * - Inbound: zca-js WebSocket listener instead of getUpdates long-polling.
 * - Replies are sent as the user themself, not a bot persona.
 * - No bot commands (/start, /help) — personal accounts have no command UI.
 * - No edit_message (Zalo can't edit sent messages).
 * - download_attachment takes a message_id (cached inbound), not a file_id —
 *   Zalo addresses attachments by CDN href inside the message payload.
 *
 * This file only wires the modules together and owns process lifecycle
 * (PID takeover, shutdown, orphan watchdog). The behavior lives in:
 *   access.ts/gate.ts  — who gets in
 *   session.ts         — Zalo login/listener lifecycle
 *   inbound.ts         — inbound message → channel notification
 *   tools.ts           — the 4 MCP tools
 *   permissions.ts     — permission request/reply relay
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { mcp } from './mcp.ts'
import { registerTools } from './tools.ts'
import { registerPermissionRelay } from './permissions.ts'
import { handleInbound } from './inbound.ts'
import {
  setInboundHandler,
  cookieLogin,
  isShuttingDown,
  markShuttingDown,
} from './session.ts'
import { startApprovalPolling } from './approvals.ts'
import { takeOverPidFile, releasePidFile } from './pidfile.ts'
import { log } from './log.ts'

takeOverPidFile()

// Last-resort safety net — without these the process dies silently on any
// unhandled promise rejection. With them it logs and keeps serving tools.
process.on('unhandledRejection', err => {
  log(`unhandled rejection: ${err}`)
})
process.on('uncaughtException', err => {
  log(`uncaught exception: ${err}`)
})

setInboundHandler(handleInbound)
registerPermissionRelay()
registerTools()
startApprovalPolling()

await mcp.connect(new StdioServerTransport())

// When Claude Code closes the MCP connection, stdin gets EOF. Without this
// the listener keeps the WebSocket forever as a zombie, holding the account's
// listener slot and kicking the next session with DuplicateConnection.
function shutdown(): void {
  if (isShuttingDown()) return
  log('shutting down')
  markShuttingDown() // sets the flag and stops the Zalo listener
  releasePidFile()
  // Give the WebSocket close a moment, then force-exit.
  setTimeout(() => process.exit(0), 2000).unref()
  process.exit(0)
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

// Orphan watchdog: stdin events above don't reliably fire when the parent
// chain (`bun run` wrapper → shell → us) is severed by a crash. Poll for
// reparenting (POSIX) or a dead stdin pipe and self-terminate.
const bootPpid = process.ppid
setInterval(() => {
  const orphaned =
    (process.platform !== 'win32' && process.ppid !== bootPpid) ||
    process.stdin.destroyed ||
    process.stdin.readableEnded
  if (orphaned) shutdown()
}, 5000).unref()

// Boot: cookie-login if credentials exist; otherwise wait for zalo_login.
void cookieLogin()
