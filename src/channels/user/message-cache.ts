// Quote-replies and reactions need the original message's msgId AND cliMsgId —
// Zalo has no "fetch message by id" API, so remember recent inbound messages.
// Telegram needs no equivalent (its API addresses messages by id directly).
// In-memory only: restarting the server forgets reactable messages.
import type { Message, TMessage, ThreadType } from 'zca-js'

export type CachedMessage = {
  data: TMessage
  threadId: string
  type: ThreadType
}

const MESSAGE_CACHE_MAX = 200
const recentMessages = new Map<string, CachedMessage>()

export function cacheMessage(message: Message): void {
  const { msgId } = message.data
  if (!msgId) return
  if (recentMessages.size >= MESSAGE_CACHE_MAX) {
    const oldest = recentMessages.keys().next().value
    if (oldest !== undefined) recentMessages.delete(oldest)
  }
  recentMessages.set(msgId, { data: message.data, threadId: message.threadId, type: message.type })
}

export function getCachedMessage(msgId: string): CachedMessage | undefined {
  return recentMessages.get(msgId)
}
