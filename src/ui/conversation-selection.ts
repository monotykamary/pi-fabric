import type { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

interface Point { row: number; col: number }
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** One immutable rendered-history reference; no history-sized copy on drag. */
export class ConversationTextSelection {
  source: string[] | undefined;
  private anchor: Point | undefined;
  private focus: Point | undefined;
  dragging = false;

  clear(): void {
    this.source = undefined;
    this.anchor = this.focus = undefined;
    this.dragging = false;
  }

  start(source: string[], row: number, col: number): void {
    this.source = source;
    this.anchor = this.point(row, col);
    this.focus = this.anchor;
    this.dragging = true;
  }

  move(row: number, col: number): void {
    if (this.dragging) this.focus = this.point(row, col);
  }

  finish(row: number, col: number): void {
    this.move(row, col);
    this.dragging = false;
    if (!this.bounds()) this.clear();
  }

  get active(): boolean { return this.bounds() !== undefined; }

  private point(row: number, col: number): Point {
    row = Math.max(0, Math.min(this.source!.length - 1, row));
    let boundary = 0;
    for (const { segment } of graphemes.segment(stripTerminalSequences(this.source![row] ?? ""))) {
      const next = boundary + visibleWidth(segment);
      if (next > col) break;
      boundary = next;
    }
    return { row, col: boundary };
  }

  private bounds(): { start: Point; end: Point } | undefined {
    const a = this.anchor;
    const b = this.focus;
    if (!a || !b || (a.row === b.row && a.col === b.col)) return undefined;
    return a.row < b.row || (a.row === b.row && a.col < b.col) ? { start: a, end: b } : { start: b, end: a };
  }

  text(): string | undefined {
    const bounds = this.bounds();
    if (!bounds || !this.source) return undefined;
    const lines: string[] = [];
    for (let row = bounds.start.row; row <= bounds.end.row; row++) {
      const line = this.source[row] ?? "";
      const start = row === bounds.start.row ? bounds.start.col : 0;
      const end = row === bounds.end.row ? bounds.end.col : visibleWidth(line);
      lines.push(stripTerminalSequences(sliceByColumn(line, start, end - start, true)).trimEnd());
    }
    return lines.join("\n") || undefined;
  }

  highlight(line: string, row: number, theme: Theme): string {
    const bounds = this.bounds();
    if (!bounds || row < bounds.start.row || row > bounds.end.row) return line;
    // Never slice/re-emit image control payloads while painting a selection.
    if (/\x1b(?:_G|\]1337;File=|P)/.test(line)) return line;
    const width = visibleWidth(line);
    const start = row === bounds.start.row ? bounds.start.col : 0;
    const end = row === bounds.end.row ? bounds.end.col : width;
    if (end <= start) return line;
    const selected = stripTerminalSequences(sliceByColumn(line, start, end - start, true));
    return sliceByColumn(line, 0, start, true) + theme.bg("selectedBg", theme.fg("text", selected)) +
      sliceByColumn(line, end, Math.max(0, width - end), true);
  }
}
