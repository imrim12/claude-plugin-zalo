// State-dir layout. Everything the plugin persists lives under STATE_DIR
// (~/.claude/channels/zalo, overridable via ZALO_STATE_DIR for tests).
import { mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const STATE_DIR = process.env.ZALO_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'zalo')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const CREDENTIALS_FILE = join(STATE_DIR, 'credentials.json')
export const QR_PATH = join(STATE_DIR, 'qr-login.png')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const PID_FILE = join(STATE_DIR, 'bot.pid')

// In static mode, access is snapshotted at boot and never re-read or written.
export const STATIC = process.env.ZALO_ACCESS_MODE === 'static'

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
