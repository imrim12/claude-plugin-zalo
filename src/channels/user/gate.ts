// The inbound access gate. Fail-secure for DMs: 'disabled' drops everything,
// 'allowlist' requires an explicit allowFrom entry, 'pairing' never grants
// access without terminal approval. Never weaken the DM paths.
//
// Groups are deliberately OPEN by design: the secretary observes (delivers +
// logs) every group it's in, and only `respond`s when mentioned. An unknown
// group is auto-registered with a default mention-gated policy (so it shows up
// in /zalo:access and outbound replies pass assertAllowedChat) rather than
// dropped. Mute a group by setting its policy `observe: false`.
import { randomBytes } from 'crypto'
import { ThreadType, type Message } from 'zca-js'
import { loadAccess, saveAccess, pruneExpired, type Access, type GroupPolicy } from '../../core/access.ts'
import { getOwnId } from './session.ts'

export type GateResult =
  // respond=false means "observe only": deliver + log for memory, but do not reply.
  | { action: 'deliver'; access: Access; respond: boolean }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

export function gate(message: Message): GateResult {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const senderId = message.data.uidFrom
  if (!senderId) return { action: 'drop' }

  if (message.type === ThreadType.User) {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access, respond: true }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    // pairing mode — check for existing non-expired code for this sender
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        // Reply twice max (initial + one reminder), then go silent.
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    // Cap pending at 3. Extra attempts are silently dropped.
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex') // 6 hex chars
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: message.threadId,
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000, // 1h
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  if (message.type === ThreadType.Group) {
    const groupId = message.threadId
    let policy: GroupPolicy | undefined = access.groups[groupId]
    if (!policy) {
      // First message from a group we've never seen: auto-register it so the
      // secretary observes by default. Registering (vs. delivering ad-hoc)
      // makes the group visible to /zalo:access and lets outbound replies pass
      // assertAllowedChat. Default = observe all senders, reply only on mention.
      policy = { requireMention: true, allowFrom: [], observe: true }
      access.groups[groupId] = policy
      saveAccess(access)
    }
    // Muted group — the user opted it out via /zalo:access. Drop entirely.
    if (policy.observe === false) return { action: 'drop' }
    const groupAllowFrom = policy.allowFrom ?? []
    // An explicit per-group allowFrom is a deliberate narrowing: senders
    // outside it are dropped (not even logged).
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
      return { action: 'drop' }
    }
    // Observe everything; only respond when the mention policy is satisfied.
    const requireMention = policy.requireMention ?? true
    const respond = requireMention ? isMentioned(message, access.mentionPatterns) : true
    return { action: 'deliver', access, respond }
  }

  return { action: 'drop' }
}

function isMentioned(message: Message, extraPatterns?: string[]): boolean {
  const ownId = getOwnId()

  // `mentions` only exists on group messages — narrow on type before reading.
  if (message.type === ThreadType.Group) {
    for (const m of message.data.mentions ?? []) {
      if (m.uid === ownId) return true
    }
  }

  // Quote-reply to one of our messages counts as an implicit mention.
  if (message.data.quote?.ownerId === ownId) return true

  const text = typeof message.data.content === 'string' ? message.data.content : ''
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {
      // Invalid user-supplied regex — skip it.
    }
  }
  return false
}
