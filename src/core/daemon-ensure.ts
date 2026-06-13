import { spawn } from 'child_process'
import { openSync } from 'fs'
import { fileURLToPath } from 'url'
import { getMeta } from './db.ts'
import { DAEMON_LOG } from '../constants/paths.ts'
import { log } from '../utils/log.ts'

// Daemon liveness = a fresh heartbeat in meta (never trust a PID — objection A4). If stale, spawn
// a detached daemon. The daemon is **spawn-on-demand only** — there is no Scheduled Task path.
export async function ensureDaemon(): Promise<void> {
  // Test guard: integration tests manage the daemon themselves (or don't need one) — never let a
  // spawned proxy fork a detached daemon that outlives the test and keeps the temp DB file open
  // (which would break temp-dir cleanup on Windows).
  if (process.env.ZALO_NO_DAEMON_SPAWN === '1') return
  if (isFresh()) return
  log('daemon not running — starting it')
  spawnDaemon()
  for (let i = 0; i < 40; i++) { if (isFresh()) return; await Bun.sleep(250) }
  log('daemon did not report a heartbeat after start attempt — tools will error until it does')
}

// Spawn the daemon as a fully detached child that outlives this proxy, stdio → log file (never
// the proxy's stdout, which is the MCP transport). windowsHide prevents any console window.
function spawnDaemon(): void {
  try {
    const entry = fileURLToPath(new URL('../daemon.ts', import.meta.url))
    const out = openSync(DAEMON_LOG, 'a')
    const child = spawn(process.execPath, [entry], {
      detached: true, stdio: ['ignore', out, out], windowsHide: true,
      env: { ...process.env },
    })
    child.unref()
    log(`spawned daemon pid=${child.pid}`)
  } catch (e) { log(`daemon spawn failed: ${e}`) }
}

function isFresh(): boolean {
  const hb = Number(getMeta('heartbeat') ?? 0)
  return Date.now() - hb < 15_000
}
