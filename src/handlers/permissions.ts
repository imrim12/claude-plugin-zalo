// Permission relay (proxy side). Claude Code asks "may I run tool X?" → we record the request
// against THIS session and enqueue a DM for the daemon to send. The user's "yes <id>"/"no <id>"
// reply is matched daemon-side (in ingest) and written to `perm_responses`; this proxy polls
// only for responses to requests IT issued and emits the structured permission event. If this
// session dies, its responses are never claimed and expire via pruneOld — fail-closed
// (objection A10): a reply never falls through to another session.
import { z } from 'zod'
import { randomBytes } from 'crypto'
import { mcp } from '../core/mcp.ts'
import { recordPermRequest, enqueueOutbound, takePermResponsesFor } from '../core/db.ts'

const myRequests = new Set<string>()
let sessionId = ''

export function registerPermissionRelay(sid: string): void {
  sessionId = sid
  mcp.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel/permission_request'),
      params: z.object({
        request_id: z.string(),
        tool_name: z.string(),
        description: z.string(),
        input_preview: z.string(),
      }),
    }),
    async ({ params }) => {
      const { request_id, tool_name, description, input_preview } = params
      const preview = input_preview.length > 500 ? input_preview.slice(0, 500) + '…' : input_preview
      const text =
        `🔐 Permission: ${tool_name}\n` +
        `${description}\n\n` +
        `${preview}\n\n` +
        `Reply "yes ${request_id}" to allow or "no ${request_id}" to deny.`
      recordPermRequest(request_id, sessionId)
      myRequests.add(request_id)
      // The daemon owns the Zalo connection and fans this out to every allowlisted DM.
      enqueueOutbound({ kind: 'permission_dm', idem_key: randomBytes(8).toString('hex'), text })
    },
  )
}

export function startPermissionPoller(): void {
  setInterval(() => {
    if (myRequests.size === 0) return
    for (const { request_id, behavior } of takePermResponsesFor([...myRequests])) {
      myRequests.delete(request_id)
      void mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id, behavior },
      })
    }
  }, 500).unref()
}
