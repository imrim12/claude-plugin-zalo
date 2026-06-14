/**
 * Zalo channel for Claude Code — the per-session PROXY.
 *
 * This is what `.mcp.json` launches for each session. It speaks MCP over stdio to Claude Code
 * and speaks to the daemon ONLY through the shared SQLite DB (no socket). It:
 *   • claims inbound `should_reply` rows atomically and delivers them as channel notifications,
 *     enriched with the chat's unprocessed lead-up + a memory snippet;
 *   • turns tool calls into `outbound` rows the daemon drains, then polls for the result;
 *   • ensures the daemon (the single Zalo owner) is running.
 *
 * The proxy holds no Zalo state — it dies with its session and the daemon keeps running. The
 * old session-kills-session PID-takeover / orphan-watchdog logic is gone by design.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { randomBytes } from 'crypto'
import { mcp } from './core/mcp.ts'
import { db } from './core/db/index.ts'
import { toolsRegister } from './handlers/tools.ts'
import { permissionRelay, permissionPoll } from './handlers/permissions.ts'
import { inboundPoll } from './handlers/inbound-poller.ts'
import { daemonEnsure } from './core/daemon-ensure.ts'
import { inboundDecide } from './core/render-detect.ts'
import { log } from './utils/log.ts'

const SESSION_ID = `${process.pid}-${randomBytes(3).toString('hex')}`
db()                                  // open shared DB (WAL)

process.on('unhandledRejection', e => log(`unhandled rejection: ${e}`))
process.on('uncaughtException', e => log(`uncaught exception: ${e}`))

toolsRegister()
permissionRelay(SESSION_ID)
await mcp.connect(new StdioServerTransport())

void daemonEnsure()                   // bring the daemon up if it isn't (non-blocking)

// Only a session whose Claude Code client actually RENDERS Zalo channel notifications should claim
// inbound messages — otherwise it would win the atomic messageClaim against the real responder and
// black-hole the message (its client silently drops the notification). The launch flag
// --dangerously-load-development-channels is what makes a client render, and it lives on the parent
// `claude` process's command line, so inboundDecide() reads the ancestor chain and turns inbound on
// by itself. An explicit ZALO_INBOUND still overrides (force on/off). See core/render-detect.ts.
const inbound = inboundDecide()
if (inbound.on) {
  log(`inbound enabled (${inbound.reason}) — this session answers Zalo messages`)
  inboundPoll(SESSION_ID)
} else {
  log(`inbound disabled (${inbound.reason}) — launch with --dangerously-load-development-channels plugin:zalo@imrim12 to answer Zalo, or set ZALO_INBOUND=1`)
}
permissionPoll()

// Proxy dies with its session — no Zalo state to release, just stop cleanly. The daemon keeps
// running.
function shutdown(): void { process.exit(0) }
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)
