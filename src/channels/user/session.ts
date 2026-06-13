// Zalo session lifecycle. Telegram's equivalent is the bot.start() retry loop
// at the bottom of telegram.ts. Here: cookie-login with backoff, listener
// wiring, the QR login bootstrap, and a stand-down on kick (another session
// taking the slot must win — fighting it would churn the cookie and log the
// user out everywhere).
import { appendFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import {
  Zalo,
  CloseReason,
  LoginQRCallbackEventType,
  ThreadType,
  type API,
  type Message,
} from 'zca-js'
import { credentialsGet, credentialsUpdate } from './credentials.ts'
import { CREDENTIALS_FILE, QR_PATH, HOME_STATE_DIR } from '../../constants/paths.ts'
import { log } from '../../utils/log.ts'

const zalo = new Zalo({ selfListen: false, checkUpdate: false, logging: false })

let api: API | null = null
let ownId = ''
// Another Zalo session (phone, browser, or a second plugin instance) took the
// listener slot. Auto-relogin would kick it back and churn the cookie in an
// endless fight — stand down and make tools error clearly instead.
let kicked = false
let shuttingDown = false
let reloginAttempt = 0

// Inbound handler is injected by the daemon (keeps session ↔ ingest from being
// a circular import).
type InboundHandler = (message: Message) => Promise<void>
let onMessage: InboundHandler | null = null

export function sessionOnInbound(handler: InboundHandler): void {
  onMessage = handler
}

export function sessionApi(): API | null {
  return api
}

export function sessionOwnId(): string {
  return ownId
}

export function sessionShuttingDown(): boolean {
  return shuttingDown
}

export function sessionClose(): void {
  shuttingDown = true
  try { api?.listener.stop() } catch { }
}

export function sessionRequireApi(): API {
  if (kicked) {
    throw new Error(
      'another Zalo session took over this account — close it, then run zalo_login or restart this session',
    )
  }
  if (!api) throw new Error('Zalo not logged in — run zalo_login (QR scan) first')
  return api
}

// Health surfaced to `meta.ws_state` (objection A6): a 'kicked' daemon looks
// process-healthy but its WebSocket is dead — make that observable instead of
// hiding it. Derived from the same api/kicked/reloginAttempt state the listener
// callbacks maintain.
export function sessionState(): 'connected' | 'kicked' | 'reconnecting' | 'disconnected' {
  if (kicked) return 'kicked'
  if (api) return 'connected'
  if (reloginAttempt > 0) return 'reconnecting'
  return 'disconnected'
}

function wireApi(a: API): void {
  try { api?.listener.stop() } catch { }
  api = a
  kicked = false
  reloginAttempt = 0
  ownId = a.getOwnId()
  credentialsUpdate(a)

  a.listener.on('message', m => {
    if (!onMessage) return
    onMessage(m).catch(err => {
      // Without this, a throw in the handler becomes an unhandled rejection;
      // the listener itself keeps running either way.
      log(`handler error (listening continues): ${err}`)
    })
  })
  a.listener.on('error', err => {
    log(`listener error: ${err}`)
  })
  a.listener.on('closed', (code, reason) => {
    if (shuttingDown || code === CloseReason.ManualClosure) return
    if (code === CloseReason.DuplicateConnection || code === CloseReason.KickConnection) {
      kicked = true
      api = null
      log(
        `kicked (code=${code} ${reason}) — another Zalo session took the slot. ` +
        `Standing down; close the other session and run zalo_login or restart.`,
      )
      return
    }
    log(`listener closed (code=${code} ${reason}), re-logging in`)
    scheduleRelogin()
  })
  a.listener.start()
  log(`listening as uid=${ownId}`)
}

function scheduleRelogin(): void {
  const attempt = ++reloginAttempt
  if (attempt > 8) {
    log(
      `re-login failed after ${attempt - 1} attempts — giving up. ` +
      `Run zalo_login to reconnect.`,
    )
    return
  }
  const delay = Math.min(1000 * attempt, 15000)
  log(`re-login attempt ${attempt} in ${delay / 1000}s`)
  setTimeout(() => { void sessionLogin() }, delay).unref()
}

// ── Test harness ────────────────────────────────────────────────────────────
// ZALO_FAKE=1 wires a stub API instead of a real Zalo login so the daemon can be
// integration-tested with no account. Inbound is fed by appending JSON lines to
// <HOME_STATE_DIR>/fake-inbound.jsonl (one TMessage-shaped `data` object plus an
// optional `__type:"group"`); outbound sends are recorded to fake-sent.jsonl.
const FAKE = process.env.ZALO_FAKE === '1'

function wireFakeApi(): void {
  const sentLog = join(HOME_STATE_DIR, 'fake-sent.jsonl')
  const inboundFile = join(HOME_STATE_DIR, 'fake-inbound.jsonl')
  const fake = {
    getOwnId: () => 'self',
    getContext: () => ({ userAgent: 'fake-agent', imei: 'fake-imei', language: 'en' }),
    sendMessage: async (content: unknown, threadId: string, type: unknown) => {
      appendFileSync(sentLog, JSON.stringify({ content, threadId, type }) + '\n')
      return { message: { msgId: Math.floor(Date.now() % 1_000_000_000) }, attachment: [] }
    },
    addReaction: async () => ({ msgIds: [] }),
    sendTypingEvent: async () => ({}),
  } as unknown as API
  api = fake
  ownId = 'self'
  kicked = false
  log('ZALO_FAKE=1 — wired stub API (no real Zalo login)')
  setInterval(() => {
    let raw: string
    try { raw = readFileSync(inboundFile, 'utf8') } catch { return }
    try { rmSync(inboundFile) } catch { }
    for (const ln of raw.split('\n').filter(Boolean)) {
      try {
        const data = JSON.parse(ln) as { idTo?: string; threadId?: string; __type?: string }
        const msg = {
          data,
          threadId: data.threadId ?? data.idTo ?? '',
          type: data.__type === 'group' ? ThreadType.Group : ThreadType.User,
          isSelf: false,
        } as unknown as Message
        onMessage?.(msg).catch(err => log(`fake inbound handler error: ${err}`))
      } catch (err) { log(`fake inbound parse error: ${err}`) }
    }
  }, 200).unref()
}

export async function sessionLogin(): Promise<void> {
  if (shuttingDown || kicked) return
  if (FAKE) { wireFakeApi(); return }
  const creds = credentialsGet()
  if (!creds) {
    log(`no credentials at ${CREDENTIALS_FILE} — run zalo_login (QR scan) to connect`)
    return
  }
  try {
    const a = await zalo.login(creds)
    wireApi(a)
  } catch (err) {
    log(`cookie login failed: ${err}`)
    scheduleRelogin()
  }
}

// QR login bootstrap — the one flow Telegram doesn't need. Resolves with the
// QR image path as soon as it's written; the actual login keeps going in the
// background and wires the listener + persists credentials when the user scans.
let qrInFlight: Promise<string> | null = null

export function sessionLoginQR(): Promise<string> {
  if (qrInFlight) return qrInFlight
  qrInFlight = new Promise<string>((resolve, reject) => {
    let qrShown = false
    zalo.loginQR({ qrPath: QR_PATH }, ev => {
      if (ev.type === LoginQRCallbackEventType.QRCodeGenerated) {
        void ev.actions.saveToFile(QR_PATH).then(
          () => { qrShown = true; resolve(QR_PATH) },
          err => reject(new Error(`failed to write QR image: ${err}`)),
        )
      } else if (ev.type === LoginQRCallbackEventType.QRCodeExpired) {
        ev.actions.abort()
        if (!qrShown) reject(new Error('QR code expired before it could be shown'))
        log('QR code expired — run zalo_login again')
      } else if (ev.type === LoginQRCallbackEventType.QRCodeDeclined) {
        ev.actions.abort()
        log('QR login declined on the phone')
      }
    }).then(
      a => {
        qrInFlight = null
        wireApi(a)
        log('QR login complete, credentials saved')
      },
      err => {
        qrInFlight = null
        if (!qrShown) reject(err instanceof Error ? err : new Error(String(err)))
        else log(`QR login failed: ${err}`)
      },
    )
  })
  return qrInFlight
}
