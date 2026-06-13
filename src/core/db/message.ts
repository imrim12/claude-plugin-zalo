// messages table adapter. The canonical inbound log + the proxy's claim surface.
import type { SQLQueryBindings } from 'bun:sqlite'
import { db, allRows, getRow, run, type InsertMessage, type MessageRow } from './client.ts'

// INSERT OR IGNORE on the unique msg_id keeps re-delivered duplicates out. Returns the rowid
// (0 if it was a duplicate ignore) so the daemon can decide whether to act. (was insertMessage)
export function messageCreate(m: InsertMessage): number {
  const now = Date.now()
  const info = db().run<SQLQueryBindings[]>(
    `INSERT OR IGNORE INTO messages
       (msg_id,cli_msg_id,chat_id,thread_type,sender_id,sender_name,text,msg_type,should_reply,
        att_kind,att_href,att_title,att_params,quote_json,local_path,ts,ts_iso,created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)`,
    [
      m.msgId ?? null, m.cliMsgId ?? null, m.chatId, m.threadType, m.senderId, m.senderName ?? null,
      m.text, m.msgType ?? null, m.shouldReply ? 1 : 0,
      m.attKind ?? null, m.attHref ?? null, m.attTitle ?? null, m.attParams ?? null,
      m.quoteJson ?? null, m.localPath ?? null,
      m.ts, m.tsIso, now,
    ],
  )
  // INSERT OR IGNORE on a duplicate msg_id changes nothing; bun returns the PRIOR
  // lastInsertRowid in that case, so key off `changes` to report 0 for a dup.
  return info.changes === 0 ? 0 : Number(info.lastInsertRowid)
}

// Atomically claim undelivered should_reply rows newer than the freshness floor. UPDATE …
// RETURNING is atomic, so two proxies polling concurrently get disjoint sets — this IS the
// "exactly one session answers" guarantee. NOT a plain CRUD update (kept as `claim`): the atomic
// claim-on-read is the invariant. (was claimInbound)
export function messageClaim(sessionId: string, freshnessFloor: number, limit = 20): MessageRow[] {
  return allRows<MessageRow>(
    `UPDATE messages SET delivered_to=?1, delivered_at=?2
       WHERE id IN (
         SELECT id FROM messages
          WHERE should_reply=1 AND delivered_to IS NULL AND created_at>=?3
          ORDER BY id ASC LIMIT ?4)
     RETURNING *`,
    sessionId, Date.now(), freshnessFloor, limit,
  )
}

// Unprocessed lead-up for a chat (the silent messages the LLM never saw) — the "previous chat"
// context fed before answering. Excluding the triggering row's own id is the caller's job.
// (was unprocessedForChat) — a filtered list, hence `list`.
export function messageList(chatId: string, upToId: number): MessageRow[] {
  return allRows<MessageRow>(
    `SELECT * FROM messages WHERE chat_id=?1 AND processed=0 AND id<=?2 ORDER BY id ASC`,
    chatId, upToId,
  )
}

// (was getMessageByMsgId)
export function messageGet(msgId: string): MessageRow | undefined {
  return getRow<MessageRow>('SELECT * FROM messages WHERE msg_id=?1', msgId)
}

// Persist a download's local path so a second download of the same message is a no-op. The only
// plain column update on a message row, so it takes the `update` verb. (was setMessageLocalPath)
export function messageUpdate(id: number, localPath: string): void {
  run('UPDATE messages SET local_path=?2 WHERE id=?1', id, localPath)
}
