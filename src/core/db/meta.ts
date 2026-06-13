// meta key/value adapter (daemon health, read by /zalo:status and proxies' daemon-ensure).
import { getRow, run } from './client.ts'

// Upsert. (was setMeta)
export function metaUpdate(key: string, value: string): void {
  run('INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2', key, value)
}

// (was getMeta)
export function metaGet(key: string): string | undefined {
  return getRow<{ value?: string }>('SELECT value FROM meta WHERE key=?1', key)?.value
}
