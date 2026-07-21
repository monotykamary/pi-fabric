import { describe, expect, it } from "vitest";
import { countNewlines } from "../src/util.js";

describe("countNewlines", () => {
  it("counts line-feed characters without normalizing other terminators", () => {
    expect(countNewlines("")).toBe(0);
    expect(countNewlines("one\ntwo\n")).toBe(2);
    expect(countNewlines("one\rtwo\r\nthree")).toBe(1);
  });
});
