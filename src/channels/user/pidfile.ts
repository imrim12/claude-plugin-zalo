// Zalo allows one web-session listener per account slot. If a previous session
// crashed (SIGKILL, terminal closed) its server grandchild can survive as an
// orphan holding the slot — every new session then gets kicked with
// DuplicateConnection. Kill any stale holder before we start listening.
import { readFileSync, writeFileSync, rmSync } from 'fs'
import { PID_FILE } from '../../constants/paths.ts'
import { log } from '../../utils/log.ts'

export function takeOverPidFile(): void {
  try {
    const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
    if (stale > 1 && stale !== process.pid) {
      process.kill(stale, 0)
      log(`replacing stale listener pid=${stale}`)
      process.kill(stale, 'SIGTERM')
    }
  } catch { }
  writeFileSync(PID_FILE, String(process.pid))
}

// Only remove the PID file if it is still ours — a newer instance may have
// taken over while we were shutting down.
export function releasePidFile(): void {
  try {
    if (parseInt(readFileSync(PID_FILE, 'utf8'), 10) === process.pid) rmSync(PID_FILE)
  } catch { }
}
