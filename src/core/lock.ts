// Single-instance lock for the daemon. Atomic create-exclusive ('wx'); if the lock exists,
// reclaim it only when the recorded PID is dead. PID reuse is mitigated because the daemon
// also writes a fresh heartbeat to meta — callers that need liveness check the heartbeat, not
// this PID (objection A4). The held fd is kept open for the process lifetime.
import { openSync, readFileSync, writeFileSync, rmSync, closeSync } from 'fs'
import { LOCK_FILE } from '../constants/paths.ts'

let heldFd: number | null = null

export function lockCreate(): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      heldFd = openSync(LOCK_FILE, 'wx')      // atomic: fails if file exists
      writeFileSync(heldFd, String(process.pid))
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const holder = readStalePid()
      if (holder !== null && isAlive(holder)) return false   // a live daemon owns it
      // Stale (holder dead or unreadable) — remove and retry once.
      try { rmSync(LOCK_FILE) } catch { }
    }
  }
  return false
}

export function lockDelete(): void {
  try { if (heldFd !== null) closeSync(heldFd) } catch { }
  try { if (readStalePid() === process.pid) rmSync(LOCK_FILE) } catch { }
  heldFd = null
}

function readStalePid(): number | null {
  try { const n = parseInt(readFileSync(LOCK_FILE, 'utf8'), 10); return Number.isFinite(n) ? n : null } catch { return null }
}
function isAlive(pid: number): boolean {
  if (pid <= 1 || pid === process.pid) return pid === process.pid
  try { process.kill(pid, 0); return true } catch { return false }
}
