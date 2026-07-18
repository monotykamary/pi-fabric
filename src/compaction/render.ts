import { clipUtf8, MAX_SUMMARY_BYTES, utf8Bytes } from "./bounds.js";
import type { Sections } from "./projections.js";

const SECTION_ORDER: { key: keyof Sections; header: string; maxBytes: number }[] = [
  { key: "goal", header: "[Session Goal]", maxBytes: 4096 },
  { key: "files", header: "[Files And Changes]", maxBytes: 4608 },
  { key: "activity", header: "[Fabric Activity]", maxBytes: 2048 },
  { key: "outstanding", header: "[Outstanding Context]", maxBytes: 4608 },
  { key: "earlierTurns", header: "[Earlier Turns]", maxBytes: 3072 },
  { key: "status", header: "[Current Status]", maxBytes: 2048 },
];

const REQUEST_MAX_BYTES = 3072;
const TRANSCRIPT_MAX_BYTES = 5120;
const FOOTER_MAX_BYTES = 1536;
const MAX_INPUT_LINES_PER_SECTION = 128;
const MAX_RENDERED_LINE_BYTES = 1024;

export interface RenderOptions {
  firstEntryId: string;
  lastEntryId: string;
  lastTimestamp: string;
  requestLines?: string[];
  summaryKind?: "compaction" | "branch";
}

const POINTER_LINE =
  "For full pre-summary history, search the session log across this entry range (memory.recall / vcc_recall-style).";

const sampledLines = (lines: readonly string[], keep: number): string[] => {
  if (lines.length <= keep) return [...lines];
  const earliest = Math.ceil(keep / 2);
  const latest = Math.floor(keep / 2);
  return [
    ...lines.slice(0, earliest),
    `… omitted ${lines.length - keep} rendered lines`,
    ...lines.slice(lines.length - latest),
  ];
};

const boundedBlock = (header: string, sourceLines: readonly string[], maxBytes: number): string => {
  const clipped = sourceLines.map((line) => clipUtf8(line, MAX_RENDERED_LINE_BYTES));
  const capped = sampledLines(clipped, Math.min(clipped.length, MAX_INPUT_LINES_PER_SECTION));
  for (let keep = capped.length; keep >= 0; keep--) {
    const lines = sampledLines(capped, keep);
    const block = [header, ...lines].join("\n");
    if (utf8Bytes(block) <= maxBytes) return block;
  }
  return clipUtf8(header, maxBytes);
};

export const renderSummary = (sections: Sections, options: RenderOptions): string => {
  const blocks: string[] = [];
  for (const { key, header, maxBytes } of SECTION_ORDER) {
    const lines = sections[key];
    if (lines.length === 0) continue;
    blocks.push(boundedBlock(header, lines, maxBytes));
    if (key === "goal" && options.requestLines && options.requestLines.length > 0) {
      blocks.push(boundedBlock("[Compaction Request]", options.requestLines, REQUEST_MAX_BYTES));
    }
  }
  if (sections.goal.length === 0 && options.requestLines && options.requestLines.length > 0) {
    blocks.unshift(boundedBlock("[Compaction Request]", options.requestLines, REQUEST_MAX_BYTES));
  }

  if (sections.transcript.length > 0) {
    blocks.push(boundedBlock("---", sections.transcript, TRANSCRIPT_MAX_BYTES));
  }

  const timestamp = options.lastTimestamp || "(unknown time)";
  const range = options.firstEntryId || options.lastEntryId
    ? `${options.firstEntryId || "(start)"} → ${options.lastEntryId || "(end)"}`
    : "(no entries)";
  const footer = options.summaryKind === "branch"
    ? `[branch summarized ${timestamp}; structural source entries ${range}]`
    : `[compacted ${timestamp}; cumulative source entries ${range}]`;
  blocks.push(boundedBlock("---", [footer, POINTER_LINE], FOOTER_MAX_BYTES));

  const summary = `${blocks.join("\n\n")}\n`;
  if (utf8Bytes(summary) <= MAX_SUMMARY_BYTES) return summary;
  return `${clipUtf8(summary, MAX_SUMMARY_BYTES - 1, "")}\n`;
};
