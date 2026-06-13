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
import { db } from './core/db.ts'
import { registerTools } from './handlers/tools.ts'
import { registerPermissionRelay, startPermissionPoller } from './handlers/permissions.ts'
import { startInboundPoller } from './handlers/inbound-poller.ts'
import { ensureDaemon } from './core/daemon-ensure.ts'
import { log } from './utils/log.ts'

const SESSION_ID = `${process.pid}-${randomBytes(3).toString('hex')}`
db()                                  // open shared DB (WAL)

process.on('unhandledRejection', e => log(`unhandled rejection: ${e}`))
process.on('uncaughtException', e => log(`uncaught exception: ${e}`))

registerTools()
registerPermissionRelay(SESSION_ID)
await mcp.connect(new StdioServerTransport())

void ensureDaemon()                   // bring the daemon up if it isn't (non-blocking)
startInboundPoller(SESSION_ID)
startPermissionPoller()

// Proxy dies with its session — no Zalo state to release, just stop cleanly. The daemon keeps
// running.
function shutdown(): void { process.exit(0) }
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)
