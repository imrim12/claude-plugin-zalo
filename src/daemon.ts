// The Zalo daemon: single-instance, owns the Zalo connection + SQLite, drains
// outbound, publishes health. Started by a Scheduled Task (Phase 4) or spawned as
// a fallback by a proxy. Never inherits stdio — logs to a file (objection A14).
import { acquireDaemonLock, releaseDaemonLock } from './core/lock.ts'
import {
  setInboundHandler, cookieLogin, isShuttingDown, markShuttingDown, getWsState,
} from './channels/user/session.ts'
import { ingest, drainOutbound } from './channels/user/daemon-runtime.ts'
import { pruneInbox } from './channels/user/attachments.ts'
import { startApprovalPolling } from './channels/user/approvals.ts'
import { db, setMeta, pruneOld } from './core/db.ts'
import { log } from './utils/log.ts'

if (!acquireDaemonLock()) { log('another daemon holds the lock — exiting'); process.exit(0) }

process.on('unhandledRejection', err => log(`unhandled rejection: ${err}`))
process.on('uncaughtException', err => log(`uncaught exception: ${err}`))

db()                              // open + migrate up front
setInboundHandler(ingest)
startApprovalPolling()
void cookieLogin()

const BOOT = Date.now()
setMeta('instance_id', `${process.pid}-${BOOT}`)
setMeta('started_at', String(BOOT))
// Write an initial heartbeat immediately so a proxy starting in the first few
// seconds of daemon life sees it as alive and doesn't spawn a needless fallback
// (the interval below only fires its first tick after TICK ms).
setMeta('heartbeat', String(BOOT))

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
  if (now - lastTick > TICK * 5) { log('clock jump (resume from sleep?) — nudging reconnect'); void cookieLogin() }
  lastTick = now
  setMeta('heartbeat', String(now))
  setMeta('ws_state', getWsState())          // 'connected'|'kicked'|'reconnecting'|'disconnected'
}, TICK)

// Outbound drain loop + retention (DB rows + inbox bytes).
setInterval(() => { void drainOutbound() }, 500)
setInterval(() => {
  pruneOld(14 * 24 * 60 * 60 * 1000)
  pruneInbox(14 * 24 * 60 * 60 * 1000, 500 * 1024 * 1024)
}, 60 * 60 * 1000)

function shutdown(): void {
  if (isShuttingDown()) return
  markShuttingDown()
  releaseDaemonLock()
  setTimeout(() => process.exit(0), 1500).unref()
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown)
log('daemon up')
