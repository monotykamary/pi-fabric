// Adapted from pi-code-previews; see THIRD_PARTY_NOTICES.md.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type DiffBackgroundIntensity = "off" | "subtle" | "medium";
export type DiffLineKind = "add" | "remove";

const DIFF_ADD_MARKER = "\u0000PI_DIFF_ADD\u0000";
const DIFF_REMOVE_MARKER = "\u0000PI_DIFF_REMOVE\u0000";

export const markDiffLine = (kind: DiffLineKind, line: string): string =>
  (kind === "add" ? DIFF_ADD_MARKER : DIFF_REMOVE_MARKER) + line;

export const parseMarkedDiffLine = (
  rawLine: string,
): { kind?: DiffLineKind; line: string } => {
  const addIndex = rawLine.indexOf(DIFF_ADD_MARKER);
  if (addIndex >= 0) {
    return {
      kind: "add",
      line: rawLine.slice(0, addIndex) + rawLine.slice(addIndex + DIFF_ADD_MARKER.length),
    };
  }
  const removeIndex = rawLine.indexOf(DIFF_REMOVE_MARKER);
  if (removeIndex >= 0) {
    return {
      kind: "remove",
      line: rawLine.slice(0, removeIndex) + rawLine.slice(removeIndex + DIFF_REMOVE_MARKER.length),
    };
  }
  return { line: rawLine };
};

export const createDiffBackgroundResolver = (
  theme: Theme | undefined,
  intensity: DiffBackgroundIntensity,
): ((kind: DiffLineKind) => string | undefined) => {
  if (intensity === "off") return () => undefined;
  const cache: Partial<Record<DiffLineKind, string>> = {};
  return (kind) =>
    (cache[kind] ??=
      deriveDiffBg(kind, theme, intensity === "medium" ? 0.24 : 0.14) ??
      fallbackDiffBg(kind, intensity));
};

