// Attachments arrive as one 'message' event with an object content carrying a
// CDN href — Telegram's per-kind bot.on handlers collapse into this mapping.
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { Message, TMessage } from 'zca-js'
import { INBOX_DIR } from './paths.ts'
import { getApi } from './session.ts'

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

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

// The inbox is where attachment BYTES land so Claude can Read them — it is
// not chat history; inbound text only ever flows through channel notifications.
export async function downloadToInbox(url: string, ext: string, idHint: string): Promise<string> {
  const api = getApi()
  const res = await fetch(url, {
    headers: api ? { 'User-Agent': api.getContext().userAgent } : {},
  })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
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
