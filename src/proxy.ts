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
import { log } from './utils/log.ts'

const SESSION_ID = `${process.pid}-${randomBytes(3).toString('hex')}`
db()                                  // open shared DB (WAL)

process.on('unhandledRejection', e => log(`unhandled rejection: ${e}`))
process.on('uncaughtException', e => log(`uncaught exception: ${e}`))

toolsRegister()
permissionRelay(SESSION_ID)
await mcp.connect(new StdioServerTransport())

void daemonEnsure()                   // bring the daemon up if it isn't (non-blocking)

// Only a session explicitly marked as the Zalo responder claims inbound messages.
// Claude Code never tells a plugin whether the session was launched with
// --dangerously-load-development-channels, and advertises identical MCP capabilities + env
// either way — so a proxy cannot auto-detect whether ITS client will actually render channel
// notifications. Without this gate, every concurrent Claude session (including unrelated
// projects with no channel flag) races to claim each inbound row via the atomic messageClaim;
// a session whose client silently drops channel notifications would "win" the claim and
// black-hole the message. ZALO_INBOUND makes the answering session deterministic and opt-in.
if (inboundEnabled()) {
  log('inbound enabled (ZALO_INBOUND) — this session answers Zalo messages')
  inboundPoll(SESSION_ID)
} else {
  log('inbound disabled — set ZALO_INBOUND=1 (alongside --dangerously-load-development-channels) to make this session answer Zalo')
}
permissionPoll()

// A session claims inbound only when opted in via ZALO_INBOUND (truthy, not '0'/'false').
function inboundEnabled(): boolean {
  const v = process.env.ZALO_INBOUND
  return v != null && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}

// Proxy dies with its session — no Zalo state to release, just stop cleanly. The daemon keeps
// running.
function shutdown(): void { process.exit(0) }
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)