export const applyDiffBackground = (
  line: string,
  background: string | undefined,
): string => {
  if (!background) return line;
  const colored = line
    .replace(/\x1b\[0m/g, "\x1b[0m" + background)
    .replace(/\x1b\[39m/g, "\x1b[39m" + background)
    .replace(/\x1b\[49m/g, "\x1b[49m" + background);
  return background + colored;
};

const fallbackDiffBg = (
  kind: DiffLineKind,
  intensity: Exclude<DiffBackgroundIntensity, "off">,
): string => {
  if (kind === "add") {
    return intensity === "medium" ? "\x1b[48;2;22;68;40m" : "\x1b[48;2;10;42;26m";
  }
  return intensity === "medium" ? "\x1b[48;2;78;36;40m" : "\x1b[48;2;50;24;30m";
};

const deriveDiffBg = (
  kind: DiffLineKind,
  theme: Theme | undefined,
  intensity: number,
): string | undefined => {
  const themed = theme as
    | (Theme & { getFgAnsi?: (key: string) => string; getBgAnsi?: (key: string) => string })
    | undefined;
  const fg = themed?.getFgAnsi?.(kind === "add" ? "toolDiffAdded" : "toolDiffRemoved");
  const fgRgb = parseAnsiRgb(fg ?? "");
  if (!fgRgb) return undefined;
  const base =
    parseAnsiRgb(themed?.getBgAnsi?.(kind === "add" ? "toolSuccessBg" : "toolErrorBg") ?? "") ??
    parseAnsiRgb(themed?.getBgAnsi?.("toolSuccessBg") ?? "") ??
    { r: 0, g: 0, b: 0 };
  return `\x1b[48;2;${Math.round(base.r + (fgRgb.r - base.r) * intensity)};${Math.round(base.g + (fgRgb.g - base.g) * intensity)};${Math.round(base.b + (fgRgb.b - base.b) * intensity)}m`;
};

const PRINTABLE_ASCII_RE = /^[\x20-\x7e]*$/;
const TRUNCATION_SAFE_RE = /^(?:[\x20-\x7e\t]|\x1b\[[0-9;]*m)*$/;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const wrapDiffAnsiToWidth = (
  text: string,
  width: number,
  maxRows = 3,
  continuationPrefix = "",
): string[] => {
  if (width <= 0) return [""];
  const rows: string[] = [];
  let row = "";
  let rowWidth = 0;
  let index = 0;
  let state = "";
  const continuationWidth = visibleWidth(continuationPrefix);

  const pushRow = (): boolean => {
    rows.push(truncateWrappedRow(row, rowWidth, width));
    if (rows.length >= maxRows) {
      truncateLastRow(rows, width);
      return false;
    }
    row = continuationPrefix ? state + continuationPrefix : state;
    rowWidth = continuationWidth;
    return true;
  };

  while (index < text.length) {
    const ansi = extractSgr(text, index);
    if (ansi) {
      row += ansi.sequence;
      state = updateAnsiState(state, ansi.sequence);
      index += ansi.sequence.length;
      continue;
    }

    const nextAnsi = text.indexOf("\x1b", index);
    const plainEnd = nextAnsi >= 0 ? nextAnsi : text.length;
    const plain = text.slice(index, plainEnd);
    const remainingWidth = width - rowWidth;
    if (plain.length <= remainingWidth && PRINTABLE_ASCII_RE.test(plain)) {
      row += plain;
      rowWidth += plain.length;
    } else {
      for (const { segment } of segmenter.segment(plain)) {
        const segmentWidth = visibleWidth(segment);
        if (rowWidth > 0 && rowWidth + segmentWidth > width && !pushRow()) return rows;
        if (rowWidth > 0 && rowWidth + segmentWidth > width) {
          row = state;
          rowWidth = 0;
        }
        if (segmentWidth > width && rowWidth === 0) {
          const clipped = truncateToWidth(segment, width, "");
          if (clipped) {
            row += clipped;
            rowWidth += visibleWidth(clipped);
          }
          if (!pushRow()) return rows;
          continue;
        }
        row += segment;
        rowWidth += segmentWidth;
      }
    }
    index = plainEnd;
  }

  rows.push(truncateWrappedRow(row, rowWidth, width));
  if (rows.length > maxRows) return truncateLastRow(rows.slice(0, maxRows), width);
  return rows;
};

const truncateWrappedRow = (row: string, rowWidth: number, width: number): string => {
  if (rowWidth <= width && TRUNCATION_SAFE_RE.test(row)) return row;
  return truncateToWidth(row, width, "");
};

const truncateLastRow = (rows: string[], width: number): string[] => {
  const last = rows.at(-1) ?? "";
  if (visibleWidth(last) >= width && width > 1) {
    rows[rows.length - 1] = truncateToWidth(last, width - 1, "") + "›";
  }
  return rows;
};

const extractSgr = (text: string, index: number): { sequence: string } | undefined => {
  if (text[index] !== "\x1b" || text[index + 1] !== "[") return undefined;
  let end = index + 2;
  while (end < text.length && text[end] !== "m") end++;
  if (end >= text.length) return undefined;
  return { sequence: text.slice(index, end + 1) };
};

const updateAnsiState = (current: string, sequence: string): string => {
  if (sequence === "\x1b[0m") return "";
  if (/^\x1b\[3(?:8;[^m]+|9)m$/.test(sequence)) {
    return replaceAnsi(current, /\x1b\[3(?:8;[^m]+|9)m/g, sequence === "\x1b[39m" ? "" : sequence);
  }
  if (/^\x1b\[4(?:8;[^m]+|9)m$/.test(sequence)) {
    return replaceAnsi(current, /\x1b\[4(?:8;[^m]+|9)m/g, sequence === "\x1b[49m" ? "" : sequence);
  }
  if (sequence === "\x1b[22m") return current.replace(/\x1b\[(?:1|2)m/g, "");
  if (sequence === "\x1b[1m") return replaceAnsi(current, /\x1b\[1m/g, sequence);
  if (sequence === "\x1b[2m") return replaceAnsi(current, /\x1b\[2m/g, sequence);
  if (sequence === "\x1b[3m" || sequence === "\x1b[23m") {
    return replaceAnsi(current, /\x1b\[(?:3|23)m/g, sequence === "\x1b[23m" ? "" : sequence);
  }
  if (sequence === "\x1b[4m" || sequence === "\x1b[24m") {
    return replaceAnsi(current, /\x1b\[(?:4|24)m/g, sequence === "\x1b[24m" ? "" : sequence);
  }
  return current + sequence;
};

const replaceAnsi = (current: string, pattern: RegExp, replacement: string): string =>
  current.replace(pattern, "") + replacement;

const parseAnsiRgb = (ansi: string): { r: number; g: number; b: number } | undefined => {
  const match = ansi.match(/\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m/);
  if (!match) return undefined;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
};
