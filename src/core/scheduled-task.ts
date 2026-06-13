// Daemon lifecycle on the OS. The real 24/7 path is a Windows Scheduled Task (logon trigger +
// restart-on-failure); everywhere else (and when no task is installed) a detached spawn keeps
// the daemon running for the session. The daemon must launch with NO inherited stdio
// (objection A14) and its own log file — inheriting the proxy's stdout would corrupt the MCP
// transport (same class as the --silent bug).
import { spawn, spawnSync } from 'child_process'
import { openSync } from 'fs'
import { fileURLToPath } from 'url'
import { DAEMON_LOG } from '../constants/paths.ts'
import { log } from '../utils/log.ts'

const TASK_NAME = 'ClaudeZaloDaemon'
const daemonEntry = (): string => fileURLToPath(new URL('../daemon.ts', import.meta.url))
const bunExe = (): string => process.execPath   // the bun running us

// Fallback used on POSIX and when no task is installed: fully detached child that outlives us,
// stdio → log file (never the proxy's stdout, which is the MCP transport).
export function spawnDaemonFallback(): void {
  try {
    const out = openSync(DAEMON_LOG, 'a')
    const child = spawn(bunExe(), [daemonEntry()], {
      detached: true, stdio: ['ignore', out, out], windowsHide: true,
      env: { ...process.env },
    })
    child.unref()
    log(`spawned daemon fallback pid=${child.pid}`)
  } catch (e) { log(`daemon fallback spawn failed: ${e}`) }
}

// Windows: run the installed task now (if present). Returns false if not on Windows or the
// task isn't installed, so the caller falls back to spawn.
export function startDaemonViaScheduledTask(): boolean {
  if (process.platform !== 'win32') return false
  return runSync('schtasks', ['/run', '/tn', TASK_NAME]) === 0
}

export function isScheduledTaskInstalled(): boolean {
  if (process.platform !== 'win32') return false
  return runSync('schtasks', ['/query', '/tn', TASK_NAME]) === 0
}

// Install: register a logon-triggered, restart-on-failure task. Uses an XML definition because
// schtasks' flag form can't express RestartOnFailure. Run by /zalo:auth after a successful
// login (the skill runs the returned PowerShell so any UAC prompt is visible to the user).
export function installScheduledTaskXml(): string {
  return [
    `$xml = @'`,
    scheduledTaskXml(bunExe(), daemonEntry()),
    `'@`,
    `$p = Join-Path $env:TEMP 'claude-zalo-task.xml'`,
    `Set-Content -Path $p -Value $xml -Encoding Unicode`,
    `schtasks /create /tn "${TASK_NAME}" /xml "$p" /f`,
  ].join('\n')
}

function scheduledTaskXml(bun: string, entry: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions><Exec><Command>${bun}</Command><Arguments>"${entry}"</Arguments></Exec></Actions>
</Task>`
}

function runSync(cmd: string, args: string[]): number {
  try { const { status } = spawnSync(cmd, args, { stdio: 'ignore' }); return status ?? 1 }
  catch { return 1 }
}
