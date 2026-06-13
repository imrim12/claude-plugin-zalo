import { describe, test, expect, afterEach } from "bun:test";
import { ThreadType, type Message } from "zca-js";
import { gate } from "../src/channels/user/gate.ts";
import { accessGet, accessUpdate, type Access } from "../src/core/access.ts";

// gate() reads/writes access.json under ZALO_STATE_DIR (set by tests/setup.ts),
// so each test starts from a known access state and restores defaults after.
function setAccess(partial: Partial<Access>): void {
  accessUpdate({
    dmPolicy: "pairing",
    allowFrom: [],
    groups: {},
    pending: {},
    ...partial,
  });
}

afterEach(() => {
  setAccess({});
});

function groupMsg(over: {
  threadId?: string;
  uidFrom?: string;
  content?: string;
  mentions?: Array<{ uid: string }>;
}): Message {
  return {
    type: ThreadType.Group,
    threadId: over.threadId ?? "g-1",
    isSelf: false,
    data: {
      uidFrom: over.uidFrom ?? "sender-1",
      content: over.content ?? "hello everyone",
      mentions: over.mentions,
      msgId: "m1",
      cliMsgId: "c1",
      ts: "0",
      dName: "Someone",
      msgType: "chat.text",
    },
  } as unknown as Message;
}

function dmMsg(uidFrom: string): Message {
  return {
    type: ThreadType.User,
    threadId: uidFrom,
    isSelf: false,
    data: {
      uidFrom,
      content: "hi",
      msgId: "m1",
      cliMsgId: "c1",
      ts: "0",
      dName: "Friend",
      msgType: "chat.text",
    },
  } as unknown as Message;
}

describe("gate — DM paths stay fail-secure", () => {
  test("allowlisted DM delivers and expects a reply", () => {
    setAccess({ dmPolicy: "allowlist", allowFrom: ["u-1"] });
    const r = gate(dmMsg("u-1"));
    expect(r.action).toBe("deliver");
    if (r.action === "deliver") expect(r.respond).toBe(true);
  });

  test("unknown DM under allowlist policy drops", () => {
    setAccess({ dmPolicy: "allowlist", allowFrom: [] });
    expect(gate(dmMsg("stranger")).action).toBe("drop");
  });

  test("disabled policy drops even allowlisted DMs", () => {
    setAccess({ dmPolicy: "disabled", allowFrom: ["u-1"] });
    expect(gate(dmMsg("u-1")).action).toBe("drop");
  });
});

describe("gate — groups are observe-by-default", () => {
  test("unknown group auto-registers and delivers observe-only (respond=false)", () => {
    setAccess({});
    const r = gate(groupMsg({ threadId: "g-new" }));
    expect(r.action).toBe("deliver");
    if (r.action === "deliver") expect(r.respond).toBe(false);
    // auto-registered so /zalo:access can see it and outbound replies pass
    expect(accessGet().groups["g-new"]).toEqual({
      requireMention: true,
      allowFrom: [],
      observe: true,
    });
  });

  test("mention pattern flips respond=true", () => {
    setAccess({ mentionPatterns: ["@assistant"] });
    const r = gate(groupMsg({ content: "yo @assistant help" }));
    expect(r.action).toBe("deliver");
    if (r.action === "deliver") expect(r.respond).toBe(true);
  });

  test("requireMention:false makes every message respondable", () => {
    setAccess({ groups: { "g-1": { requireMention: false, allowFrom: [], observe: true } } });
    const r = gate(groupMsg({ threadId: "g-1" }));
    if (r.action === "deliver") expect(r.respond).toBe(true);
  });

  test("muted group (observe:false) drops", () => {
    setAccess({ groups: { "g-1": { requireMention: true, allowFrom: [], observe: false } } });
    expect(gate(groupMsg({ threadId: "g-1" })).action).toBe("drop");
  });

  test("explicit per-group allowFrom hard-drops outside senders", () => {
    setAccess({ groups: { "g-1": { requireMention: false, allowFrom: ["vip"], observe: true } } });
    expect(gate(groupMsg({ threadId: "g-1", uidFrom: "rando" })).action).toBe("drop");
    const r = gate(groupMsg({ threadId: "g-1", uidFrom: "vip" }));
    if (r.action === "deliver") expect(r.respond).toBe(true);
  });

  test("disabled policy kills groups too", () => {
    setAccess({ dmPolicy: "disabled" });
    expect(gate(groupMsg({})).action).toBe("drop");
  });
});
