// Daemon-side glue: turn Zalo 'message' events into SQLite rows (never an MCP
// notification — that's the proxy's job) and drain the outbound queue back out
// through the single Zalo connection the daemon owns.
import { ThreadType, Reactions, type Message, type SendMessageQuote, type TMessage } from 'zca-js'
import { getApi } from './session.ts'
import { gate } from './gate.ts'
import { toReaction } from './reactions.ts'
import {
  attachmentKind, attachmentHref, attachmentTitle, attachmentParams,
  downloadToInbox, extFor, messageText, safeName,
} from './attachments.ts'
import {
  insertMessage, takePendingOutbound, completeOutbound, getMessageByMsgId,
  setMessageLocalPath, recordPermResponse, setMeta, type OutboundRow, type MessageRow,
} from '../../core/db.ts'
import { loadAccess } from '../../core/access.ts'
import { beginQRLogin } from './session.ts'
import { log } from '../../utils/log.ts'

// Pairing auto-replies must never answer something that itself looks like a
// pairing instruction — two plugin instances DMing each other would ping-pong
// codes forever.
const PAIRING_SHAPE_RE = /access pair [0-9a-f]{6}/i

// Permission-reply spec from anthropics/claude-cli-internal channelPermissions.ts.
// 5 lowercase letters a-z minus 'l'. Case-insensitive for phone autocorrect.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// ── INGEST: Zalo 'message' → gate → DB. Never emits an MCP notification. ──
export async function ingest(message: Message): Promise<void> {
  if (message.isSelf || message.data.uidFrom === '0') return   // hard self-filter — never remove

  const text = messageText(message)
  const result = gate(message)
  if (result.action === 'drop') return

  if (result.action === 'pair') {
    if (PAIRING_SHAPE_RE.test(text)) return
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await getApi()?.sendMessage(`${lead} — run in Claude Code:\n\n/zalo:access pair ${result.code}`, message.threadId, message.type)
    return
  }

  const respond = result.respond

  // A gate-approved "yes xxxxx"/"no xxxxx" is a permission reply, not chat: record
  // the response for the owning proxy to pick up, ack it, and don't log a chat row.
  if (respond) {
    const perm = PERMISSION_REPLY_RE.exec(text)
    if (perm) {
      const allow = perm[1]!.toLowerCase().startsWith('y')
      recordPermResponse(perm[2]!.toLowerCase(), allow ? 'allow' : 'deny')
      void getApi()?.addReaction(allow ? Reactions.OK : Reactions.NO, {
        data: { msgId: message.data.msgId, cliMsgId: message.data.cliMsgId },
        threadId: message.threadId,
        type: message.type,
      }).catch(() => { })
      return
    }
  }

  const kind = attachmentKind(message.data.msgType)
  const href = attachmentHref(message.data)
  const ts = Number(message.data.ts)
  const tsIso = Number.isFinite(ts) ? new Date(ts).toISOString() : new Date().toISOString()

  // Photos for answerable messages download eagerly so image_path is ready when
  // delivered. Observe-only messages store the href and download on demand.
  let localPath: string | undefined
  if (respond && kind === 'photo' && href) {
    try { localPath = await downloadToInbox(href, extFor(message.data), message.data.msgId, attachmentParams(message.data)) }
    catch (err) { log(`photo download failed: ${err}`) }
  }

  insertMessage({
    msgId: message.data.msgId, cliMsgId: message.data.cliMsgId,
    chatId: message.threadId, threadType: message.type === ThreadType.Group ? 'group' : 'user',
    senderId: message.data.uidFrom, senderName: safeName(message.data.dName),
    text, msgType: message.data.msgType, shouldReply: respond,
    attKind: kind, attHref: href, attTitle: safeName(attachmentTitle(message.data)),
    attParams: attachmentParams(message.data),
    // Quote replies need the full TMessage (propertyExt/ttl aren't columns), so
    // stash the raw payload — the in-memory message-cache is gone, so this is how
    // quote/react survive a restart.
    quoteJson: safeStringify(message.data),
    localPath,
    ts: Number.isFinite(ts) ? ts : Date.now(), tsIso,
  })
  setMeta('last_inbound_at', String(Date.now()))
}

