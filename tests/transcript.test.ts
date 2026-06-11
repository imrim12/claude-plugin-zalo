import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { logInbound } from "../src/handlers/transcript.ts";

// ZALO_LOG_DIR resolves to <ZALO_STATE_DIR>/memory/zalo (tests/setup.ts sets
// ZALO_STATE_DIR). The logger lazily creates it on first write.
const LOG_DIR = path.join(process.env.ZALO_STATE_DIR!, "memory", "zalo");

describe("transcript logger", () => {
  test("appends a markdown line per message and a header on first write", () => {
    logInbound({
      chatId: "chat-A",
      threadType: "group",
      user: "Alice",
      userId: "u-1",
      text: "first message",
      ts: "2026-06-11T00:00:00.000Z",
      responded: true,
    });
    logInbound({
      chatId: "chat-A",
      threadType: "group",
      user: "Bob",
      userId: "u-2",
      text: "second message",
      ts: "2026-06-11T00:01:00.000Z",
      responded: false,
      attachment: "photo",
    });

    const body = readFileSync(path.join(LOG_DIR, "chat-A.md"), "utf8");
    expect(body).toContain("# Zalo group chat-A");
    expect(body).toContain("**Alice** (u-1): first message");
    // observe-only messages are tagged and don't expect a reply
    expect(body).toContain("**Bob** (u-2) _(observed)_: [photo] second message");
  });

  test("sanitizes chat ids and newlines so one message stays one line", () => {
    logInbound({
      chatId: "../escape",
      threadType: "user",
      user: "Mallory\ninjected",
      userId: "u-3",
      text: "line one\nline two",
      ts: "2026-06-11T00:02:00.000Z",
      responded: true,
    });
    // "../escape" → "escape" (no path traversal, no slashes)
    const body = readFileSync(path.join(LOG_DIR, "escape.md"), "utf8");
    const entry = body.split("\n").find((l) => l.includes("u-3"))!;
    expect(entry).toContain("Mallory injected");
    expect(entry).toContain("line one line two");
  });
});
