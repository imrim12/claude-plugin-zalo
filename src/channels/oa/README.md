# OA channel — coming soon

Zalo **Official Account** (OA) transport. Unlike `channels/user/` (which drives the
user's *personal* account over `zca-js`), this channel will speak the OA Open API
(webhook inbound + REST outbound) and represent a business account.

Planned surface — mirror `channels/user/` so the rest of the app stays channel-agnostic:

- `session.ts` — OA auth (access token refresh) + inbound delivery
- `inbound`/`tools` wiring through the shared `core/` (MCP server + access policy)
  and `handlers/` (the MCP ↔ channel bridge)

The shared pieces it will reuse as-is:

- `core/access.ts` — access policy store + `assertAllowedChat` (channel-agnostic)
- `core/mcp.ts` — the MCP `Server` singleton
- `constants/`, `utils/` — paths, logging, chunking
