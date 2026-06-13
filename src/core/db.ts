// The SQLite message log doubles as the IPC bus between the daemon (single writer of
// inbound + outbound results) and the proxies (claim inbound, enqueue outbound). WAL +
// busy_timeout make multi-process access safe; SQLite is built for this. One DB file,
// account-global at ~/.claude/channels/zalo/messages.db.
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { renameSync } from 'fs'
import { DB_FILE } from '../constants/paths.ts'
import { log } from '../utils/log.ts'

let _db: Database | null = null

export function db(): Database {
  if (_db) return _db
  const d = openWithIntegrity()
  d.run('PRAGMA journal_mode = WAL')
  d.run('PRAGMA busy_timeout = 5000')
  d.run('PRAGMA synchronous = NORMAL')
  migrate(d)
  _db = d
  return d
}

// bun:sqlite's bind-parameter generics infer poorly from bare scalar arguments
// (a single number is read as wanting an array). These thin helpers pin
// ParamsType once so every call site can pass plain positional binds.
function allRows<T>(sql: string, ...binds: SQLQueryBindings[]): T[] {
  return db().query<T, SQLQueryBindings[]>(sql).all(...binds)
}
function getRow<T>(sql: string, ...binds: SQLQueryBindings[]): T | undefined {
  return db().query<T, SQLQueryBindings[]>(sql).get(...binds) ?? undefined
}
function run(sql: string, ...binds: SQLQueryBindings[]): void {
  db().run<SQLQueryBindings[]>(sql, binds)
}
function runReturningId(sql: string, ...binds: SQLQueryBindings[]): number {
  return Number(db().run<SQLQueryBindings[]>(sql, binds).lastInsertRowid)
}

// Power-loss / kill mid-write can tear the file. Quick-check at open; if corrupt, move it
// aside and start fresh — losing the log is recoverable, refusing to boot is not.
function openWithIntegrity(): Database {
  try {
    const d = new Database(DB_FILE, { create: true })
    const row = d.query('PRAGMA quick_check').get() as { quick_check?: string } | undefined
    const ok = row && Object.values(row)[0] === 'ok'
    if (!ok) throw new Error('quick_check failed')
    return d
  } catch (err) {
    log(`messages.db integrity check failed (${err}) — quarantining and recreating`)
    try { renameSync(DB_FILE, `${DB_FILE}.corrupt-${process.pid}`) } catch { }
    return new Database(DB_FILE, { create: true })
  }
}

