// The 4 MCP tools: reply, react, download_attachment, zalo_login.
// All outbound actions are gated by assertAllowedChat.
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { ThreadType, type SendMessageQuote } from 'zca-js'
import { mcp } from '../core/mcp.ts'
import { requireApi, beginQRLogin } from '../channels/user/session.ts'
import { loadAccess, assertAllowedChat, MAX_CHUNK_LIMIT } from '../core/access.ts'
import { chunk } from '../utils/chunk.ts'
import { toReaction } from '../channels/user/reactions.ts'
import { getCachedMessage } from '../channels/user/message-cache.ts'
import { attachmentHref, downloadToInbox, extFor } from '../channels/user/attachments.ts'

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
          },
          required: ['chat_id', 'text'],
        },
      },
      {
        name: 'react',
        description:
          'Add a reaction to a Zalo message. Accepts common emoji (👍 👎 ❤️ 😂 😮 😢 😡 🎉 ✅ …) or a raw zca reaction code. Only messages received this session can be reacted to.',
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

async function handleReply(args: Record<string, unknown>): Promise<ToolResult> {
  const chat_id = args.chat_id as string
  const text = args.text as string
  const threadType = args.thread_type === 'group' ? ThreadType.Group : ThreadType.User
  const reply_to = args.reply_to as string | undefined

  assertAllowedChat(chat_id)
  const zaloApi = requireApi()

  const access = loadAccess()
  const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
  const mode = access.chunkMode ?? 'length'
  const replyMode = access.replyToMode ?? 'first'
  const chunks = chunk(text, limit, mode)
  const sentIds: number[] = []

  let quote: SendMessageQuote | undefined
  if (reply_to != null && replyMode !== 'off') {
    const cached = getCachedMessage(reply_to)
    if (!cached) throw new Error(`message ${reply_to} not seen this session — cannot quote it, omit reply_to`)
    quote = {
      content: cached.data.content,
      msgType: cached.data.msgType,
      propertyExt: cached.data.propertyExt,
      uidFrom: cached.data.uidFrom,
      msgId: cached.data.msgId,
      cliMsgId: cached.data.cliMsgId,
      ts: cached.data.ts,
      ttl: cached.data.ttl,
    }
  }

  try {
    for (let i = 0; i < chunks.length; i++) {
      const shouldQuote = quote != null && (replyMode === 'all' || i === 0)
      const sent = await zaloApi.sendMessage(
        shouldQuote ? { msg: chunks[i], quote } : { msg: chunks[i] },
        chat_id,
        threadType,
      )
      if (sent.message?.msgId != null) sentIds.push(sent.message.msgId)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`,
    )
  }

  const result =
    sentIds.length === 1
      ? `sent (id: ${sentIds[0]})`
      : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
  return { content: [{ type: 'text', text: result }] }
}

async function handleReact(args: Record<string, unknown>): Promise<ToolResult> {
  const chat_id = args.chat_id as string
  const message_id = args.message_id as string
  assertAllowedChat(chat_id)
  const zaloApi = requireApi()
  const cached = getCachedMessage(message_id)
  if (!cached) throw new Error(`message ${message_id} not seen this session — cannot react to it`)
  await zaloApi.addReaction(toReaction(args.emoji as string), {
    data: { msgId: cached.data.msgId, cliMsgId: cached.data.cliMsgId },
    threadId: cached.threadId,
    type: cached.type,
  })
  return { content: [{ type: 'text', text: 'reacted' }] }
}

async function handleDownloadAttachment(args: Record<string, unknown>): Promise<ToolResult> {
  const message_id = args.message_id as string
  const cached = getCachedMessage(message_id)
  if (!cached) throw new Error(`message ${message_id} not seen this session — cannot fetch its attachment`)
  // Outbound-gate the source chat too: a message cached before an
  // allowlist revocation shouldn't stay fetchable after it.
  assertAllowedChat(cached.threadId)
  const href = attachmentHref(cached.data)
  if (!href) throw new Error(`message ${message_id} has no downloadable attachment`)
  const path = await downloadToInbox(href, extFor(cached.data), message_id)
  return { content: [{ type: 'text', text: path }] }
}

async function handleZaloLogin(): Promise<ToolResult> {
  const qrPath = await beginQRLogin()
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
