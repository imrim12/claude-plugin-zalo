// Permission relay: Claude Code asks "may I run tool X?" → we DM the
// allowlisted user(s) → their "yes <id>" / "no <id>" text reply comes back
// through the inbound handler and is emitted as a structured permission event.
import { z } from 'zod'
import { ThreadType, Reactions, type Message } from 'zca-js'
import { mcp } from '../core/mcp.ts'
import { loadAccess } from '../core/access.ts'
import { getApi } from '../channels/user/session.ts'
import { log } from '../utils/log.ts'

// Permission-reply spec from anthropics/claude-cli-internal
// src/services/mcp/channelPermissions.ts — inlined (no CC repo dep).
// 5 lowercase letters a-z minus 'l'. Case-insensitive for phone autocorrect.
// Strict: no bare yes/no (conversational), no prefix/suffix chatter.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// Stores full permission details keyed by request_id (kept for parity with the
// Telegram inline-keyboard flow; here the details ship in the DM directly).
const pendingPermissions = new Map<string, { tool_name: string; description: string; input_preview: string }>()

// Receive permission_request from CC → format → send to all allowlisted DMs.
// Groups are intentionally excluded — the security thread resolution was
// "single-user mode for official plugins." Anyone in access.allowFrom
// already passed explicit pairing; group members haven't.
// Zalo has no inline buttons — the DM carries text-reply instructions instead.
export function registerPermissionRelay(): void {
  mcp.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel/permission_request'),
      params: z.object({
        request_id: z.string(),
        tool_name: z.string(),
        description: z.string(),
        input_preview: z.string(),
      }),
    }),
    async ({ params }) => {
      const { request_id, tool_name, description, input_preview } = params
      pendingPermissions.set(request_id, { tool_name, description, input_preview })
      const api = getApi()
      if (!api) return
      const access = loadAccess()
      const preview = input_preview.length > 500 ? input_preview.slice(0, 500) + '…' : input_preview
      const text =
        `🔐 Permission: ${tool_name}\n` +
        `${description}\n\n` +
        `${preview}\n\n` +
        `Reply "yes ${request_id}" to allow or "no ${request_id}" to deny.`
      for (const chat_id of access.allowFrom) {
        void api.sendMessage(text, chat_id, ThreadType.User).catch(e => {
          log(`permission_request send to ${chat_id} failed: ${e}`)
        })
      }
    },
  )
}

// Permission-reply intercept: if an inbound message looks like "yes xxxxx" for
// a pending permission request, emit the structured event instead of relaying
// as chat. Callers must only pass gate()-approved messages — non-allowlisted
// senders were dropped before this point, so we trust the reply.
export function tryHandlePermissionReply(text: string, message: Message): boolean {
  const permMatch = PERMISSION_REPLY_RE.exec(text)
  if (!permMatch) return false
  const allow = permMatch[1]!.toLowerCase().startsWith('y')
  void mcp.notification({
    method: 'notifications/claude/channel/permission',
    params: {
      request_id: permMatch[2]!.toLowerCase(),
      behavior: allow ? 'allow' : 'deny',
    },
  })
  void getApi()?.addReaction(allow ? Reactions.OK : Reactions.NO, {
    data: { msgId: message.data.msgId, cliMsgId: message.data.cliMsgId },
    threadId: message.threadId,
    type: message.type,
  }).catch(() => { })
  return true
}
