import { readFileSync } from 'fs'
import { join } from 'path'
import { unprocessedForChat, type MessageRow } from './db.ts'
import { MEMORY_DIR } from '../constants/paths.ts'

export type BuiltContext = { content: string; watermarkId: number }

// "Feed the recent memory + all the recent (unprocessed) messages as previous chat." The
// unmentioned lead-up never woke the LLM, so it's pulled from the DB now and prefixed to the
// triggering message. Memory snippet = the session's own summarized notes for this chat, if any.
export function buildContext(trigger: MessageRow): BuiltContext {
  const lead = unprocessedForChat(trigger.chat_id, trigger.id)   // includes the trigger row itself
  const watermarkId = lead.length ? lead[lead.length - 1]!.id : trigger.id

  const prior = lead.filter(m => m.id !== trigger.id)
  const lines = prior.map(m => `  ${m.ts_iso} ${m.sender_name ?? m.sender_id}: ${oneLine(m.text)}${attHint(m)}`)

  const memory = readMemorySnippet(trigger.chat_id)
  const parts: string[] = []
  if (memory) parts.push(`[memory — what you know about this chat]\n${memory}`)
  if (lines.length) parts.push(`[previous messages in this chat you have not yet replied to]\n${lines.join('\n')}`)
  parts.push(`[new message]\n${trigger.text}`)
  return { content: parts.join('\n\n'), watermarkId }
}

function oneLine(s: string): string { return s.replace(/[\r\n]+/g, ' ').trim() }

// Attachment rows in the lead-up aren't auto-downloaded (observe-only stance), so tell Claude
// how to pull the bytes on demand. The trigger message's own photo is surfaced via image_path.
function attHint(m: MessageRow): string {
  if (!m.att_kind) return ''
  if (m.att_kind === 'photo') return ` [photo — download_attachment message_id=${m.msg_id}]`
  return ` [${m.att_kind}${m.att_title ? `: ${m.att_title}` : ''} — download_attachment message_id=${m.msg_id}]`
}

// Best-effort: the secretary keeps per-chat notes under <project>/.claude/memory/zalo/. Read a
// small tail if present; never fail delivery over a missing note.
function readMemorySnippet(chatId: string): string | undefined {
  const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown'
  try {
    const txt = readFileSync(join(MEMORY_DIR, 'zalo', `${safe}.md`), 'utf8')
    return txt.length > 1500 ? txt.slice(-1500) : txt
  } catch { return undefined }
}
