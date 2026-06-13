import { describe, test, expect, afterEach } from "bun:test";
import { acquireDaemonLock, releaseDaemonLock } from "../src/core/lock.ts";

afterEach(() => releaseDaemonLock());

describe("daemon lock", () => {
  test("second acquire fails while held, succeeds after release", () => {
    expect(acquireDaemonLock()).toBe(true);
    // Same process already holds it — a re-acquire sees a live holder (us).
    expect(acquireDaemonLock()).toBe(false);
    releaseDaemonLock();
    // Now free again.
    expect(acquireDaemonLock()).toBe(true);
  });
});
