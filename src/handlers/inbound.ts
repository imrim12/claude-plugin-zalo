// Inbound message pipeline: hard self-filter → cache → gate → pairing
// auto-reply OR deliver to the session as a channel notification.
import { ThreadType, type Message } from 'zca-js'
import { mcp } from '../core/mcp.ts'
import { getApi } from '../channels/user/session.ts'
import { gate } from '../channels/user/gate.ts'
import { cacheMessage } from '../channels/user/message-cache.ts'
import { tryHandlePermissionReply } from './permissions.ts'
import { logInbound } from './transcript.ts'
import { toReaction } from '../channels/user/reactions.ts'
import {
  attachmentKind,
  attachmentHref,
  attachmentTitle,
  downloadToInbox,
  extFor,
  messageText,
  safeName,
} from '../channels/user/attachments.ts'
import { log } from '../utils/log.ts'

// Pairing auto-replies must never answer something that itself looks like a
// pairing instruction — two plugin instances DMing each other would ping-pong
// codes forever. (Telegram is immune: bots can't DM other bots.)
const PAIRING_SHAPE_RE = /access pair [0-9a-f]{6}/i

export async function handleInbound(message: Message): Promise<void> {
  // Hard self filter — selfListen is off, but never trust it alone. Without
  // this, pairing mode would auto-reply codes to everyone the user messages
  // from their phone (uidFrom "0" is Zalo's alias for "self").
  if (message.isSelf || message.data.uidFrom === '0') return

  const text = messageText(message)
  cacheMessage(message)

  const result = gate(message)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    if (PAIRING_SHAPE_RE.test(text)) return
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await getApi()?.sendMessage(
      `${lead} — run in Claude Code:\n\n/zalo:access pair ${result.code}`,
      message.threadId,
      message.type,
    )
    return
  }

  const access = result.access
  // respond=false → observe only: deliver + log for memory, but no reply is
  // expected (an unmentioned group message). Skip the "processing" signals.
  const respond = result.respond
  const chat_id = message.threadId
  const msgId = message.data.msgId

  if (respond) {
    // The sender is already gate()-approved at this point, so permission
    // replies ("yes xxxxx") are trusted and intercepted instead of relayed.
    if (tryHandlePermissionReply(text, message)) return

    // Typing indicator — signals "processing" until we reply (or it times out).
    void getApi()?.sendTypingEvent(chat_id, message.type).catch(() => { })

    // Ack reaction — lets the user know we're processing. Fire-and-forget.
    if (access.ackReaction) {
      try {
        void getApi()?.addReaction(toReaction(access.ackReaction), {
          data: { msgId: message.data.msgId, cliMsgId: message.data.cliMsgId },
          threadId: chat_id,
          type: message.type,
        }).catch(() => { })
      } catch { } // unmappable configured reaction — swallow
    }
  }

  // Photos auto-download to the inbox so Claude can Read them inline. Only when
  // we're going to respond — observe-only messages don't warrant burning
  // bandwidth or filling the inbox (the attachment_kind meta still records it,
  // and Claude can call download_attachment if a memory note needs the bytes).
  let imagePath: string | undefined
  const kind = attachmentKind(message.data.msgType)
  const href = attachmentHref(message.data)
  if (respond && kind === 'photo' && href) {
    try {
      imagePath = await downloadToInbox(href, extFor(message.data), msgId)
    } catch (err) {
      log(`photo download failed: ${err}`)
    }
  }

  const ts = Number(message.data.ts)
  const tsIso = Number.isFinite(ts) ? new Date(ts).toISOString() : new Date().toISOString()
  const user = safeName(message.data.dName) ?? message.data.uidFrom
  const attachmentDesc = kind
    ? (attachmentTitle(message.data) ? `${kind}: ${safeName(attachmentTitle(message.data))}` : kind)
    : undefined

  // Deterministic transcript — every delivered message, responded or observed.
  logInbound({
    chatId: chat_id,
    threadType: message.type === ThreadType.Group ? 'group' : 'user',
    user,
    userId: message.data.uidFrom,
    text,
    ts: tsIso,
    responded: respond,
    attachment: attachmentDesc,
  })

  // image_path goes in meta only — an in-content "[image attached — read: PATH]"
  // annotation is forgeable by any allowlisted sender typing that string.
  mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: {
        chat_id,
        thread_type: message.type === ThreadType.Group ? 'group' : 'user',
        // should_reply=false tells Claude to record this to memory and stay
        // silent (an unmentioned group message it's observing as secretary).
        should_reply: respond,
        ...(msgId ? { message_id: msgId } : {}),
        user,
        user_id: message.data.uidFrom,
        ts: tsIso,
        ...(imagePath ? { image_path: imagePath } : {}),
        ...(kind && kind !== 'photo' && href ? {
          attachment_kind: kind,
          ...(attachmentTitle(message.data) ? { attachment_name: safeName(attachmentTitle(message.data)) } : {}),
        } : {}),
      },
    },
  }).catch(err => {
    log(`failed to deliver inbound to Claude: ${err}`)
  })
}
