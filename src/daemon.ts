// The Zalo daemon: single-instance, owns the Zalo connection + SQLite, drains
// outbound, publishes health. Spawned on demand (detached) by a proxy that finds
// no live daemon. Never inherits stdio — logs to a file (objection A14).
import { lockCreate, lockDelete } from './core/lock.ts'
import {
  sessionOnInbound, sessionLogin, sessionShuttingDown, sessionClose, sessionState,
} from './channels/user/session.ts'
import { ingest, drainOutbound } from './channels/user/daemon-runtime.ts'
import { attachmentPrune } from './channels/user/attachments.ts'
import { approvalPoll } from './channels/user/approvals.ts'
import { db, metaUpdate, dbPrune } from './core/db/index.ts'
import { log } from './utils/log.ts'

if (!lockCreate()) { log('another daemon holds the lock — exiting'); process.exit(0) }

process.on('unhandledRejection', err => log(`unhandled rejection: ${err}`))
process.on('uncaughtException', err => log(`uncaught exception: ${err}`))

db()                              // open + migrate up front
sessionOnInbound(ingest)
approvalPoll()
void sessionLogin()

const BOOT = Date.now()
metaUpdate('instance_id', `${process.pid}-${BOOT}`)
metaUpdate('started_at', String(BOOT))
// Write an initial heartbeat immediately so a proxy starting in the first few
// seconds of daemon life sees it as alive and doesn't spawn a needless fallback
// (the interval below only fires its first tick after TICK ms).
metaUpdate('heartbeat', String(BOOT))

// Heartbeat + health. Proxies read `heartbeat` to decide if the daemon is alive;
// /zalo:status reads ws_state + last_inbound_at. Also the sleep/resume guard
// (objection A13): a large jump between expected and actual fire time means the
// machine slept — nudge a clean reconnect.
// NOTE: these intervals are intentionally NOT unref'd. Unlike the proxy (kept
// alive by its stdio MCP transport), the daemon has no other handle holding the
// event loop open — a daemon must block exit and run until signalled.
const TICK = 3000
let lastTick = Date.now()
setInterval(() => {
  const now = Date.now()
  if (now - lastTick > TICK * 5) { log('clock jump (resume from sleep?) — nudging reconnect'); void sessionLogin() }
  lastTick = now
  metaUpdate('heartbeat', String(now))
  metaUpdate('ws_state', sessionState())          // 'connected'|'kicked'|'reconnecting'|'disconnected'
}, TICK)

// Outbound drain loop + retention (DB rows + inbox bytes).
setInterval(() => { void drainOutbound() }, 500)
setInterval(() => {
  dbPrune(14 * 24 * 60 * 60 * 1000)
  attachmentPrune(14 * 24 * 60 * 60 * 1000, 500 * 1024 * 1024)
}, 60 * 60 * 1000)

function shutdown(): void {
  if (sessionShuttingDown()) return
  sessionClose()
  lockDelete()
  setTimeout(() => process.exit(0), 1500).unref()
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown)
log('daemon up')
