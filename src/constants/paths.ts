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

// Conversation memory lives in the project's `.claude/memory` (NOT the
// channels state dir) so it sits alongside any other project memory the user
// keeps. Same adopt-only rule as STATE_DIR: project-local when the session has
// a `.claude/` folder, else the user root. ZALO_STATE_DIR collapses it for tests.
function resolveMemoryDir(): string {
  if (process.env.ZALO_STATE_DIR) return join(process.env.ZALO_STATE_DIR, 'memory')

  const projectDir = process.env.CLAUDE_PROJECT_DIR
  if (projectDir && isDir(join(projectDir, '.claude'))) {
    return join(projectDir, '.claude', 'memory')
  }

  return join(homedir(), '.claude', 'memory')
}

export const HOME_STATE_DIR = resolveHomeStateDir()
export const STATE_DIR = resolveStateDir()

// Authentication (account-global) → user root.
export const CREDENTIALS_FILE = join(HOME_STATE_DIR, 'credentials.json')
export const QR_PATH = join(HOME_STATE_DIR, 'qr-login.png')

// Per-session chat state no longer exists separately — the daemon is
// account-global, so everything that used to be per-project (access, approvals,
// inbox) now lives at the user root alongside credentials. The per-project
// adopt rule for access created a "whose policy wins" ambiguity (objection A9);
// removing it makes the daemon the sole policy authority. ZALO_STATE_DIR still
// collapses both roots for tests.
export const ACCESS_FILE = join(HOME_STATE_DIR, 'access.json')
export const APPROVED_DIR = join(HOME_STATE_DIR, 'approved')
export const INBOX_DIR = join(HOME_STATE_DIR, 'inbox')

// SQLite message log — canonical record + the IPC bus between the daemon
// (single writer of inbound + outbound results) and the proxies (claim inbound,
// enqueue outbound).
export const DB_FILE = join(HOME_STATE_DIR, 'messages.db')

// Daemon single-instance lock + log file (the daemon runs detached and must not
// inherit a proxy's stdio — it logs to its own file instead).
export const LOCK_FILE = join(HOME_STATE_DIR, 'daemon.lock')
export const DAEMON_LOG = join(HOME_STATE_DIR, 'daemon.log')

// Conversation transcripts the server appends to (the deterministic half of
// the secretary log). Created lazily on first write — never mkdir'd at boot,
// so directories that don't receive Zalo traffic stay clean.
export const MEMORY_DIR = resolveMemoryDir()
export const ZALO_LOG_DIR = join(MEMORY_DIR, 'zalo')

// In static mode, access is snapshotted at boot and never re-read or written.
export const STATIC = process.env.ZALO_ACCESS_MODE === 'static'

// Only the account-global root holds files now (access, db, lock, inbox,
// approvals, credentials). STATE_DIR is kept only as the CLAUDE_PROJECT_DIR
// anchor for memory resolution — it never gets its own files, so don't mkdir it.
mkdirSync(HOME_STATE_DIR, { recursive: true, mode: 0o700 })
