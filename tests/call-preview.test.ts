import { describe, expect, it } from "vitest";
import { HEADLINE_ARG_KEYS, headlineArg } from "../src/core/call-preview.js";

describe("headlineArg", () => {
  it("picks the query for an extension tool like vcc_recall", () => {
    expect(headlineArg({ query: "how do I recall X" })).toBe("how do I recall X");
  });

  it("prefers task over path over query (dashboard order)", () => {
    expect(headlineArg({ query: "q", path: "p", task: "t" })).toBe("t");
    expect(headlineArg({ query: "q", path: "p" })).toBe("p");
    expect(headlineArg({ query: "q" })).toBe("q");
  });

  it("falls back to the first non-meta string arg for unknown keys", () => {
    expect(headlineArg({ haystack: "needle", mode: "fast", limit: 10 })).toBe("needle");
  });

  it("skips structural/metadata keys in the fallback", () => {
    expect(headlineArg({ mode: "fast", limit: 10, type: "x" })).toBeUndefined();
  });

  it("returns undefined when there are no string args", () => {
    expect(headlineArg({ count: 3, active: true })).toBeUndefined();
    expect(headlineArg(undefined)).toBeUndefined();
    expect(headlineArg({})).toBeUndefined();
  });

  it("collapses whitespace and truncates to one line with an ellipsis", () => {
    const result = headlineArg({ query: "a".repeat(200) }, 10);
    expect(result?.endsWith("…")).toBe(true);
    expect(result?.length).toBe(10);
    expect(headlineArg({ query: "line1\nline2\ttab" })).toBe("line1 line2 tab");
  });

  it("exposes the priority key list", () => {
    expect(HEADLINE_ARG_KEYS[0]).toBe("task");
    expect(HEADLINE_ARG_KEYS).toContain("query");
  });
});
