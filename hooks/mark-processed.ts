#!/usr/bin/env bun
// Optional PostToolUse hook for mcp__plugin_zalo_zalo__reply. The daemon already
// marks a chat processed on send success (watermark-scoped, in the same tx as the
// outbound status flip) — that is the source of truth. This hook is the
// belt-and-suspenders the user asked for: it lives visibly in their settings and
// marks the chat processed immediately after the reply tool returns. Idempotent
// with the daemon's own mark — both clamp by watermark (WHERE id <= watermark),
// so running both can never swallow a message that arrived after the watermark.
//
// Claude Code passes the hook a JSON event on stdin; for an MCP tool, tool_input
// is the tool's arguments object.
import { db } from '../src/core/db.ts'

type HookEvent = { tool_input?: { chat_id?: string; watermark_id?: string } }

const event = (await Bun.stdin.json()) as HookEvent
const chat = event.tool_input?.chat_id
const wm = event.tool_input?.watermark_id
if (chat && wm) {
  db().run('UPDATE messages SET processed=1, processed_at=?3 WHERE chat_id=?1 AND processed=0 AND id<=?2', [chat, Number(wm), Date.now()])
}
