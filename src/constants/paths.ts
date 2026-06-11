// State-dir layout. The plugin keeps two roots:
//
//   HOME_STATE_DIR — the user-root `~/.claude/channels/zalo`. Everything tied to
//     AUTHENTICATION lives here (login credentials + the QR login image) because
//     the Zalo account is global: one QR scan should work across every project,
//     not be re-scanned per directory.
//
//   STATE_DIR — per-session chat state (access policy, pairings, attachment
//     inbox, listener pid). Resolved in this order:
//       1. ZALO_STATE_DIR — explicit override, used verbatim (tests, power users).
//       2. <project>/.claude/channels/zalo — when the session's project root
//          already contains a `.claude` folder. Claude Code exports
//          CLAUDE_PROJECT_DIR (the directory `claude` was launched in) into
//          every MCP server's env, so that's how the server learns the project
//          root. We only ADOPT an existing `.claude` — never create one.
//       3. ~/.claude/channels/zalo — the user-root default.
//
// When ZALO_STATE_DIR is set, BOTH roots collapse to it so tests stay fully
// isolated from the real home dir.
import { mkdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function userRootDir(): string {
  return join(homedir(), '.claude', 'channels', 'zalo')
}

function resolveHomeStateDir(): string {
  return process.env.ZALO_STATE_DIR ?? userRootDir()
}

function resolveStateDir(): string {
  if (process.env.ZALO_STATE_DIR) return process.env.ZALO_STATE_DIR

  const projectDir = process.env.CLAUDE_PROJECT_DIR
  if (projectDir && isDir(join(projectDir, '.claude'))) {
    return join(projectDir, '.claude', 'channels', 'zalo')
  }

  return userRootDir()
}

export const HOME_STATE_DIR = resolveHomeStateDir()
export const STATE_DIR = resolveStateDir()

// Authentication (account-global) → user root.
export const CREDENTIALS_FILE = join(HOME_STATE_DIR, 'credentials.json')
export const QR_PATH = join(HOME_STATE_DIR, 'qr-login.png')

// Per-session chat state → resolved (project-local) state dir.
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const PID_FILE = join(STATE_DIR, 'bot.pid')

// In static mode, access is snapshotted at boot and never re-read or written.
export const STATIC = process.env.ZALO_ACCESS_MODE === 'static'

mkdirSync(HOME_STATE_DIR, { recursive: true, mode: 0o700 })
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
