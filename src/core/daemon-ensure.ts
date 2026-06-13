import { getMeta } from './db.ts'
import { startDaemonViaScheduledTask, spawnDaemonFallback } from './scheduled-task.ts'
import { log } from '../utils/log.ts'

// Daemon liveness = a fresh heartbeat in meta (never trust a PID — objection A4). If stale,
// try the Scheduled Task first (the supported 24/7 path), then a detached spawn fallback.
export async function ensureDaemon(): Promise<void> {
  // Test guard: integration tests manage the daemon themselves (or don't need one)
  // — never let a spawned proxy fork a detached daemon that outlives the test and
  // keeps the temp DB file open (which would break temp-dir cleanup on Windows).
  if (process.env.ZALO_NO_DAEMON_SPAWN === '1') return
  if (isFresh()) return
  log('daemon not running — starting it')
  if (!startDaemonViaScheduledTask()) spawnDaemonFallback()
  for (let i = 0; i < 40; i++) { if (isFresh()) return; await Bun.sleep(250) }
  log('daemon did not report a heartbeat after start attempt — tools will error until it does')
}

function isFresh(): boolean {
  const hb = Number(getMeta('heartbeat') ?? 0)
  return Date.now() - hb < 15_000
}
