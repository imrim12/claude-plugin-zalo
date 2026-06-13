// Proxy-side inbound: atomically claim should_reply rows from the shared DB, enrich each with
// the chat's unprocessed lead-up + a memory snippet, and emit a channel notification. The
// atomic claim (db.ts UPDATE … RETURNING) is the "exactly one session answers" guarantee.
import { mcp } from '../core/mcp.ts'
import { claimInbound, type MessageRow } from '../core/db.ts'
import { buildContext } from '../core/context.ts'
import { log } from '../utils/log.ts'

export function startInboundPoller(sessionId: string): void {
  setInterval(() => {
    let rows: MessageRow[]
    try { rows = claimInbound(sessionId, Date.now() - 60_000) } catch (e) { log(`claim failed: ${e}`); return }
    for (const r of rows) void deliver(r)
  }, 1000).unref()
}

async function deliver(r: MessageRow): Promise<void> {
  // The notification content is the triggering message PLUS the unprocessed lead-up of this
  // chat + a memory snippet, assembled server-side (a PreToolUse hook can't do this — it fires
  // after Claude already wrote the reply). This is the "feed previous chat" half.
  const context = buildContext(r)
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: context.content,           // includes [previous unprocessed messages] + the new one
      meta: {
        chat_id: r.chat_id,
        thread_type: r.thread_type,
        should_reply: 'true',             // only should_reply rows are ever claimed/delivered
        ...(r.msg_id ? { message_id: r.msg_id } : {}),
        user: r.sender_name ?? r.sender_id,
        user_id: r.sender_id,
        ts: r.ts_iso,
        // watermark = highest message id known for this chat at delivery time; the reply tool
        // copies it onto the outbound row so mark-processed can't swallow later arrivals.
        watermark_id: String(context.watermarkId),
        ...(r.local_path ? { image_path: r.local_path } : {}),
        ...(r.att_kind && r.att_kind !== 'photo' && r.att_href ? { attachment_kind: r.att_kind, ...(r.att_title ? { attachment_name: r.att_title } : {}) } : {}),
      },
    },
  }).catch(e => log(`deliver failed: ${e}`))
}
