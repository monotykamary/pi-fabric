import { describe, expect, it } from "vitest";
import {
  entropyReviewKey,
  formatEntropyCommandHints,
  formatEntropyCompileNotice,
  formatEntropyReviewNotice,
  type EntropyProposal,
} from "../src/entropy/index.js";

const declaration = (
  ref: string,
  key: string,
  values: string[],
  calls = 8,
): EntropyProposal => ({
  kind: "declare-enum",
  ref,
  key,
  values,
  calls,
  distinct: values.length,
  topShare: 0.5,
});

describe("entropy user-facing messages", () => {
  it("names the applied target and preserves metric precision", () => {
    expect(
      formatEntropyCompileNotice({
        beforeScore: 0.004458,
        afterScore: 0.004455,
        reviewCount: 13,
      }),
    ).toBe(
      "entropy: background optimization complete · 0 normal-form plans · canonical capabilities preserved · entropy score improved 0.004458 → 0.004455 (−0.000003; lower is better) · safety checks passed · 13 suggestions await review (/fabric entropy)",
    );
  });

  it("calls out a genuinely unchanged score instead of rendering a false reduction", () => {
    expect(
      formatEntropyCompileNotice({
        beforeScore: 0,
        afterScore: 0,
      }),
    ).toContain("entropy score unchanged at 0.000000 (lower is better)");
  });

  it("adds precision when a real change is smaller than six decimals", () => {
    const notice = formatEntropyCompileNotice({
      beforeScore: 0.0044580001,
      afterScore: 0.004458,
    });
    expect(notice).toContain("entropy score improved 0.0044580001 → 0.0044580000 (−0.0000000001; lower is better)");
    expect(notice).not.toContain("score unchanged");
  });

  it("aligns /fabric entropy command comments", () => {
    const lines = formatEntropyCommandHints();
    expect(lines).toEqual([
      "export: /fabric entropy export [path]          # snapshot the live surface (default <agent dir>/fabric/entropy/surface.json)",
      "share: /fabric entropy export-artifact [path]  # write the compiled artifact (default <agent dir>/fabric/entropy/artifact.json)",
      "merge: /fabric entropy import <path>           # merge a peer artifact (digest-proven entries only)",
    ]);
    expect(new Set(lines.map((line) => line.indexOf("#")))).toEqual(new Set([47]));
  });

  it("summarizes review suggestions in plain language", () => {
    const proposals: EntropyProposal[] = [
      declaration("mcp.render", "format", ["pdf", "html"]),
      declaration("agents.run", "runner", ["pi", "claude"]),
      { kind: "sequence-fuse", sequence: ["pi.grep", "pi.read"], occurrences: 3 },
    ];
    expect(formatEntropyReviewNotice(proposals)).toBe(
      "entropy: 3 suggestions await review · 2 enum declarations · 1 sequence fusion · inspect with /fabric entropy",
    );
  });

  it("deduplicates unchanged suggestions while detecting vocabulary changes", () => {
    const first = declaration("mcp.render", "format", ["pdf", "html"], 8);
    const moreEvidence = declaration("mcp.render", "format", ["pdf", "html"], 80);
    const changed = declaration("mcp.render", "format", ["pdf", "html", "docx"], 80);
    expect(entropyReviewKey([first])).toBe(entropyReviewKey([moreEvidence]));
    expect(entropyReviewKey([first, changed])).toBe(entropyReviewKey([changed, first]));
    expect(entropyReviewKey([changed])).not.toBe(entropyReviewKey([first]));
  });
});
