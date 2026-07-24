import fs from "node:fs";
import type { FabricLogLine } from "./agents/types.js";

const READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_READ_MAX_BYTES = 8 * 1024 * 1024;

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

/** Read a bounded JSONL page backwards from an already validated descriptor. */
export const readJsonlPageFromDescriptor = (
  descriptor: number,
  limit: number,
  before?: number,
  knownSize?: number,
  maxBytes?: number,
): JsonlPage => {
  try {
    const size = knownSize ?? fs.fstatSync(descriptor).size;
    const fileEnd = typeof before === "number" && Number.isSafeInteger(before)
      ? Math.max(0, Math.min(before, size))
      : size;
    const boundedLimit = Math.max(1, Math.trunc(limit));
    const boundedBytes = Math.max(
      1,
      Math.trunc(maxBytes ?? DEFAULT_READ_MAX_BYTES),
    );
    const chunks: Buffer[] = [];
    let bufferStart = fileEnd;
    let bufferedBytes = 0;
    let newlineCount = 0;

    while (
      bufferStart > 0 &&
      newlineCount <= boundedLimit &&
      bufferedBytes < boundedBytes
    ) {
      const length = Math.min(READ_CHUNK_BYTES, bufferStart, boundedBytes - bufferedBytes);
      const chunkStart = bufferStart - length;
      const chunk = Buffer.allocUnsafe(length);
      const bytesRead = fs.readSync(descriptor, chunk, 0, length, chunkStart);
      if (bytesRead <= 0) break;
      const captured = chunk.subarray(0, bytesRead);
      chunks.push(captured);
      for (const byte of captured) {
        if (byte === 0x0a) newlineCount += 1;
      }
      bufferedBytes += bytesRead;
      bufferStart = chunkStart;
    }

    const buffer = Buffer.concat(chunks.reverse(), bufferedBytes);
    const records = completeLines(buffer, bufferStart, fileEnd);

    const selected = records.slice(-boundedLimit);
    const hasMore = selected.length > 0 && (records.length > selected.length || bufferStart > 0);
    return {
      lines: selected.map((line) => parseLine(line.offset, line.raw)),
      hasMore,
      ...(hasMore ? { before: selected[0]!.offset } : {}),
    };
  } catch {
    return { lines: [], hasMore: false };
  }
};

/** Read a bounded JSONL page backwards, touching only enough file chunks to fill it. */
export const readJsonlPage = (
  filePath: string,
  limit: number,
  before?: number,
  maxBytes?: number,
): JsonlPage => {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, "r");
    return readJsonlPageFromDescriptor(descriptor, limit, before, undefined, maxBytes);
  } catch {
    return { lines: [], hasMore: false };
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
};
