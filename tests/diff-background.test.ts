import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { wrapDiffAnsiToWidth } from "../src/ui/diff-background.js";

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

describe("diff ANSI wrapping", () => {
  it("preserves short printable spans exactly", () => {
    const text = "\x1b[31mconst value = 1;\x1b[39m";
    expect(wrapDiffAnsiToWidth(text, 80)).toEqual([text]);
  });

  it("carries active styles across rows", () => {
    expect(wrapDiffAnsiToWidth("\x1b[31mabcdef\x1b[39m", 3, 3)).toEqual([
      "\x1b[31mabc",
      "\x1b[31mdef\x1b[39m",
    ]);
  });

  it("uses terminal cell widths for wide graphemes", () => {
    const rows = wrapDiffAnsiToWidth(`\x1b[31m${"漢".repeat(8)}\x1b[39m`, 6, 10);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => visibleWidth(row) <= 6)).toBe(true);
    expect(stripAnsi(rows[0] ?? "")).toBe("漢漢漢");
  });

  it("drops an overwide continuation gutter rather than losing content", () => {
    const rows = wrapDiffAnsiToWidth("abcdef", 3, 4, "     ");
    expect(rows.every((row) => visibleWidth(row) <= 3)).toBe(true);
    expect(stripAnsi(rows.join(""))).toContain("abcdef");
  });
});