function safeStringify(data: TMessage): string | undefined {
  try { return JSON.stringify(data) } catch { return undefined }
}

// ── OUTBOUND DRAIN: send queued actions via the single Zalo connection. ──
export async function drainOutbound(): Promise<void> {
  const api = getApi()
  if (!api) return                      // not logged in yet — leave rows pending
  for (const o of takePendingOutbound()) {
    try {
      const result = await execOutbound(o, api)
      completeOutbound(o.id, 'sent', result,
        o.kind === 'reply' && o.chat_id && o.watermark_id != null ? { chatId: o.chat_id, watermarkId: o.watermark_id } : undefined)
    } catch (err) {
      completeOutbound(o.id, 'failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }
}

async function execOutbound(o: OutboundRow, api: NonNullable<ReturnType<typeof getApi>>): Promise<object> {
  const threadType = o.thread_type === 'group' ? ThreadType.Group : ThreadType.User
  switch (o.kind) {
    case 'reply': {
      // Chunking already done by the proxy: payload carries the pre-split chunks + quote flags.
      const { chunks, quoteMsgId } = JSON.parse(o.payload!) as { chunks: string[]; quoteMsgId?: string }
      const quote = quoteMsgId ? buildQuote(quoteMsgId) : undefined
      const sentIds: number[] = []
      for (let i = 0; i < chunks.length; i++) {
        const useQuote = quote && i === 0
        const sent = await api.sendMessage(useQuote ? { msg: chunks[i]!, quote } : { msg: chunks[i]! }, o.chat_id!, threadType)
        if (sent.message?.msgId != null) sentIds.push(sent.message.msgId)
      }
      return { sentIds }
    }
    case 'react': {
      const row = getMessageByMsgId(o.target_msg_id!)
      if (!row?.msg_id || !row.cli_msg_id) throw new Error('message not found for react')
      await api.addReaction(toReaction(o.emoji!), {
        data: { msgId: row.msg_id, cliMsgId: row.cli_msg_id },
        threadId: row.chat_id,
        type: row.thread_type === 'group' ? ThreadType.Group : ThreadType.User,
      })
      return { reacted: true }
    }
    case 'download': {
      const row = getMessageByMsgId(o.target_msg_id!)
      if (!row?.att_href) throw new Error('message has no downloadable attachment')
      let path = row.local_path
      if (!path) {
        path = await downloadToInbox(row.att_href, extForRow(row), row.msg_id!, row.att_params ?? undefined)
        setMessageLocalPath(row.id, path)
      }
      return { path }
    }
    case 'login': {
      const qrPath = await beginQRLogin()
      return { qrPath }
    }
    case 'permission_dm': {
      const access = loadAccess()
      const text = o.text!
      for (const chat of access.allowFrom) await api.sendMessage(text, chat, ThreadType.User).catch(e => log(`perm dm to ${chat} failed: ${e}`))
      return { sent: true }
    }
    default: throw new Error(`unknown outbound kind ${o.kind}`)
  }
}

// Reconstruct a SendMessageQuote from the stored raw payload. The DB columns
// alone are insufficient (propertyExt/ttl aren't stored separately), so we keep
// the full message.data as quote_json at ingest.
function buildQuote(msgId: string): SendMessageQuote | undefined {
  const row = getMessageByMsgId(msgId)
  if (!row?.quote_json) return undefined
  try {
    const d = JSON.parse(row.quote_json) as TMessage
    return {
      content: d.content, msgType: d.msgType, propertyExt: d.propertyExt,
      uidFrom: d.uidFrom, msgId: d.msgId, cliMsgId: d.cliMsgId, ts: d.ts, ttl: d.ttl,
    }
  } catch { return undefined }
}

// extForRow mirrors extFor but reads the persisted att_title/att_href off a row.
function extForRow(row: MessageRow): string {
  const title = row.att_title
  if (title?.includes('.')) return title.split('.').pop()!
  if (row.att_href) {
    try {
      const p = new URL(row.att_href).pathname
      if (p.includes('.')) return p.split('.').pop()!
    } catch { }
  }
  return row.att_kind === 'photo' ? 'jpg' : 'bin'
}
