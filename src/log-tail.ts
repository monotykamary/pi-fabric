import fs from "node:fs";
import type { FabricLogLine } from "./subagents/types.js";

const READ_CHUNK_BYTES = 64 * 1024;

export interface JsonlPage {
  lines: FabricLogLine[];
  hasMore: boolean;
  before?: number;
}

const parseLine = (offset: number, raw: string): FabricLogLine => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { offset, raw };
  }
  return { offset, raw, parsed };
};

interface BufferedLine {
  offset: number;
  raw: string;
}

const completeLines = (buffer: Buffer, bufferStart: number, fileEnd: number): BufferedLine[] => {
  const lines: BufferedLine[] = [];
  let start = 0;
  let first = true;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] !== 10) continue;
    if (!first || bufferStart === 0) {
      const raw = buffer.subarray(start, index).toString("utf8").replace(/\r$/, "");
      if (raw) lines.push({ offset: bufferStart + start, raw });
    }
    first = false;
    start = index + 1;
  }
  if (fileEnd === bufferStart + buffer.length && start < buffer.length) {
    if (!first || bufferStart === 0) {
      const raw = buffer.subarray(start).toString("utf8").replace(/\r$/, "");
      if (raw) lines.push({ offset: bufferStart + start, raw });
    }
  }
  return lines;
};

/** Read a bounded JSONL page backwards, touching only enough file chunks to fill it. */
export const readJsonlPage = (
  filePath: string,
  limit: number,
  before?: number,
): JsonlPage => {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, "r");
    const size = fs.fstatSync(descriptor).size;
    const fileEnd = typeof before === "number" && Number.isSafeInteger(before)
      ? Math.max(0, Math.min(before, size))
      : size;
    let buffer = Buffer.alloc(0);
    let bufferStart = fileEnd;
    let records: BufferedLine[] = [];

    while (bufferStart > 0 && records.length <= limit) {
      const length = Math.min(READ_CHUNK_BYTES, bufferStart);
      const chunkStart = bufferStart - length;
      const chunk = Buffer.allocUnsafe(length);
      const bytesRead = fs.readSync(descriptor, chunk, 0, length, chunkStart);
      if (bytesRead <= 0) break;
      buffer = Buffer.concat([chunk.subarray(0, bytesRead), buffer]);
      bufferStart = chunkStart;
      records = completeLines(buffer, bufferStart, fileEnd);
    }

    const selected = records.slice(-limit);
    const hasMore = selected.length > 0 && (records.length > selected.length || bufferStart > 0);
    return {
      lines: selected.map((line) => parseLine(line.offset, line.raw)),
      hasMore,
      ...(hasMore ? { before: selected[0]!.offset } : {}),
    };
  } catch {
    return { lines: [], hasMore: false };
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
};
