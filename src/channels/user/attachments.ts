// Attachments arrive as one 'message' event with an object content carrying a
// CDN href — Telegram's per-kind bot.on handlers collapse into this mapping.
import { writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'fs'
import { join } from 'path'
import type { Message, TMessage } from 'zca-js'
import { INBOX_DIR } from '../../constants/paths.ts'
import { getApi } from './session.ts'
import { log } from '../../utils/log.ts'

export function attachmentKind(msgType: string): string | undefined {
  switch (msgType) {
    case 'chat.photo': return 'photo'
    case 'chat.gif': return 'gif'
    case 'chat.sticker': return 'sticker'
    case 'chat.voice': return 'voice'
    case 'chat.video.msg': return 'video'
    case 'share.file': return 'document'
    default: return undefined
  }
}

export function attachmentHref(data: TMessage): string | undefined {
  const c = data.content
  if (c && typeof c === 'object' && 'href' in c && typeof c.href === 'string' && c.href) {
    return c.href
  }
  return undefined
}

export function attachmentTitle(data: TMessage): string | undefined {
  const c = data.content
  if (c && typeof c === 'object' && 'title' in c && typeof c.title === 'string' && c.title) {
    return c.title
  }
  return undefined
}

// Raw zca content.params — carries photo/media keys (and possibly an encryption
// key). Persisted at ingest so a download from any session/after-restart has
// what it needs. Phase 5 decides whether it's needed to actually fetch bytes.
export function attachmentParams(data: TMessage): string | undefined {
  const c = data.content
  if (c && typeof c === 'object' && 'params' in c && typeof c.params === 'string' && c.params) {
    return c.params
  }
  return undefined
}

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

// Build the Cookie header for the CDN URL from the live session jar. Zalo CDN
// often requires the session cookie (not just a UA) for full-res media — using
// the jar's domain-scoped serializer (not a blind join of every cookie) sends
// only what belongs to that host. Best-effort: no jar → no Cookie header.
function cookieHeaderFor(url: string): string | undefined {
  const api = getApi()
  if (!api) return undefined
  try {
    const s = api.getCookie().getCookieStringSync(url)
    return s || undefined
  } catch { return undefined }
}

// Media-decryption hook (verification V2). Outcome (a) — the href is plain — this
// is a no-op. Outcome (b) — Zalo E2E-encrypts the bytes and `att_params` carries
// the key — implement the decrypt here. LIVE-UNVERIFIED: confirm against a real
// photo/file before assuming (a); if downloaded images are garbled, the bytes are
// encrypted and this is where the key (parsed from `params`) gets applied.
function maybeDecrypt(buf: Buffer, _params?: string): Buffer {
  return buf
}

// The inbox is where attachment BYTES land so Claude can Read them — it is
// not chat history; inbound text only ever flows through channel notifications.
export async function downloadToInbox(url: string, ext: string, idHint: string, params?: string): Promise<string> {
  const api = getApi()
  const headers: Record<string, string> = {}
  if (api) headers['User-Agent'] = api.getContext().userAgent
  const cookie = cookieHeaderFor(url)
  if (cookie) headers['Cookie'] = cookie

  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  let buf: Buffer = Buffer.from(await res.arrayBuffer())
  buf = maybeDecrypt(buf, params)
  if (buf.length > MAX_ATTACHMENT_BYTES) throw new Error('attachment exceeds 50MB cap')
  // ext is derived from sender-controlled names/URLs — strip to safe chars so
  // nothing downstream can be tricked by an unexpected extension.
  const safeExt = ext.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const uniqueId = idHint.replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
  const path = join(INBOX_DIR, `${Date.now()}-${uniqueId}.${safeExt}`)
  mkdirSync(INBOX_DIR, { recursive: true })
  writeFileSync(path, buf)
  return path
}

// 24/7 accumulation guard (objection A12): drop inbox files older than maxAgeMs,
// then enforce a total-size cap oldest-first. Called from the daemon's hourly
// retention tick. Best-effort — a failed unlink just leaves the file for next pass.
export function pruneInbox(maxAgeMs: number, maxBytes: number): void {
  let entries: Array<{ path: string; mtime: number; size: number }>
  try {
    entries = readdirSync(INBOX_DIR).map(name => {
      const path = join(INBOX_DIR, name)
      const st = statSync(path)
      return { path, mtime: st.mtimeMs, size: st.size }
    })
  } catch { return }   // inbox not created yet

  const now = Date.now()
  const survivors: typeof entries = []
  for (const e of entries) {
    if (now - e.mtime > maxAgeMs) {
      try { rmSync(e.path, { force: true }) } catch (err) { log(`inbox prune failed: ${err}`) }
    } else {
      survivors.push(e)
    }
  }

  let total = survivors.reduce((s, e) => s + e.size, 0)
  if (total <= maxBytes) return
  survivors.sort((a, b) => a.mtime - b.mtime)   // oldest first
  for (const e of survivors) {
    if (total <= maxBytes) break
    try { rmSync(e.path, { force: true }); total -= e.size } catch (err) { log(`inbox prune failed: ${err}`) }
  }
}

export function extFor(data: TMessage): string {
  const title = attachmentTitle(data)
  if (title?.includes('.')) return title.split('.').pop()!
  const href = attachmentHref(data)
  if (href) {
    try {
      const p = new URL(href).pathname
      if (p.includes('.')) return p.split('.').pop()!
    } catch { }
  }
  return data.msgType === 'chat.photo' ? 'jpg' : 'bin'
}

export function messageText(message: Message): string {
  const c = message.data.content
  if (typeof c === 'string') return c
  const kind = attachmentKind(message.data.msgType) ?? message.data.msgType
  const name = safeName(attachmentTitle(message.data))
  return name ? `(${kind}: ${name})` : `(${kind})`
}

// Display names are sender-controlled. They land inside the <channel>
// notification — delimiter chars would let the sender break out of the tag
// or forge a second meta entry.
export function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>[\]\r\n;]/g, '_')
}
