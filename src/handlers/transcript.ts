// Deterministic half of the secretary log. The server appends every delivered
// inbound message to a per-chat markdown file under the project's
// `.claude/memory/zalo/` so there is always a complete record — independent of
// whether the interactive session is busy or follows its memory instructions.
// Claude maintains the *summarized* half (see core/mcp.ts instructions).
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { ZALO_LOG_DIR, STATIC } from '../constants/paths.ts'
import { log } from '../utils/log.ts'

export type TranscriptEntry = {
  chatId: string
  threadType: 'group' | 'user'
  /** Display name of the sender (already passed through safeName). */
  user: string
  userId: string
  /** Message text (or attachment placeholder). */
  text: string
  /** ISO timestamp. */
  ts: string
  /** Whether the secretary replied to this message (vs. observe-only). */
  responded: boolean
  /** Short attachment descriptor, e.g. "photo" or "document: report.pdf". */
  attachment?: string
}

// Chat ids are opaque numeric strings; sanitize defensively before using one as
// a filename so nothing can escape ZALO_LOG_DIR.
function logFileFor(chatId: string): string {
  const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown'
  return join(ZALO_LOG_DIR, `${safe}.md`)
}

// One markdown line per message. The display name is sender-controlled but has
// already been through safeName() upstream; we still strip newlines here so a
// single message can never span/forge multiple log lines.
function formatEntry(e: TranscriptEntry): string {
  const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim()
  const tag = e.responded ? '' : ' _(observed)_'
  const attach = e.attachment ? ` [${oneLine(e.attachment)}]` : ''
  return `- ${e.ts} — **${oneLine(e.user)}** (${e.userId})${tag}:${attach} ${oneLine(e.text)}\n`
}

export function logInbound(entry: TranscriptEntry): void {
  // In static mode the state dir is a read-only boot snapshot; treat memory the
  // same way and skip writes rather than scribbling into a sealed environment.
  if (STATIC) return
  try {
    mkdirSync(ZALO_LOG_DIR, { recursive: true, mode: 0o700 })
    const file = logFileFor(entry.chatId)
    if (!existsSync(file)) {
      const kind = entry.threadType === 'group' ? 'group' : 'direct chat'
      appendFileSync(
        file,
        `# Zalo ${kind} ${entry.chatId}\n\nAppend-only transcript kept by the Zalo channel server.\n\n`,
        { mode: 0o600 },
      )
    }
    appendFileSync(file, formatEntry(entry))
  } catch (err) {
    // Logging must never break delivery — a full disk or perms issue just costs
    // us the transcript line, not the message.
    log(`transcript log failed: ${err}`)
  }
}
