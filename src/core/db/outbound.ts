// outbound queue adapter: the proxy enqueues, the daemon drains + completes.
import { db, allRows, getRow, run, runReturningId, type OutboundRow } from './client.ts'

// (was enqueueOutbound)
export function outboundCreate(o: Partial<OutboundRow> & { kind: string; idem_key: string }): number {
  const now = Date.now()
  return runReturningId(
    `INSERT INTO outbound (kind,idem_key,chat_id,thread_type,text,reply_to,emoji,target_msg_id,payload,watermark_id,created_at,updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)`,
    o.kind, o.idem_key, o.chat_id ?? null, o.thread_type ?? null, o.text ?? null, o.reply_to ?? null,
    o.emoji ?? null, o.target_msg_id ?? null, o.payload ?? null, o.watermark_id ?? null, now,
  )
}

// Daemon is the only consumer; a plain SELECT is fine (no concurrent drainer). (was takePendingOutbound)
export function outboundList(limit = 10): OutboundRow[] {
  return allRows<OutboundRow>(`SELECT * FROM outbound WHERE status='pending' ORDER BY id ASC LIMIT ?1`, limit)
}

// Mark an outbound row done and, for a successful reply, watermark-process the chat in the SAME
// transaction so a message arriving after the send (id > watermark) is never swallowed.
// (was completeOutbound)
export function outboundUpdate(id: number, status: 'sent' | 'failed', result: object, opts?: { chatId?: string; watermarkId?: number }): void {
  const tx = db().transaction(() => {
    run('UPDATE outbound SET status=?2, result=?3, updated_at=?4 WHERE id=?1', id, status, JSON.stringify(result), Date.now())
    if (status === 'sent' && opts?.chatId && opts.watermarkId != null) {
      run('UPDATE messages SET processed=1, processed_at=?3 WHERE chat_id=?1 AND processed=0 AND id<=?2', opts.chatId, opts.watermarkId, Date.now())
    }
  })
  tx()
}

// (was getOutbound)
export function outboundGet(id: number): OutboundRow | undefined {
  return getRow<OutboundRow>('SELECT * FROM outbound WHERE id=?1', id)
}
