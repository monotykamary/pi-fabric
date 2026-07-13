import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface MeshIdentity {
  id: string;
  name: string;
  kind: "main" | "actor" | "agent";
  sessionId?: string;
}

export interface MeshEvent {
  id: string;
  sequence: number;
  topic: string;
  kind: string;
  from: MeshIdentity;
  to?: string;
  text?: string;
  data?: unknown;
  createdAt: number;
}

export interface MeshTailResult {
  events: MeshEvent[];
  nextOffset: number;
}

export interface MeshStateEntry {
  key: string;
  value: unknown;
  version: number;
  updatedAt: number;
  updatedBy: MeshIdentity;
}

interface MeshStateFile {
  format: 1;
  entries: Record<string, MeshStateEntry>;
}

const TOPIC_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const jsonClone = <T>(value: T): T => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Mesh values must be JSON-serializable");
  return JSON.parse(serialized) as T;
};

const readState = (filePath: string): MeshStateFile => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as { format?: unknown }).format === 1
    ) {
      const entries = (parsed as { entries?: unknown }).entries;
      if (typeof entries === "object" && entries !== null && !Array.isArray(entries)) {
        return parsed as MeshStateFile;
      }
    }
    throw new Error("invalid state format");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { format: 1, entries: {} };
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read Fabric mesh state: ${message}`);
  }
};

const atomicWrite = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
};

export class MeshStore {
  readonly #eventsPath: string;
  readonly #statePath: string;
  readonly #counterPath: string;
  readonly #lockPath: string;

  constructor(
    readonly root: string,
    readonly maxEventBytes: number,
    readonly maxReadEvents: number,
  ) {
    this.#eventsPath = path.join(root, "events.jsonl");
    this.#statePath = path.join(root, "state.json");
    this.#counterPath = path.join(root, "sequence");
    this.#lockPath = path.join(root, ".lock");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  async publish(input: {
    topic: string;
    kind?: string;
    from: MeshIdentity;
    to?: string;
    text?: string;
    data?: unknown;
  }): Promise<MeshEvent> {
    this.#validateTopic(input.topic);
    if (input.to !== undefined && !input.to.trim()) throw new Error("Mesh recipient is empty");
    const eventData = input.data === undefined ? undefined : jsonClone(input.data);
    return this.#withLock(() => {
      this.#repairEventLog();
      const sequence = Math.max(this.#readSequence(), this.#readLastEventSequence()) + 1;
      const event: MeshEvent = {
        id: randomUUID(),
        sequence,
        topic: input.topic,
        kind: input.kind?.trim() || "message",
        from: jsonClone(input.from),
        ...(input.to ? { to: input.to } : {}),
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(eventData !== undefined ? { data: eventData } : {}),
        createdAt: Date.now(),
      };
      const line = JSON.stringify(event);
      if (Buffer.byteLength(line, "utf8") > this.maxEventBytes) {
        throw new Error(`Mesh event exceeds ${this.maxEventBytes} bytes`);
      }
      fs.appendFileSync(this.#eventsPath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
      atomicWrite(this.#counterPath, sequence);
      return event;
    });
  }

  read(
    input: {
      after?: number;
      topic?: string;
      to?: string;
      limit?: number;
    } = {},
  ): MeshEvent[] {
    if (input.topic !== undefined) this.#validateTopic(input.topic);
    let content: string;
    try {
      content = fs.readFileSync(this.#eventsPath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    const after = Math.max(0, Math.floor(input.after ?? 0));
    const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 100), this.maxReadEvents));
    const events: MeshEvent[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as MeshEvent;
        if (typeof event.sequence !== "number" || event.sequence <= after) continue;
        if (input.topic !== undefined && event.topic !== input.topic) continue;
        if (input.to !== undefined && event.to !== input.to) continue;
        events.push(event);
      } catch {
        continue;
      }
    }
    const selected = input.after === undefined ? events.slice(-limit) : events.slice(0, limit);
    return selected.map((event) => jsonClone(event));
  }

  latestSequence(): number {
    return Math.max(this.#readSequence(), this.#readLastEventSequence());
  }

  latestOffset(): number {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(this.#eventsPath, "r");
      const size = fs.fstatSync(descriptor).size;
      if (size === 0) return 0;
      const lastByte = Buffer.allocUnsafe(1);
      fs.readSync(descriptor, lastByte, 0, 1, size - 1);
      if (lastByte[0] === 0x0a) return size;
      const readBytes = Math.min(size, this.maxEventBytes + 1);
      const tail = Buffer.allocUnsafe(readBytes);
      fs.readSync(descriptor, tail, 0, readBytes, size - readBytes);
      const newline = tail.lastIndexOf(0x0a);
      return newline >= 0 ? size - readBytes + newline + 1 : 0;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return 0;
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  tail(offset: number, limit = 100): MeshTailResult {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), this.maxReadEvents));
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(this.#eventsPath, "r");
      const size = fs.fstatSync(descriptor).size;
      const position = Math.max(0, Math.min(Math.floor(offset), size));
      if (position >= size) return { events: [], nextOffset: position };
      const chunkBytes = Math.min(
        size - position,
        Math.max(this.maxEventBytes + 1, 4 * 1024 * 1024),
      );
      const buffer = Buffer.allocUnsafe(chunkBytes);
      const bytesRead = fs.readSync(descriptor, buffer, 0, chunkBytes, position);
      const events: MeshEvent[] = [];
      let lineStart = 0;
      let consumed = 0;
      for (let index = 0; index < bytesRead; index++) {
        if (buffer[index] !== 0x0a) continue;
        const line = buffer.subarray(lineStart, index).toString("utf8").trim();
        lineStart = index + 1;
        consumed = lineStart;
        if (line) {
          try {
            const event = JSON.parse(line) as MeshEvent;
            if (typeof event.sequence === "number") events.push(event);
          } catch { /* skip malformed mesh log line */ }
        }
        if (events.length >= boundedLimit) break;
      }
      return {
        events: events.map((event) => jsonClone(event)),
        nextOffset: position + consumed,
      };
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { events: [], nextOffset: 0 };
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  get(key: string): MeshStateEntry | undefined {
    this.#validateKey(key);
    const entry = readState(this.#statePath).entries[key];
    return entry ? jsonClone(entry) : undefined;
  }

  list(prefix = "", limit = 100): MeshStateEntry[] {
    if (prefix) this.#validateKey(prefix);
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), this.maxReadEvents));
    return Object.values(readState(this.#statePath).entries)
      .filter((entry) => !prefix || entry.key.startsWith(prefix))
      .sort((left, right) => left.key.localeCompare(right.key))
      .slice(0, boundedLimit)
      .map((entry) => jsonClone(entry));
  }

  async put(input: {
    key: string;
    value: unknown;
    identity: MeshIdentity;
    ifVersion?: number;
  }): Promise<MeshStateEntry> {
    this.#validateKey(input.key);
    const value = jsonClone(input.value);
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > this.maxEventBytes) {
      throw new Error(`Mesh state value exceeds ${this.maxEventBytes} bytes`);
    }
    return this.#withLock(() => {
      const state = readState(this.#statePath);
      const existing = state.entries[input.key];
      if (input.ifVersion !== undefined) {
        const actualVersion = existing?.version ?? 0;
        if (actualVersion !== input.ifVersion) {
          throw new Error(
            `Mesh compare-and-swap failed for ${input.key}: expected version ${input.ifVersion}, found ${actualVersion}`,
          );
        }
      }
      const entry: MeshStateEntry = {
        key: input.key,
        value,
        version: (existing?.version ?? 0) + 1,
        updatedAt: Date.now(),
        updatedBy: jsonClone(input.identity),
      };
      state.entries[input.key] = entry;
      atomicWrite(this.#statePath, state);
      return jsonClone(entry);
    });
  }

  async delete(input: {
    key: string;
    ifVersion?: number;
  }): Promise<{ deleted: boolean; version?: number }> {
    this.#validateKey(input.key);
    return this.#withLock(() => {
      const state = readState(this.#statePath);
      const existing = state.entries[input.key];
      if (!existing) {
        if (input.ifVersion !== undefined && input.ifVersion !== 0) {
          throw new Error(
            `Mesh compare-and-swap failed for ${input.key}: expected version ${input.ifVersion}, found 0`,
          );
        }
        return { deleted: false };
      }
      if (input.ifVersion !== undefined && existing.version !== input.ifVersion) {
        throw new Error(
          `Mesh compare-and-swap failed for ${input.key}: expected version ${input.ifVersion}, found ${existing.version}`,
        );
      }
      delete state.entries[input.key];
      atomicWrite(this.#statePath, state);
      return { deleted: true, version: existing.version };
    });
  }

  async #withLock<T>(operation: () => T): Promise<T> {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        fs.mkdirSync(this.#lockPath, { mode: 0o700 });
        fs.writeFileSync(path.join(this.#lockPath, "owner"), `${process.pid}\n${Date.now()}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        break;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        try {
          const age = Date.now() - fs.statSync(this.#lockPath).mtimeMs;
          if (age > STALE_LOCK_MS) {
            fs.rmSync(this.#lockPath, { recursive: true, force: true });
            continue;
          }
        } catch { /* stale lock already gone or unreadable; retry */ }
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the Fabric mesh lock");
        await delay(10);
      }
    }
    try {
      return operation();
    } finally {
      fs.rmSync(this.#lockPath, { recursive: true, force: true });
    }
  }

  #repairEventLog(): void {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(this.#eventsPath, "r+");
      const size = fs.fstatSync(descriptor).size;
      if (size === 0) return;
      const lastByte = Buffer.allocUnsafe(1);
      fs.readSync(descriptor, lastByte, 0, 1, size - 1);
      if (lastByte[0] === 0x0a) return;
      const readBytes = Math.min(size, this.maxEventBytes + 1);
      const tail = Buffer.allocUnsafe(readBytes);
      fs.readSync(descriptor, tail, 0, readBytes, size - readBytes);
      const newline = tail.lastIndexOf(0x0a);
      fs.ftruncateSync(descriptor, newline >= 0 ? size - readBytes + newline + 1 : 0);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  #readLastEventSequence(): number {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(this.#eventsPath, "r");
      const size = fs.fstatSync(descriptor).size;
      if (size === 0) return 0;
      const readBytes = Math.min(size, this.maxEventBytes + 1);
      const tail = Buffer.allocUnsafe(readBytes);
      fs.readSync(descriptor, tail, 0, readBytes, size - readBytes);
      const lines = tail.toString("utf8").trim().split("\n");
      for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index];
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { sequence?: unknown };
          if (typeof parsed.sequence === "number" && Number.isSafeInteger(parsed.sequence)) {
            return parsed.sequence;
          }
        } catch { /* skip malformed sequence line */ }
      }
      return 0;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return 0;
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  #readSequence(): number {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.#counterPath, "utf8"));
      return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return 0;
      return 0;
    }
  }

  #validateTopic(topic: string): void {
    if (!TOPIC_PATTERN.test(topic)) throw new Error(`Invalid Fabric mesh topic: ${topic}`);
  }

  #validateKey(key: string): void {
    const unsafeSegment = key
      .split(/[/:]/)
      .some(
        (segment) =>
          segment === "__proto__" || segment === "prototype" || segment === "constructor",
      );
    if (!KEY_PATTERN.test(key) || unsafeSegment) {
      throw new Error(`Invalid Fabric mesh key: ${key}`);
    }
  }
}
