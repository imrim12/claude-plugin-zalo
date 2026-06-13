import { describe, test, expect } from "bun:test";
import {
  db, insertMessage, claimInbound, unprocessedForChat, enqueueOutbound,
  completeOutbound, getOutbound, setMessageLocalPath, getMessageByMsgId,
} from "../src/core/db.ts";

// All tests share one DB under ZALO_STATE_DIR (tests/setup.ts). Use distinct
// chat ids per test so rows don't collide across cases.
function ins(chat: string, opts: Partial<Parameters<typeof insertMessage>[0]> = {}) {
  return insertMessage({
    chatId: chat, threadType: "user", senderId: "s", text: "t",
    shouldReply: true, ts: Date.now(), tsIso: new Date().toISOString(), ...opts,
  });
}

describe("db", () => {
  test("schema creates and db() is a singleton", () => {
    expect(db()).toBe(db());
  });

  test("claimInbound returns disjoint sets for two sessions", () => {
    const chat = "claim-1";
    for (let i = 0; i < 6; i++) ins(chat, { msgId: `${chat}-${i}` });
    const a = claimInbound("sessA", 0, 100);
    const b = claimInbound("sessB", 0, 100);
    const ids = new Set([...a, ...b].map(r => r.id));
    // No id appears in both sets.
    expect(ids.size).toBe(a.length + b.length);
    expect(a.every(r => r.chat_id !== undefined)).toBe(true);
    // A third claim sees nothing new for this chat.
    const c = claimInbound("sessC", 0, 100).filter(r => r.chat_id === chat);
    expect(c.length).toBe(0);
  });

  test("rows below the freshness floor are not claimed", () => {
    const chat = "fresh-1";
    const id = ins(chat, { msgId: `${chat}-old` });
    // floor in the future → nothing qualifies
    const none = claimInbound("s", Date.now() + 60_000).filter(r => r.id === id);
    expect(none.length).toBe(0);
    // floor in the past → it qualifies
    const got = claimInbound("s", 0).filter(r => r.id === id);
    expect(got.length).toBe(1);
  });

  test("duplicate msg_id insert is ignored", () => {
    const first = ins("dup-1", { msgId: "dupe" });
    const second = ins("dup-1", { msgId: "dupe" });
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0); // INSERT OR IGNORE → rowid 0
  });

  test("duplicate idem_key enqueue throws (UNIQUE)", () => {
    enqueueOutbound({ kind: "reply", idem_key: "uniq-1", chat_id: "x", thread_type: "user", payload: "{}" });
    expect(() => enqueueOutbound({ kind: "reply", idem_key: "uniq-1", chat_id: "x", thread_type: "user", payload: "{}" })).toThrow();
  });

  test("watermark mark-processed leaves newer rows unprocessed", () => {
    const chat = "wm-1";
    const id1 = ins(chat, { msgId: "wm-a" });
    const id2 = ins(chat, { msgId: "wm-b" });
    const id3 = ins(chat, { msgId: "wm-c" });
    const out = enqueueOutbound({ kind: "reply", idem_key: "wm-out", chat_id: chat, thread_type: "user", watermark_id: id2, payload: "{}" });
    completeOutbound(out, "sent", { sentIds: [1] }, { chatId: chat, watermarkId: id2 });
    expect(getOutbound(out)?.status).toBe("sent");
    // id1,id2 processed; id3 (> watermark) still unprocessed.
    const unproc = unprocessedForChat(chat, id3).map(r => r.id);
    expect(unproc).toContain(id3);
    expect(unproc).not.toContain(id1);
    expect(unproc).not.toContain(id2);
  });

  test("setMessageLocalPath persists onto the row", () => {
    ins("lp-1", { msgId: "lp-a" });
    const row = getMessageByMsgId("lp-a")!;
    setMessageLocalPath(row.id, "/tmp/x.jpg");
    expect(getMessageByMsgId("lp-a")?.local_path).toBe("/tmp/x.jpg");
  });
});
