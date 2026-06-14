/**
 * Does THIS session's Claude Code client actually render Zalo channel notifications?
 *
 * Claude Code only renders channel notifications from a plugin when the session was launched with
 * `--dangerously-load-development-channels plugin:zalo@imrim12` (until the plugin is on Anthropic's
 * approved allowlist). It never surfaces that flag to the plugin via env or MCP capabilities — but
 * the flag lives on the launching `claude` process's command line, and a proxy can read its own
 * ancestor chain to find it. That makes the "is this the responder?" question answerable WITHOUT a
 * manual `ZALO_INBOUND=1` opt-in.
 *
 * `inboundDecide()` is the single decision point: an explicit `ZALO_INBOUND` always wins (force
 * on/off — power users running several responders, or tests); otherwise we auto-detect from the
 * process tree. Detection is best-effort and fail-closed: any error → inbound off (same as a
 * session with no flag), never a false positive that would black-hole a message.
 */
import { spawnSync } from 'child_process'
import { readdirSync, readFileSync } from 'fs'
import { log } from '../utils/log.ts'

export interface InboundDecision { on: boolean; reason: string }

const NUL = String.fromCharCode(0)

// Explicit env override wins; otherwise auto-detect the dev-channel flag on the parent chain.
export function inboundDecide(): InboundDecision {
  const v = process.env.ZALO_INBOUND
  if (v != null && v !== '') {
    const on = v !== '0' && v.toLowerCase() !== 'false'
    return { on, reason: `ZALO_INBOUND=${v} (explicit override)` }
  }
  // Tests (and any embedded/non-interactive run) set ZALO_NO_DAEMON_SPAWN — skip the process
  // probe there so the suite stays fast and never shells out to PowerShell/ps.
  if (process.env.ZALO_NO_DAEMON_SPAWN === '1') {
    return { on: false, reason: 'auto-detect skipped (ZALO_NO_DAEMON_SPAWN)' }
  }
  if (rendersZaloChannel()) {
    return { on: true, reason: 'auto-detected --dangerously-load-development-channels on parent process' }
  }
  return { on: false, reason: 'no zalo dev-channel flag on parent process chain' }
}

// Walk up the ancestor chain from this proxy looking for a process launched with the Zalo
// dev-channel flag. Depth-capped (claude → bun run → bun server.ts is ~2-3 levels; allow slack).
function rendersZaloChannel(): boolean {
  try {
    const table = processTable()
    let pid = process.ppid
    for (let depth = 0; depth < 8 && pid > 1; depth++) {
      const row = table.get(pid)
      if (!row) break
      if (matchesDevChannel(row.cmd)) return true
      pid = row.ppid
    }
  } catch (e) {
    log(`inbound auto-detect failed (${e}) — treating session as non-responder`)
  }
  return false
}

// The launch flag plus a zalo channel ref on the same command line. A session that loaded only
// another plugin as a dev channel (e.g. telegram) won't render zalo, so the `zalo` token is required.
function matchesDevChannel(cmd: string): boolean {
  const c = cmd.toLowerCase()
  return c.includes('dangerously-load-development-channels') && c.includes('zalo')
}

interface ProcRow { ppid: number; cmd: string }

function processTable(): Map<number, ProcRow> {
  if (process.platform === 'linux') return procTableLinux()
  if (process.platform === 'win32') return procTableWindows()
  return procTablePs() // darwin & other POSIX
}

// Linux: read /proc directly — no child process. ppid is field 4 of stat, but comm (field 2) can
// contain spaces/parens, so parse after the final ')'.
function procTableLinux(): Map<number, ProcRow> {
  const m = new Map<number, ProcRow>()
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const ppid = Number(after[1]) // state, ppid, ...
      const cmd = readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split(NUL).join(' ').trim()
      m.set(pid, { ppid, cmd })
    } catch { /* process gone or unreadable */ }
  }
  return m
}

// Windows: one CIM query for the whole process table, as JSON (robust to spaces/quotes in cmdlines).
function procTableWindows(): Map<number, ProcRow> {
  const m = new Map<number, ProcRow>()
  const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    windowsHide: true, encoding: 'utf8', timeout: 6000, maxBuffer: 16 * 1024 * 1024,
  })
  if (!res.stdout) return m
  const parsed = JSON.parse(res.stdout)
  for (const p of Array.isArray(parsed) ? parsed : [parsed]) {
    m.set(Number(p.ProcessId), { ppid: Number(p.ParentProcessId), cmd: String(p.CommandLine ?? '') })
  }
  return m
}

// macOS / other POSIX: one `ps` snapshot — `pid ppid command`, command is the rest of the line.
function procTablePs(): Map<number, ProcRow> {
  const m = new Map<number, ProcRow>()
  const res = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 6000, maxBuffer: 16 * 1024 * 1024 })
  for (const line of (res.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match) m.set(Number(match[1]), { ppid: Number(match[2]), cmd: match[3] })
  }
  return m
}
