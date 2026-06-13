// The 4 MCP tools: reply, react, download_attachment, zalo_login.
// The proxy no longer talks to Zalo directly — every action is enqueued as an `outbound` row
// for the daemon to drain, then the tool polls for the result. The access gate still runs HERE
// (before enqueue) so an unauthorized reply errors immediately, with no DB round-trip.
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { randomBytes } from 'crypto'
import { mcp } from '../core/mcp.ts'
import { loadAccess, assertAllowedChat, MAX_CHUNK_LIMIT } from '../core/access.ts'
import { chunk } from '../utils/chunk.ts'
import { enqueueOutbound, getOutbound, getMessageByMsgId } from '../core/db.ts'

export function registerTools(): void {
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description:
          'Reply on Zalo. Pass chat_id and thread_type from the inbound message. Optionally pass reply_to (message_id) to quote an earlier message.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string' },
            text: { type: 'string' },
            thread_type: {
              type: 'string',
              enum: ['user', 'group'],
              description: 'Thread type from the inbound <channel> block. Default: user.',
            },
            reply_to: {
              type: 'string',
              description: 'Message ID to quote. Use message_id from the inbound <channel> block.',
            },
            watermark_id: {
              type: 'string',
              description:
                'Pass watermark_id from the inbound <channel> meta so the messages you have now answered are marked processed.',
            },
          },
          required: ['chat_id', 'text'],
        },
      },
      {
        name: 'react',
        description:
          'Add a reaction to a Zalo message. Accepts common emoji (👍 👎 ❤️ 😂 😮 😢 😡 🎉 ✅ …) or a raw zca reaction code. Works for any message the daemon has seen (survives restarts).',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string' },
            message_id: { type: 'string' },
            emoji: { type: 'string' },
          },
          required: ['chat_id', 'message_id', 'emoji'],
        },
      },
      {
        name: 'download_attachment',
        description:
          'Download a file attachment from a Zalo message to the local inbox. Use when the inbound <channel> meta shows attachment_kind. Pass the message_id from that meta. Returns the local file path ready to Read. Max 50MB.',
        inputSchema: {
          type: 'object',
          properties: {
            message_id: { type: 'string', description: 'The message_id from inbound meta' },
          },
          required: ['message_id'],
        },
      },
      {
        name: 'zalo_login',
        description:
          'Begin Zalo QR login. Writes a QR code image and returns its path — Read the image and show it to the user; they scan with the Zalo app. Credentials are saved on success, so this is only needed once (or after Zalo invalidates the session).',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    try {
      switch (req.params.name) {
        case 'reply':
          return await handleReply(args)
        case 'react':
          return await handleReact(args)
        case 'download_attachment':
          return await handleDownloadAttachment(args)
        case 'zalo_login':
          return await handleZaloLogin()
        default:
          return {
            content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
            isError: true,
          }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }],
        isError: true,
      }
    }
  })
}

type ToolResult = { content: Array<{ type: 'text'; text: string }> }

function idem(): string { return randomBytes(8).toString('hex') }

// Poll the outbound row the daemon drains. A timeout almost always means the daemon isn't
// running — point the user at /zalo:status.
async function awaitResult(id: number, timeoutMs = 15_000): Promise<{ status: string; result: unknown }> {
  const start = Date.now()
  for (;;) {
    const row = getOutbound(id)
    if (row && row.status !== 'pending') return { status: row.status, result: row.result ? JSON.parse(row.result) : null }
    if (Date.now() - start > timeoutMs) throw new Error('daemon did not process the request in time (is it running? /zalo:status)')
    await Bun.sleep(150)
  }
}

async function handleReply(args: Record<string, unknown>): Promise<ToolResult> {
  const chat_id = args.chat_id as string
  const text = args.text as string
  const thread_type = args.thread_type === 'group' ? 'group' : 'user'
  const reply_to = args.reply_to as string | undefined
  const watermark_id = args.watermark_id != null ? Number(args.watermark_id) : undefined

  assertAllowedChat(chat_id)
  const access = loadAccess()
  const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
  const chunks = chunk(text, limit, access.chunkMode ?? 'length')
  const replyMode = access.replyToMode ?? 'first'
  const quoteMsgId = reply_to && replyMode !== 'off' ? reply_to : undefined

  const id = enqueueOutbound({
    kind: 'reply', idem_key: idem(),
    chat_id, thread_type, watermark_id: watermark_id ?? null,
    payload: JSON.stringify({ chunks, quoteMsgId }),
  })
  const { status, result } = await awaitResult(id)
  if (status === 'failed') throw new Error((result as { error?: string })?.error ?? 'reply failed')
  const ids = (result as { sentIds?: number[] }).sentIds ?? []
  return { content: [{ type: 'text', text: ids.length === 1 ? `sent (id: ${ids[0]})` : `sent ${ids.length} parts (ids: ${ids.join(', ')})` }] }
}

async function handleReact(args: Record<string, unknown>): Promise<ToolResult> {
  const chat_id = args.chat_id as string
  const message_id = args.message_id as string
  const emoji = args.emoji as string
  assertAllowedChat(chat_id)

  const id = enqueueOutbound({
    kind: 'react', idem_key: idem(),
    chat_id, target_msg_id: message_id, emoji,
  })
  const { status, result } = await awaitResult(id)
  if (status === 'failed') throw new Error((result as { error?: string })?.error ?? 'react failed')
  return { content: [{ type: 'text', text: 'reacted' }] }
}

async function handleDownloadAttachment(args: Record<string, unknown>): Promise<ToolResult> {
  const message_id = args.message_id as string
  // Gate the source chat too: a message seen before an allowlist revocation shouldn't stay
  // fetchable after it. The daemon logged every message, so look the row up for its chat_id.
  const row = getMessageByMsgId(message_id)
  if (!row) throw new Error(`message ${message_id} not found — the daemon has no record of it`)
  assertAllowedChat(row.chat_id)
  if (!row.att_href) throw new Error(`message ${message_id} has no downloadable attachment`)

  const id = enqueueOutbound({
    kind: 'download', idem_key: idem(), target_msg_id: message_id,
  })
  const { status, result } = await awaitResult(id, 60_000)
  if (status === 'failed') throw new Error((result as { error?: string })?.error ?? 'download failed')
  return { content: [{ type: 'text', text: (result as { path: string }).path }] }
}

async function handleZaloLogin(): Promise<ToolResult> {
  const id = enqueueOutbound({ kind: 'login', idem_key: idem() })
  const { status, result } = await awaitResult(id, 30_000)
  if (status === 'failed') throw new Error((result as { error?: string })?.error ?? 'login failed')
  const qrPath = (result as { qrPath: string }).qrPath
  return {
    content: [{
      type: 'text',
      text:
        `QR code written to ${qrPath} — show it to the user (Read the image). ` +
        `Scan with the Zalo app (Me > Settings > QR login) within ~100 seconds. ` +
        `Login completes in the background; credentials are saved automatically.`,
    }],
  }
}
