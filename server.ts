#!/usr/bin/env bun
// Entry shim — the implementation lives in src/. This launches the per-session
// PROXY (src/proxy.ts); the always-on Zalo daemon is src/daemon.ts (started by a
// Scheduled Task or spawned on demand by the proxy). Kept at the repo root so
// .mcp.json, `pnpm start`, and the tests can keep spawning `bun server.ts`.
import './src/proxy.ts'
