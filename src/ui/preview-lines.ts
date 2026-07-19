// Adapted from pi-code-previews; see THIRD_PARTY_NOTICES.md.

export type PreviewLineEntry<T> =
  | { kind: "line"; line: T; index: number }
  | { kind: "hidden"; hidden: number };

export function countContentLines(content: string): number {
  if (!content) return 0;
  let terminators = 0;
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index);
    if (code === 13) {
      terminators++;
      if (content.charCodeAt(index + 1) === 10) index++;
    } else if (code === 10) {
      terminators++;
    }
  }
  const finalCode = content.charCodeAt(content.length - 1);
  return terminators + (finalCode === 10 || finalCode === 13 ? 0 : 1);
}

export function selectPreviewTextLines(
  text: string,
  limit: number,
): { entries: Array<PreviewLineEntry<string>>; shown: number; hidden: number; total: number } {
  if (!Number.isInteger(limit)) {
    const lines = collectPreviewTextLines(text);
    return { ...selectPreviewLines(lines, limit), total: lines.length };
  }

  const entries: Array<PreviewLineEntry<string>> = [];
  const split = limit >= 8;
  const head = split ? Math.ceil(limit * 0.65) : limit;
  const tailLimit = split ? Math.max(1, limit - head - 1) : 0;
  const tail: Array<string | undefined> = [];
  let tailSize = 0;
  let tailCursor = 0;
  let total = 0;
  forEachPreviewTextLine(text, (line, index) => {
    total++;
    if (limit <= 0 || index < limit) entries.push({ kind: "line", line, index });
    if (!split || index < head) return;
    tail[tailCursor] = line;
    if (++tailCursor === tailLimit) tailCursor = 0;
    if (tailSize < tailLimit) tailSize++;
  });

  if (limit <= 0 || total <= limit) return { entries, shown: total, hidden: 0, total };
  if (!split) return { entries, shown: limit, hidden: total - limit, total };
  const hidden = total - head - tailLimit;
  const selected = entries.slice(0, head);
  selected.push({ kind: "hidden", hidden });
  let tailSlot = tailSize === tailLimit ? tailCursor : 0;
  for (let offset = 0; offset < tailSize; offset++) {
    const line = tail[tailSlot];
    if (line === undefined) throw new RangeError(`Missing preview tail line ${offset}`);
    selected.push({ kind: "line", line, index: total - tailSize + offset });
    if (++tailSlot === tailLimit) tailSlot = 0;
  }
  return { entries: selected, shown: head + tailLimit, hidden, total };
}

function selectPreviewLines<T>(
  lines: T[],
  limit: number,
): { entries: Array<PreviewLineEntry<T>>; shown: number; hidden: number } {
  if (lines.length <= limit || limit <= 0) {
    return {
      entries: lines.map((line, index) => ({ kind: "line", line, index })),
      shown: lines.length,
      hidden: 0,
    };
  }
  if (limit < 8) {
    return {
      entries: lines.slice(0, limit).map((line, index) => ({ kind: "line", line, index })),
      shown: limit,
      hidden: lines.length - limit,
    };
  }
  const head = Math.ceil(limit * 0.65);
  const tail = Math.max(1, limit - head - 1);
  const hidden = lines.length - head - tail;
  return {
    entries: [
      ...lines.slice(0, head).map((line, index) => ({ kind: "line" as const, line, index })),
      { kind: "hidden", hidden },
      ...lines.slice(-tail).map((line, offset) => ({
        kind: "line" as const,
        line,
        index: lines.length - tail + offset,
      })),
    ],
    shown: head + tail,
    hidden,
  };
}

function collectPreviewTextLines(text: string): string[] {
  const lines: string[] = [];
  forEachPreviewTextLine(text, (line) => lines.push(line));
  return lines;
}

function forEachPreviewTextLine(
  text: string,
  callback: (line: string, index: number) => void,
): void {
  let index = 0;
  let pendingEmpty = 0;
  forEachRawTextLine(text, (line) => {
    if (line === "") {
      pendingEmpty++;
      return;
    }
    while (pendingEmpty > 0) {
      callback("", index++);
      pendingEmpty--;
    }
    callback(line, index++);
  });
  if (index === 0 && pendingEmpty > 0 && text.length > 0) callback("", index);
}

function forEachRawTextLine(text: string, callback: (line: string) => void): void {
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    if (newline < 0) {
      callback(text.slice(start));
      break;
    }
    callback(text.slice(start, newline));
    start = newline + 1;
  }
}
