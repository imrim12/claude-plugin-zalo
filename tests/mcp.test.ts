import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dir, "..");

// ── Line-oriented reader for the server's stdout ──────────────────────────────

class LineReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf = "";
  private pending: string[] = [];
  private waiters: Array<(line: string) => void> = [];
  private dec = new TextDecoder();

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
    this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) break;
        this.buf += this.dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) !== -1) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (!line) continue;
          const waiter = this.waiters.shift();
          if (waiter) waiter(line);
          else this.pending.push(line);
        }
      }
    } catch {
      // stream closed — normal on process kill
    }
  }

  next(timeout = 12_000): Promise<string> {
    if (this.pending.length > 0) return Promise.resolve(this.pending.shift()!);
    return new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("MCP response timeout")), timeout);
      this.waiters.push((line) => { clearTimeout(t); resolve(line); });
    });
  }
}

// ── Process + helpers ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let proc: any;
let reader: LineReader;
let seq = 0;

function send(msg: object): void {
  proc.stdin.write(JSON.stringify(msg) + "\n");
  proc.stdin.flush();
}

async function rpc(method: string, params: object = {}): Promise<{ result?: unknown; error?: unknown }> {
  const id = ++seq;
  send({ jsonrpc: "2.0", id, method, params });
  for (;;) {
    const line = await reader.next();
    const parsed = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown };
    if (parsed.id === id) return parsed;
    // skip notifications (no id) and responses for other ids
  }
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };

function toolText(resp: { result?: unknown }): string {
  return ((resp.result as ToolResult).content[0]).text;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!process.env.ZALO_STATE_DIR) throw new Error("ZALO_STATE_DIR not set — tests/setup.ts must preload");
  proc = Bun.spawn(["bun", "server.ts"], {
    cwd: PROJECT_ROOT,
    // env must be passed EXPLICITLY: on Windows, Bun.spawn children inherit
    // the original environment block, not process.env mutations — so the
    // ZALO_STATE_DIR set in tests/setup.ts would silently not propagate and
    // the spawned server would run against the REAL state dir (PID-takeover
    // of a live session, cookie login with real credentials).
    env: { ...process.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",  // server errors visible in test output
  });
  reader = new LineReader(proc.stdout as ReadableStream<Uint8Array>);

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-runner", version: "1" },
  });

  if (!init.result) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);

  // Complete the handshake (notification — no response)
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
}, 20_000);

afterAll(() => {
  proc?.kill();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MCP protocol", () => {
  test("spawned server uses the temp state dir, not the real one", () => {
    // Guards the env propagation above: the server writes its own pid into
    // <state dir>/bot.pid at boot. If that file is missing from the temp dir,
    // the server is running against the real state dir — which would have
    // just SIGTERM'd a live session's listener.
    const pidFile = path.join(process.env.ZALO_STATE_DIR!, "bot.pid");
    const written = readFileSync(pidFile, "utf8");
    expect(written).toBe(String(proc.pid));
  });

  test("tools/list returns exactly the 4 expected tools", async () => {
    const resp = await rpc("tools/list", {});
    const tools = (resp.result as { tools: Array<{ name: string }> }).tools;

    expect(tools).toHaveLength(4);

    const names = tools.map((t) => t.name);
    for (const name of ["reply", "react", "download_attachment", "zalo_login"]) {
      expect(names).toContain(name);
    }
  });

  test("reply to a non-allowlisted chat returns isError with allowlist message", async () => {
    const resp = await rpc("tools/call", {
      name: "reply",
      arguments: { chat_id: "999", text: "hi" },
    });
    const result = resp.result as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not allowlisted");
  });

  test("react to an unseen message on an unknown chat returns isError", async () => {
    const resp = await rpc("tools/call", {
      name: "react",
      arguments: { chat_id: "999", message_id: "1", emoji: "👍" },
    });
    const result = resp.result as ToolResult;
    expect(result.isError).toBe(true);
  });

  test("unknown tool returns isError", async () => {
    const resp = await rpc("tools/call", { name: "does_not_exist", arguments: {} });
    const result = resp.result as ToolResult;
    expect(result.isError).toBe(true);
    expect(toolText(resp)).toContain("unknown tool");
  });
});

// ── State-dir resolution ────────────────────────────────────────────────────

describe("state dir resolution", () => {
  // Spawns a server with ZALO_STATE_DIR REMOVED and CLAUDE_PROJECT_DIR pointing
  // at a temp project that already contains a `.claude/` folder. The server
  // must write its state under <project>/.claude/channels/zalo — never the real
  // home dir. (A temp project WITHOUT `.claude` would fall back to ~/.claude, so
  // we always create `.claude` first to keep the test off the real state dir.)
  test("a project-local .claude is adopted over the home dir", async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), "zalo-proj-"));
    mkdirSync(path.join(projectDir, ".claude"), { recursive: true });

    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env.ZALO_STATE_DIR;
    env.CLAUDE_PROJECT_DIR = projectDir;

    const child = Bun.spawn(["bun", "server.ts"], {
      cwd: PROJECT_ROOT,
      env,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });

    const pidFile = path.join(projectDir, ".claude", "channels", "zalo", "bot.pid");
    try {
      // The server writes bot.pid at boot; poll briefly for it to appear.
      let written: string | undefined;
      for (let i = 0; i < 50 && written === undefined; i++) {
        try { written = readFileSync(pidFile, "utf8"); } catch { await Bun.sleep(100); }
      }
      expect(written).toBe(String(child.pid));
    } finally {
      child.kill();
      await child.exited;
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 15_000);
});