function migrate(d: Database): void {
  d.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      msg_id        TEXT,
      cli_msg_id    TEXT,
      chat_id       TEXT NOT NULL,
      thread_type   TEXT NOT NULL,                 -- 'user' | 'group'
      sender_id     TEXT NOT NULL,
      sender_name   TEXT,
      text          TEXT NOT NULL,
      msg_type      TEXT,
      should_reply  INTEGER NOT NULL DEFAULT 0,    -- gate decision: DM/@mention => 1
      att_kind      TEXT,
      att_href      TEXT,
      att_title     TEXT,
      att_params    TEXT,                          -- raw zca content.params (photo keys etc.)
      quote_json    TEXT,                          -- raw zca message.data for quote reconstruction
      local_path    TEXT,                          -- set once downloaded to inbox
      ts            INTEGER NOT NULL,              -- epoch ms (sender clock)
      ts_iso        TEXT NOT NULL,
      delivered_to  TEXT,                          -- session id that claimed it (NULL=unclaimed)
      delivered_at  INTEGER,
      processed     INTEGER NOT NULL DEFAULT 0,
      processed_at  INTEGER,
      created_at    INTEGER NOT NULL               -- epoch ms (daemon clock, our insert time)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_msgid ON messages(msg_id) WHERE msg_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_msg_claim ON messages(should_reply, delivered_to, created_at);
    CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(chat_id, processed, id);

    CREATE TABLE IF NOT EXISTS outbound (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      kind          TEXT NOT NULL,                 -- reply|react|download|login|permission_dm
      idem_key      TEXT UNIQUE,
      chat_id       TEXT,
      thread_type   TEXT,
      text          TEXT,
      reply_to      TEXT,
      emoji         TEXT,
      target_msg_id TEXT,                          -- react/download target
      payload       TEXT,                          -- json for misc kinds
      watermark_id  INTEGER,                       -- reply: mark chat processed WHERE id<=this
      status        TEXT NOT NULL DEFAULT 'pending', -- pending|sent|failed
      result        TEXT,                          -- json: {sentIds}|{path}|{qrPath}|{error}
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_out_pending ON outbound(status, id);

    CREATE TABLE IF NOT EXISTS perm_requests (
      request_id  TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS perm_responses (
      request_id  TEXT PRIMARY KEY,
      behavior    TEXT NOT NULL,                   -- allow|deny
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `)
}

// ── meta (daemon health, read by /zalo:status and proxies' daemon-ensure) ──────────────
export function setMeta(key: string, value: string): void {
  run('INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2', key, value)
}
export function getMeta(key: string): string | undefined {
  return getRow<{ value?: string }>('SELECT value FROM meta WHERE key=?1', key)?.value
}

// ── messages: ingest (daemon) ──────────────────────────────────────────────────────────
export type InsertMessage = {
  msgId?: string; cliMsgId?: string; chatId: string; threadType: 'user' | 'group'
  senderId: string; senderName?: string; text: string; msgType?: string
  shouldReply: boolean
  attKind?: string; attHref?: string; attTitle?: string; attParams?: string
  quoteJson?: string; localPath?: string
  ts: number; tsIso: string
}

// INSERT OR IGNORE on the unique msg_id keeps re-delivered duplicates out. Returns the rowid
// (0 if it was a duplicate ignore) so the daemon can decide whether to act.
export function insertMessage(m: InsertMessage): number {
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

// ── messages: claim (proxy) ──────────────────────────────────────────────────────────────
export type MessageRow = {
  id: number; msg_id: string | null; cli_msg_id: string | null; chat_id: string
  thread_type: 'user' | 'group'; sender_id: string; sender_name: string | null; text: string
  msg_type: string | null; should_reply: number; att_kind: string | null; att_href: string | null
  att_title: string | null; att_params: string | null; quote_json: string | null
  local_path: string | null
  ts: number; ts_iso: string; delivered_to: string | null; processed: number
}

// Atomically claim undelivered should_reply rows newer than the freshness floor. UPDATE …
// RETURNING is atomic, so two proxies polling concurrently get disjoint sets — this IS the
// "exactly one session answers" guarantee (no owner election needed). freshnessFloor (ms)
// stops a freshly-started session from replaying hours of backlog as if it were live.
export function claimInbound(sessionId: string, freshnessFloor: number, limit = 20): MessageRow[] {
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

// Unprocessed lead-up for a chat (the silent messages the LLM never saw) — the "previous
// chat" context fed before answering. Excluding the triggering row's own id is the caller's job.
export function unprocessedForChat(chatId: string, upToId: number): MessageRow[] {
  return allRows<MessageRow>(
    `SELECT * FROM messages WHERE chat_id=?1 AND processed=0 AND id<=?2 ORDER BY id ASC`,
    chatId, upToId,
  )
}

export function getMessageByMsgId(msgId: string): MessageRow | undefined {
  return getRow<MessageRow>('SELECT * FROM messages WHERE msg_id=?1', msgId)
}

// Persist a download's local path so a second download of the same message is a no-op.
export function setMessageLocalPath(id: number, localPath: string): void {
  run('UPDATE messages SET local_path=?2 WHERE id=?1', id, localPath)
}

// ── outbound queue ───────────────────────────────────────────────────────────────────────
export type OutboundRow = {
  id: number; kind: string; idem_key: string | null; chat_id: string | null
  thread_type: string | null; text: string | null; reply_to: string | null; emoji: string | null
  target_msg_id: string | null; payload: string | null; watermark_id: number | null
  status: string; result: string | null
}

export function enqueueOutbound(o: Partial<OutboundRow> & { kind: string; idem_key: string }): number {
  const now = Date.now()
  return runReturningId(
    `INSERT INTO outbound (kind,idem_key,chat_id,thread_type,text,reply_to,emoji,target_msg_id,payload,watermark_id,created_at,updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)`,
    o.kind, o.idem_key, o.chat_id ?? null, o.thread_type ?? null, o.text ?? null, o.reply_to ?? null,
    o.emoji ?? null, o.target_msg_id ?? null, o.payload ?? null, o.watermark_id ?? null, now,
  )
}

export function takePendingOutbound(limit = 10): OutboundRow[] {
  // Daemon is the only consumer; a plain SELECT is fine (no concurrent drainer).
  return allRows<OutboundRow>(`SELECT * FROM outbound WHERE status='pending' ORDER BY id ASC LIMIT ?1`, limit)
}

// Mark an outbound row done and, for a successful reply, watermark-process the chat in the
// SAME transaction so a message arriving after the send (id > watermark) is never swallowed.
export function completeOutbound(id: number, status: 'sent' | 'failed', result: object, opts?: { chatId?: string; watermarkId?: number }): void {
  const tx = db().transaction(() => {
    run('UPDATE outbound SET status=?2, result=?3, updated_at=?4 WHERE id=?1', id, status, JSON.stringify(result), Date.now())
    if (status === 'sent' && opts?.chatId && opts.watermarkId != null) {
      run('UPDATE messages SET processed=1, processed_at=?3 WHERE chat_id=?1 AND processed=0 AND id<=?2', opts.chatId, opts.watermarkId, Date.now())
    }
  })
  tx()
}

export function getOutbound(id: number): OutboundRow | undefined {
  return getRow<OutboundRow>('SELECT * FROM outbound WHERE id=?1', id)
}

// ── permissions ────────────────────────────────────────────────────────────────────────
export function recordPermRequest(requestId: string, sessionId: string): void {
  run('INSERT OR REPLACE INTO perm_requests(request_id,session_id,created_at) VALUES(?1,?2,?3)', requestId, sessionId, Date.now())
}
export function recordPermResponse(requestId: string, behavior: 'allow' | 'deny'): void {
  run('INSERT OR REPLACE INTO perm_responses(request_id,behavior,created_at) VALUES(?1,?2,?3)', requestId, behavior, Date.now())
}
export function takePermResponsesFor(requestIds: string[]): Array<{ request_id: string; behavior: string }> {
  if (requestIds.length === 0) return []
  const ph = requestIds.map((_, i) => `?${i + 1}`).join(',')
  const rows = allRows<{ request_id: string; behavior: string }>(`SELECT request_id, behavior FROM perm_responses WHERE request_id IN (${ph})`, ...requestIds)
  if (rows.length) run(`DELETE FROM perm_responses WHERE request_id IN (${ph})`, ...requestIds)
  return rows
}

// ── retention (called periodically by the daemon) ────────────────────────────────────────
export function pruneOld(maxAgeMs: number): void {
  const cutoff = Date.now() - maxAgeMs
  run('DELETE FROM messages WHERE created_at < ?1 AND processed = 1', cutoff)
  run(`DELETE FROM outbound WHERE status != 'pending' AND updated_at < ?1`, cutoff)
  run('DELETE FROM perm_responses WHERE created_at < ?1', cutoff)
  run('DELETE FROM perm_requests WHERE created_at < ?1', cutoff)
}
