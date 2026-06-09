import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// One shared temp dir for all test files in this run.
// server.ts reads ZALO_STATE_DIR at module-init time, so this must be set
// before any test spawns the server. Without it, a spawned test server would
// use the real state dir and its PID-takeover would kill a live session's
// listener (and could cookie-login with real credentials).
const tmpDir = await mkdtemp(path.join(os.tmpdir(), "zalo-test-"));
process.env.ZALO_STATE_DIR = tmpDir;

process.on("exit", () => {
  // Best-effort sync cleanup — async rm may not finish in exit handler,
  // but OS will reclaim /tmp on reboot anyway.
  try {
    const { rmSync } = require("node:fs");
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});
