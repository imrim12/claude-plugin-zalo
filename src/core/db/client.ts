// SQLite connection, schema/migrations, shared query helpers, row types, and whole-DB retention.
// The DB doubles as the IPC bus between the daemon (single writer of inbound + outbound results)
// and the proxies (claim inbound, enqueue outbound). WAL + busy_timeout make multi-process access
// safe. One DB file, account-global at ~/.claude/channels/zalo/messages.db. The per-entity
// adapters (message/outbound/perm/meta.ts) import the helpers below; this file owns no entity
// queries except cross-table retention (dbPrune) and is exempt from the noun-CRUD convention.
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { renameSync } from 'fs'
import { DB_FILE } from '../../constants/paths.ts'
import { log } from '../../utils/log.ts'

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

// bun:sqlite's bind-parameter generics infer poorly from bare scalar arguments (a single number
// is read as wanting an array). These thin helpers pin ParamsType once so every call site can
// pass plain positional binds. Exported so the per-entity adapters share them.
export function allRows<T>(sql: string, ...binds: SQLQueryBindings[]): T[] {
  return db().query<T, SQLQueryBindings[]>(sql).all(...binds)
}
export function getRow<T>(sql: string, ...binds: SQLQueryBindings[]): T | undefined {
  return db().query<T, SQLQueryBindings[]>(sql).get(...binds) ?? undefined
}
export function run(sql: string, ...binds: SQLQueryBindings[]): void {
  db().run<SQLQueryBindings[]>(sql, binds)
}
export function runReturningId(sql: string, ...binds: SQLQueryBindings[]): number {
  return Number(db().run<SQLQueryBindings[]>(sql, binds).lastInsertRowid)
}

// Power-loss / kill mid-write can tear the file. Quick-check at open; if corrupt, move it aside
// and start fresh — losing the log is recoverable, refusing to boot is not.
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

// ── shared row + insert types (consumed across adapters and their callers) ──
export type InsertMessage = {
  msgId?: string; cliMsgId?: string; chatId: string; threadType: 'user' | 'group'
  senderId: string; senderName?: string; text: string; msgType?: string
  shouldReply: boolean
  attKind?: string; attHref?: string; attTitle?: string; attParams?: string
  quoteJson?: string; localPath?: string
  ts: number; tsIso: string
}

export type MessageRow = {
  id: number; msg_id: string | null; cli_msg_id: string | null; chat_id: string
  thread_type: 'user' | 'group'; sender_id: string; sender_name: string | null; text: string
  msg_type: string | null; should_reply: number; att_kind: string | null; att_href: string | null
  att_title: string | null; att_params: string | null; quote_json: string | null
  local_path: string | null
  ts: number; ts_iso: string; delivered_to: string | null; processed: number
}

export type OutboundRow = {
  id: number; kind: string; idem_key: string | null; chat_id: string | null
  thread_type: string | null; text: string | null; reply_to: string | null; emoji: string | null
  target_msg_id: string | null; payload: string | null; watermark_id: number | null
  status: string; result: string | null
}

// ── retention (whole-DB; called periodically by the daemon). Spans every table, so it lives in
//    client.ts rather than any single entity adapter. (was pruneOld) ──
export function dbPrune(maxAgeMs: number): void {
  const cutoff = Date.now() - maxAgeMs
  run('DELETE FROM messages WHERE created_at < ?1 AND processed = 1', cutoff)
  run(`DELETE FROM outbound WHERE status != 'pending' AND updated_at < ?1`, cutoff)
  run('DELETE FROM perm_responses WHERE created_at < ?1', cutoff)
  run('DELETE FROM perm_requests WHERE created_at < ?1', cutoff)
}
