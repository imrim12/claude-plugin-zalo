import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dir, "..");

// This integration test runs a REAL daemon process (with a fake Zalo API) against
// its OWN temp state dir — isolated from the shared ZALO_STATE_DIR the other test
// files use, so its on-disk daemon.lock and messages.db never collide with
// lock.test.ts / db.test.ts.
const dir = mkdtempSync(path.join(os.tmpdir(), "zalo-daemon-"));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let daemon: any;

// Run a one-off db.ts operation in a subprocess scoped to the isolated dir, so we
// exercise the real helpers (not a hand-rolled SQL shim) against the daemon's DB.
function q(script: string): string {
  const p = Bun.spawnSync(["bun", "-e", `import('./src/core/db.ts').then(async m=>{m.db();${script}})`], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ZALO_STATE_DIR: dir, ZALO_FAKE: "1" },
  });
  return new TextDecoder().decode(p.stdout).trim();
}

async function until(fn: () => boolean, ms = 12_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (fn()) return true; await Bun.sleep(250); }
  return fn();
}

beforeAll(async () => {
  writeFileSync(path.join(dir, "access.json"), JSON.stringify({ dmPolicy: "allowlist", allowFrom: ["u123"], groups: {}, pending: {} }));
  daemon = Bun.spawn(["bun", "src/daemon.ts"], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ZALO_STATE_DIR: dir, ZALO_FAKE: "1" },
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  // Wait for the daemon to publish a heartbeat.
  await until(() => q("console.log(m.getMeta('heartbeat')?'1':'0')") === "1");
}, 20_000);

afterAll(async () => {
  daemon?.kill();
  await daemon?.exited;
  rmSync(dir, { recursive: true, force: true });
});

describe("daemon integration (ZALO_FAKE)", () => {
  test("a synthetic inbound DM becomes a should_reply messages row", async () => {
    writeFileSync(path.join(dir, "fake-inbound.jsonl"),
      JSON.stringify({ uidFrom: "u123", msgId: "dm1", cliMsgId: "c1", msgType: "webchat", content: "hi", dName: "T", ts: "1781000000000", idTo: "u123", threadId: "u123" }) + "\n");
    const ok = await until(() => q("const r=m.getMessageByMsgId('dm1');console.log(r&&r.should_reply===1?'1':'0')") === "1");
    expect(ok).toBe(true);
  }, 15_000);

  test("an outbound reply is drained to sent and watermark-processes the chat", async () => {
    // Enqueue a reply watermarked at the inbound row's id.
    const rowId = q("const r=m.getMessageByMsgId('dm1');console.log(r?r.id:'')");
    expect(rowId).not.toBe("");
    q(`m.enqueueOutbound({kind:'reply',idem_key:'itest',chat_id:'u123',thread_type:'user',watermark_id:${rowId},payload:JSON.stringify({chunks:['ok']})});console.log('enq')`);
    const sent = await until(() => q("console.log(m.db().query(\"SELECT status FROM outbound WHERE idem_key='itest'\").get()?.status||'')") === "sent");
    expect(sent).toBe(true);
    // The inbound row (id <= watermark) is now processed.
    const processed = q("const r=m.getMessageByMsgId('dm1');console.log(r&&r.processed===1?'1':'0')");
    expect(processed).toBe("1");
  }, 15_000);
});
