import { describe, expect, it } from "vitest";
import { FabricRepeatGuard } from "../src/repeat-guard.js";

describe("FabricRepeatGuard", () => {
  it("counts consecutive identical code and trips warn then block", () => {
    const g = new FabricRepeatGuard(3, 6);
    const code = "return 1";
    expect(g.observe(code)).toEqual({ count: 1, blocked: false, warn: false });
    expect(g.observe(code).count).toBe(2);
    expect(g.observe(code).warn).toBe(true);
    expect(g.observe(code).blocked).toBe(false);
    expect(g.observe(code).count).toBe(5);
    expect(g.observe(code).blocked).toBe(true);
    expect(g.observe(code).blocked).toBe(true);
  });

  it("resets on any differing code", () => {
    const g = new FabricRepeatGuard(3, 6);
    const code = "return 1";
    for (let i = 0; i < 5; i += 1) g.observe(code);
    expect(g.observe(code).blocked).toBe(true);
    expect(g.observe("return 2")).toEqual({ count: 1, blocked: false, warn: false });
  });

  it("ignores cosmetic variation: only the fingerprinted code matters", () => {
    // The 2026-09-15 incident: identical code executed 220+ times while the
    // display name incremented (noop1, noop2, ...). The fingerprint is the
    // code alone, so display churn does not reset the count.
    const g = new FabricRepeatGuard(3, 6);
    const loopCode = "const r = await pi.bash({ cmd: 'echo noop' }); return r?.output;";
    let verdict = { count: 0, blocked: false, warn: false };
    for (let i = 1; i <= 6; i += 1) {
      verdict = g.observe(loopCode);
      if (i >= 6) expect(verdict.blocked).toBe(true);
      if (i >= 3) expect(verdict.warn).toBe(true);
    }
    expect(verdict.count).toBe(6);
  });
});
