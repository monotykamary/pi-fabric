import fs from "node:fs";
import { readJsonlPageFromDescriptor } from "../log-tail.js";
import type { FabricLogLine } from "../agents/types.js";
import {
  missingToolStartIds,
  normalizedToolStarts,
  parsedEvents,
  parseRaw,
  TranscriptAccumulator,
} from "./transcript-parser.js";
import type { FabricAgentTranscript, FabricTranscriptSource } from "./transcript.js";

const PAGE_LINES = 40;
const TOOL_LIFECYCLE_CONTEXT_LINES = PAGE_LINES * 4;
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_CACHE_ENTRIES = 32;
const FORWARD_READ_CHUNK_BYTES = 64 * 1024;

interface CachedTranscript {
  device: number;
  inode: number;
  modifiedAt: number;
  offset: number;
  completeEnd: number;
  pageStart: number;
  pageEnd: number;
  hasMore: boolean;
  transcript: FabricAgentTranscript;
}

interface ForwardTranscriptPage {
  lines: FabricLogLine[];
  end: number;
}

const completeLogEnd = (descriptor: number, size: number, fallback = 0): number => {
  if (size <= 0) return 0;
  const scanFloor = Math.max(0, size - MAX_PAGE_BYTES);
  let scanEnd = size;
  while (scanEnd > scanFloor) {
    const scanStart = Math.max(scanFloor, scanEnd - FORWARD_READ_CHUNK_BYTES);
    const chunk = Buffer.allocUnsafe(scanEnd - scanStart);
    const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, scanStart);
    if (bytesRead <= 0) return 0;
    for (let index = bytesRead - 1; index >= 0; index--) {
      if (chunk[index] === 0x0a) return scanStart + index + 1;
    }
    scanEnd = scanStart;
  }
  return Math.min(fallback, size);
};

const readForwardPage = (
  descriptor: number,
  start: number,
  end: number,
): ForwardTranscriptPage => {
  const lines: FabricLogLine[] = [];
  const readLimit = Math.min(end, Math.max(0, start) + MAX_PAGE_BYTES);
  let readOffset = Math.max(0, start);
  let pending = Buffer.alloc(0);
  let pendingOffset = readOffset;
  let pageEnd = readOffset;

  while (readOffset < readLimit && lines.length < PAGE_LINES) {
    const chunkSize = Math.min(FORWARD_READ_CHUNK_BYTES, readLimit - readOffset);
    const chunk = Buffer.allocUnsafe(chunkSize);
    const bytesRead = fs.readSync(descriptor, chunk, 0, chunkSize, readOffset);
    if (bytesRead <= 0) break;
    const data = pending.length > 0
      ? Buffer.concat([pending, chunk.subarray(0, bytesRead)])
      : chunk.subarray(0, bytesRead);
    const dataOffset = pending.length > 0 ? pendingOffset : readOffset;
    let lineStart = 0;
    for (let index = 0; index < data.length; index++) {
      if (data[index] !== 0x0a) continue;
      const raw = data.subarray(lineStart, index).toString("utf8").replace(/\r$/, "");
      pageEnd = dataOffset + index + 1;
      if (raw) {
        const offset = dataOffset + lineStart;
        const parsed = parseRaw(raw);
        lines.push({ offset, raw, ...(parsed ? { parsed } : {}) });
        if (lines.length >= PAGE_LINES) return { lines, end: pageEnd };
      }
      lineStart = index + 1;
    }
    pending = Buffer.from(data.subarray(lineStart));
    pendingOffset = dataOffset + lineStart;
    readOffset += bytesRead;
  }

  return { lines, end: readOffset >= end ? end : pageEnd };
};

export class AgentTranscriptReader {
  readonly #cache = new Map<string, CachedTranscript>();

