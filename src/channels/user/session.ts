// Zalo session lifecycle. Telegram's equivalent is the bot.start() retry loop
// at the bottom of telegram.ts. Here: cookie-login with backoff, listener
// wiring, the QR login bootstrap, and a stand-down on kick (another session
// taking the slot must win — fighting it would churn the cookie and log the
// user out everywhere).
import {
  Zalo,
  CloseReason,
  LoginQRCallbackEventType,
  type API,
  type Message,
} from 'zca-js'
import { loadCredentials, saveCredentials } from './credentials.ts'
import { CREDENTIALS_FILE, QR_PATH } from '../../constants/paths.ts'
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

// Inbound handler is injected by main.ts (keeps session ↔ inbound from being
// a circular import).
type InboundHandler = (message: Message) => Promise<void>
let onMessage: InboundHandler | null = null

export function setInboundHandler(handler: InboundHandler): void {
  onMessage = handler
}

export function getApi(): API | null {
  return api
}

export function getOwnId(): string {
  return ownId
}

export function isShuttingDown(): boolean {
  return shuttingDown
}

export function markShuttingDown(): void {
  shuttingDown = true
  try { api?.listener.stop() } catch { }
}

export function requireApi(): API {
  if (kicked) {
    throw new Error(
      'another Zalo session took over this account — close it, then run zalo_login or restart this session',
    )
  }
  if (!api) throw new Error('Zalo not logged in — run zalo_login (QR scan) first')
  return api
}

function wireApi(a: API): void {
  try { api?.listener.stop() } catch { }
  api = a
  kicked = false
  reloginAttempt = 0
  ownId = a.getOwnId()
  saveCredentials(a)

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
  setTimeout(() => { void cookieLogin() }, delay).unref()
}

export async function cookieLogin(): Promise<void> {
  if (shuttingDown || kicked) return
  const creds = loadCredentials()
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

export function beginQRLogin(): Promise<string> {
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
