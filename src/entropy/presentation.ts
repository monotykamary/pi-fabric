import type { EntropyProposal } from "./types.js";

const METRIC_PRECISION = 6;

const ENTROPY_COMMAND_HINTS = [
  {
    label: "export",
    command: "/fabric entropy export [path]",
    comment: "snapshot the live surface (default <agent dir>/fabric/entropy/surface.json)",
  },
  {
    label: "share",
    command: "/fabric entropy export-artifact [path]",
    comment: "write the compiled artifact (default <agent dir>/fabric/entropy/artifact.json)",
  },
  {
    label: "merge",
    command: "/fabric entropy import <path>",
    comment: "merge a peer artifact (digest-proven entries only)",
  },
] as const;

export const formatEntropyMetric = (value: number): string => value.toFixed(METRIC_PRECISION);

export const formatEntropyCommandHints = (): string[] => {
  const heads = ENTROPY_COMMAND_HINTS.map((hint) => `${hint.label}: ${hint.command}`);
  const commentColumn = Math.max(...heads.map((head) => head.length)) + 2;
  return ENTROPY_COMMAND_HINTS.map(
    (hint, index) => `${heads[index]!.padEnd(commentColumn)}# ${hint.comment}`,
  );
};

const scoreChange = (before: number, after: number): string => {
  if (before === after) {
    return `entropy score unchanged at ${formatEntropyMetric(before)} (lower is better)`;
  }
  let precision = METRIC_PRECISION;
  while (precision < 12 && before.toFixed(precision) === after.toFixed(precision)) precision += 1;
  const delta = after - before;
  const format = (value: number): string => value.toFixed(precision);
  const absoluteDelta = format(Math.abs(delta));
  const renderedDelta = Number(absoluteDelta) === 0
    ? Math.abs(delta).toExponential(2)
    : absoluteDelta;
  return `entropy score ${delta < 0 ? "improved" : "changed"} ${format(before)} → ${format(after)} (${delta > 0 ? "+" : "−"}${renderedDelta}; lower is better)`;
};

export const entropyReviewKey = (proposals: readonly EntropyProposal[]): string => {
  const identities = proposals.map((proposal): string => {
    if (proposal.kind === "declare-enum") {
      return JSON.stringify([
        proposal.kind,
        proposal.ref,
        proposal.key,
        proposal.values.map((value) => [typeof value, value]),
      ]);
    }
    if (proposal.kind === "overload-split") {
      return JSON.stringify([
        proposal.kind,
        proposal.ref,
        proposal.clusters.map((cluster) => cluster.keys),
      ]);
    }
    if (proposal.kind === "sequence-fuse") {
      return JSON.stringify([proposal.kind, proposal.sequence]);
    }
    return JSON.stringify([proposal.kind, proposal.ref]);
  });
  identities.sort();
  return JSON.stringify(identities);
};

const reviewLabel = (kind: EntropyProposal["kind"], count: number): string => {
  const noun = kind === "declare-enum"
    ? "enum declaration"
    : kind === "overload-split"
      ? "action split"
      : kind === "sequence-fuse"
        ? "sequence fusion"
        : kind;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
};

export const formatEntropyReviewNotice = (
  proposals: readonly EntropyProposal[],
): string => {
  const counts = new Map<EntropyProposal["kind"], number>();
  for (const proposal of proposals) counts.set(proposal.kind, (counts.get(proposal.kind) ?? 0) + 1);
  const summary = [...counts.entries()].map(([kind, count]) => reviewLabel(kind, count)).join(" · ");
  return `entropy: ${proposals.length} suggestion${proposals.length === 1 ? "" : "s"} await review${summary ? ` · ${summary}` : ""} · inspect with /fabric entropy`;
};

export const formatEntropyCompileNotice = (input: {
  beforeScore: number;
  afterScore: number;
  reviewCount?: number;
  normalizations?: number;
}): string => {
  const review = input.reviewCount
    ? ` · ${input.reviewCount} suggestion${input.reviewCount === 1 ? "" : "s"} await review (/fabric entropy)`
    : "";
  return `entropy: background optimization complete · ${input.normalizations ?? 0} normal-form plans · canonical capabilities preserved · ${scoreChange(input.beforeScore, input.afterScore)} · safety checks passed${review}`;
};