  read(
    source: FabricTranscriptSource,
    followLatest = true,
  ): FabricAgentTranscript {
    const filePath = source.logFile;
    if (!filePath) {
      return { entries: [], truncated: false, hasMore: false, hasNewer: false };
    }
    const cached = this.#cache.get(filePath);
    let descriptor: number | undefined;
    try {
      const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) {
        return cached?.transcript ?? {
          entries: [],
          truncated: false,
          hasMore: false,
          hasNewer: false,
        };
      }
      const sameFile = cached?.device === stat.dev && cached.inode === stat.ino;
      const sameSizeRewrite =
        sameFile && cached.offset === stat.size && cached.modifiedAt !== stat.mtimeMs;
      let state: CachedTranscript;
      if (!cached || !sameFile || stat.size < cached.offset || sameSizeRewrite) {
        state = this.#latestState(descriptor, stat);
      } else if (stat.size !== cached.offset || stat.mtimeMs !== cached.modifiedAt) {
        const wasAtTail = cached.pageEnd >= cached.completeEnd;
        const completeEnd = completeLogEnd(descriptor, stat.size, cached.completeEnd);
        if (
          cached.pageEnd > completeEnd ||
          (followLatest && wasAtTail && completeEnd > cached.completeEnd)
        ) {
          state = this.#latestState(descriptor, stat, completeEnd);
        } else {
          state = {
            ...cached,
            modifiedAt: stat.mtimeMs,
            offset: stat.size,
            completeEnd,
            transcript: {
              ...cached.transcript,
              hasNewer: cached.pageEnd < completeEnd,
              updatedAt: stat.mtimeMs,
            },
          };
        }
      } else {
        state = cached;
      }
      this.#remember(filePath, state);
      return state.transcript;
    } catch {
      return cached?.transcript ?? {
        entries: [],
        truncated: false,
        hasMore: false,
        hasNewer: false,
      };
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
    }
  }

  loadOlder(source: FabricTranscriptSource): boolean {
    const filePath = source.logFile;
    if (!filePath) return false;
    this.read(source, false);
    const cached = this.#cache.get(filePath);
    if (!cached?.hasMore || cached.pageStart <= 0) return false;
    let descriptor: number | undefined;
    try {
      const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.dev !== cached.device || stat.ino !== cached.inode) return false;
      const completeEnd = completeLogEnd(descriptor, stat.size, cached.completeEnd);
      const pageEnd = Math.min(cached.pageStart, completeEnd);
      const page = readJsonlPageFromDescriptor(
        descriptor,
        PAGE_LINES,
        pageEnd,
        stat.size,
        MAX_PAGE_BYTES,
      );
      const pageStart = page.lines[0]?.offset;
      if (pageStart === undefined) return false;
      const state = this.#stateForPage(
        descriptor,
        stat,
        completeEnd,
        page.lines,
        pageStart,
        pageEnd,
        page.hasMore,
      );
      this.#remember(filePath, state);
      return true;
    } catch {
      return false;
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
    }
  }

  loadNewer(source: FabricTranscriptSource): boolean {
    const filePath = source.logFile;
    if (!filePath) return false;
    this.read(source, false);
    const cached = this.#cache.get(filePath);
    if (!cached || cached.pageEnd >= cached.completeEnd) return false;
    let descriptor: number | undefined;
    try {
      const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.dev !== cached.device || stat.ino !== cached.inode) return false;
      const completeEnd = completeLogEnd(descriptor, stat.size, cached.completeEnd);
      const page = readForwardPage(descriptor, cached.pageEnd, completeEnd);
      if (page.lines.length === 0 || page.end <= cached.pageEnd) return false;
      const state = this.#stateForPage(
        descriptor,
        stat,
        completeEnd,
        page.lines,
        cached.pageEnd,
        page.end,
        cached.pageEnd > 0,
      );
      this.#remember(filePath, state);
      return true;
    } catch {
      return false;
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
    }
  }

  loadLatest(source: FabricTranscriptSource): boolean {
    const filePath = source.logFile;
    if (!filePath) return false;
    this.read(source, false);
    const cached = this.#cache.get(filePath);
    let descriptor: number | undefined;
    try {
      const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) return false;
      if (cached && (stat.dev !== cached.device || stat.ino !== cached.inode)) return false;
      const completeEnd = completeLogEnd(descriptor, stat.size, cached?.completeEnd ?? 0);
      const state = this.#latestState(descriptor, stat, completeEnd);
      this.#remember(filePath, state);
      return true;
    } catch {
      return false;
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
    }
  }

  clear(): void {
    this.#cache.clear();
  }

  #latestState(
    descriptor: number,
    stat: fs.Stats,
    knownCompleteEnd?: number,
  ): CachedTranscript {
    const completeEnd = knownCompleteEnd ?? completeLogEnd(descriptor, stat.size);
    const page = readJsonlPageFromDescriptor(
      descriptor,
      PAGE_LINES,
      completeEnd,
      stat.size,
      MAX_PAGE_BYTES,
    );
    return this.#stateForPage(
      descriptor,
      stat,
      completeEnd,
      page.lines,
      page.lines[0]?.offset ?? completeEnd,
      completeEnd,
      page.hasMore,
    );
  }

  #stateForPage(
    descriptor: number,
    stat: fs.Stats,
    completeEnd: number,
    lines: FabricLogLine[],
    pageStart: number,
    pageEnd: number,
    hasMore: boolean,
  ): CachedTranscript {
    const events = parsedEvents(lines);
    const missingStarts = missingToolStartIds(events);
    const lifecycleContext: Array<Record<string, unknown>> = [];
    if (missingStarts.size > 0 && pageStart > 0) {
      const contextPage = readJsonlPageFromDescriptor(
        descriptor,
        TOOL_LIFECYCLE_CONTEXT_LINES,
        pageStart,
        stat.size,
        MAX_PAGE_BYTES,
      );
      const contextEvents = parsedEvents(contextPage.lines);
      for (let index = contextEvents.length - 1; index >= 0 && missingStarts.size > 0; index--) {
        const starts = normalizedToolStarts(contextEvents[index]!);
        for (let startIndex = starts.length - 1; startIndex >= 0; startIndex--) {
          const start = starts[startIndex]!;
          if (!missingStarts.delete(start.id)) continue;
          lifecycleContext.unshift(start.event);
        }
      }
    }
    const accumulator = new TranscriptAccumulator();
    accumulator.append([...lifecycleContext, ...events]);
    const transcript = {
      ...accumulator.snapshot(hasMore, stat.mtimeMs, Number.MAX_SAFE_INTEGER),
      hasNewer: pageEnd < completeEnd,
    };
    return {
      device: stat.dev,
      inode: stat.ino,
      modifiedAt: stat.mtimeMs,
      offset: stat.size,
      completeEnd,
      pageStart,
      pageEnd,
      hasMore: transcript.hasMore ?? false,
      transcript,
    };
  }

  #remember(filePath: string, state: CachedTranscript): void {
    this.#cache.delete(filePath);
    this.#cache.set(filePath, state);
    while (this.#cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#cache.delete(oldest);
    }
  }
}
