// permission relay adapter: perm_requests (proxy records what it asked) + perm_responses (daemon
// records the user's yes/no DM reply). Two sub-entities → `permRequest*` / `permResponse*`.
import { allRows, run } from './client.ts'

// (was recordPermRequest)
export function permRequestCreate(requestId: string, sessionId: string): void {
  run('INSERT OR REPLACE INTO perm_requests(request_id,session_id,created_at) VALUES(?1,?2,?3)', requestId, sessionId, Date.now())
}

// (was recordPermResponse)
export function permResponseCreate(requestId: string, behavior: 'allow' | 'deny'): void {
  run('INSERT OR REPLACE INTO perm_responses(request_id,behavior,created_at) VALUES(?1,?2,?3)', requestId, behavior, Date.now())
}

// List the responses for the given request ids and consume them (delete after read) so a reply is
// never re-emitted. (was takePermResponsesFor)
export function permResponseList(requestIds: string[]): Array<{ request_id: string; behavior: string }> {
  if (requestIds.length === 0) return []
  const ph = requestIds.map((_, i) => `?${i + 1}`).join(',')
  const rows = allRows<{ request_id: string; behavior: string }>(`SELECT request_id, behavior FROM perm_responses WHERE request_id IN (${ph})`, ...requestIds)
  if (rows.length) run(`DELETE FROM perm_responses WHERE request_id IN (${ph})`, ...requestIds)
  return rows
}
