// The /zalo:access skill drops a file at approved/<senderId> when it pairs
// someone. Poll for it, send confirmation, clean up. For Zalo DMs,
// threadId == senderId, so we can send directly without stashing chatId.
import { readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { ThreadType } from 'zca-js'
import { APPROVED_DIR, STATIC } from '../../constants/paths.ts'
import { sessionApi } from './session.ts'
import { log } from '../../utils/log.ts'

function checkApprovals(): void {
  const api = sessionApi()
  if (!api) return // not logged in yet — leave files for the next pass
  let files: string[]
  try {
    files = readdirSync(APPROVED_DIR)
  } catch {
    return
  }
  if (files.length === 0) return

  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    void api.sendMessage("Paired! Say hi to Claude.", senderId, ThreadType.User).then(
      () => rmSync(file, { force: true }),
      err => {
        log(`failed to send approval confirm: ${err}`)
        // Remove anyway — don't loop on a broken send.
        rmSync(file, { force: true })
      },
    )
  }
}

export function approvalPoll(): void {
  if (STATIC) return
  setInterval(checkApprovals, 5000).unref()
}
