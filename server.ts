#!/usr/bin/env bun
// Entry shim — the implementation lives in src/ (start at src/main.ts).
// Kept at the repo root so .mcp.json, `pnpm start`, and tests/mcp.test.ts
// can keep spawning `bun server.ts`.
import './src/main.ts'
