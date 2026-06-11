// Credential persistence. Telegram reads a pre-provisioned bot token from
// .env; Zalo has no token. Credentials are minted by the QR login flow
// (zalo_login tool) and persisted here so later boots can cookie-login
// without a new scan. Missing credentials is not fatal — the MCP server
// still runs so zalo_login can bootstrap.
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'fs'
import type { API, Credentials } from 'zca-js'
import { CREDENTIALS_FILE } from '../../constants/paths.ts'

export type StoredCredentials = {
  imei: string
  userAgent: string
  cookie: Credentials['cookie']
  language?: string
}

export function loadCredentials(): StoredCredentials | null {
  try {
    const parsed = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8')) as Partial<StoredCredentials>
    if (!parsed.imei || !parsed.userAgent || !parsed.cookie) return null
    return parsed as StoredCredentials
  } catch {
    return null
  }
}

// Zalo rotates cookies on every login — re-persist after each successful one,
// or the saved jar goes stale and the next cookie-login fails.
export function saveCredentials(api: API): void {
  const ctx = api.getContext()
  const jar = api.getCookie().toJSON()
  const creds: StoredCredentials = {
    imei: ctx.imei,
    userAgent: ctx.userAgent,
    cookie: jar?.cookies ?? [],
    language: ctx.language,
  }
  const tmp = CREDENTIALS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, CREDENTIALS_FILE)
  // Credential file may predate the mode option. No-op on Windows (would need ACLs).
  try { chmodSync(CREDENTIALS_FILE, 0o600) } catch { }
}
