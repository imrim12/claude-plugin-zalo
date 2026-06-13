import { describe, test, expect, afterEach } from "bun:test";
import { lockCreate, lockDelete } from "../src/core/lock.ts";

afterEach(() => lockDelete());

describe("daemon lock", () => {
  test("second acquire fails while held, succeeds after release", () => {
    expect(lockCreate()).toBe(true);
    // Same process already holds it — a re-acquire sees a live holder (us).
    expect(lockCreate()).toBe(false);
    lockDelete();
    // Now free again.
    expect(lockCreate()).toBe(true);
  });
});
