import fs from "node:fs";
import path from "node:path";
import type { FabricMeshConfig, FabricRetentionConfig } from "../config.js";
import type { MeshStore } from "../mesh/store.js";
import { pruneActorRunArchives } from "../storage/retention.js";
import type { FabricActorMessage } from "./types.js";

export const ACTOR_MESSAGE_HISTORY_LIMIT = 100;

export const ACTOR_MESSAGE_ENVELOPE_BYTES = 4_096;
const ACTOR_TRUNCATION_SUFFIX = "\n[actor message truncated]";

const serializedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const truncateUtf8 = (value: string, maxBytes: number, suffix = ""): string => {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const boundedSuffix = Buffer.byteLength(suffix, "utf8") <= maxBytes
    ? suffix
    : truncateUtf8(suffix, maxBytes);
  const available = Math.max(0, maxBytes - Buffer.byteLength(boundedSuffix, "utf8"));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= available) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}${boundedSuffix}`;
};

const boundedActorText = (value: string, maxBytes: number): string => {
  if (serializedBytes({ text: value }) <= maxBytes) return value;
  const suffix = serializedBytes({ text: ACTOR_TRUNCATION_SUFFIX }) <= maxBytes
    ? ACTOR_TRUNCATION_SUFFIX
    : "";
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedBytes({ text: `${value.slice(0, middle)}${suffix}` }) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${value.slice(0, low)}${suffix}`;
};

const boundedActorData = (data: unknown, maxBytes: number): unknown => {
  let serialized: string;
  try {
    const encoded = JSON.stringify(data);
    serialized = typeof encoded === "string" ? encoded : String(data);
    if (serializedBytes({ data }) <= maxBytes) return data;
  } catch {
    serialized = String(data);
  }
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  let preview = truncateUtf8(serialized, Math.max(0, maxBytes - 256));
  let bounded = { fabricTruncated: true, originalBytes, preview };
  while (preview && serializedBytes({ data: bounded }) > maxBytes) {
    preview = truncateUtf8(preview, Math.floor(Buffer.byteLength(preview, "utf8") / 2));
    bounded = { fabricTruncated: true, originalBytes, preview };
  }
  return serializedBytes({ data: bounded }) <= maxBytes
    ? bounded
    : { fabricTruncated: true, originalBytes };
};

interface ActorLogTarget {
  sessionFile: string;
  lastRunId?: string;
}

/** Archive I/O and message bounds only; ownership and sweep eligibility stay with the manager. */
export class ActorLogStore {
  constructor(
    readonly mesh: Pick<MeshStore, "maxEventBytes">,
    readonly config: Pick<FabricMeshConfig, "eventContextChars">,
    readonly retention: Pick<FabricRetentionConfig, "actorRunArchiveMs">,
  ) {}

  async retainRun(actor: ActorLogTarget, runId: string, runDirectory: string | undefined): Promise<void> {
    if (!runDirectory || !fs.existsSync(runDirectory)) return;
    const dest = path.join(path.dirname(actor.sessionFile), "runs", runId);
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    for (const file of ["events.jsonl", "status.json", "task.txt"]) {
      const src = path.join(runDirectory, file);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, file));
    }
    const nested = path.join(runDirectory, "nested");
    if (fs.existsSync(nested)) {
      try {
        fs.cpSync(nested, path.join(dest, "nested"), { recursive: true });
      } catch {
        /* best-effort recursive run retention */
      }
    }
    this.pruneRuns(actor);
  }

  pruneRuns(actor: ActorLogTarget, now = Date.now()): void {
    pruneActorRunArchives({
      runsDirectory: path.join(path.dirname(actor.sessionFile), "runs"),
      ...(actor.lastRunId ? { latestRunId: actor.lastRunId } : {}),
      retentionMs: this.retention.actorRunArchiveMs,
      now,
    });
  }

  retainedRunIds(actor: ActorLogTarget): string[] {
    const runsDir = path.join(path.dirname(actor.sessionFile), "runs");
    try {
      return fs.readdirSync(runsDir).sort();
    } catch {
      return [];
    }
  }

  recordMessage(messages: FabricActorMessage[], message: FabricActorMessage): void {
    let bounded = structuredClone(message);
    const maxPayloadBytes = Math.max(1, this.mesh.maxEventBytes - ACTOR_MESSAGE_ENVELOPE_BYTES);
    const fixed = structuredClone(bounded);
    delete fixed.text;
    delete fixed.data;
    const contentBytes = Math.max(1, maxPayloadBytes - serializedBytes(fixed) - 128);
    const hasText = Boolean(bounded.text);
    const hasData = bounded.data !== undefined;
    const textBytes = hasText && hasData ? Math.floor(contentBytes / 2) : contentBytes;
    const dataBytes = hasText && hasData ? contentBytes - textBytes : contentBytes;
    if (bounded.text) {
      const contextBounded = bounded.text.length > this.config.eventContextChars
        ? `${bounded.text.slice(0, this.config.eventContextChars)}${ACTOR_TRUNCATION_SUFFIX}`
        : bounded.text;
      bounded.text = boundedActorText(contextBounded, textBytes);
    }
    if (bounded.data !== undefined) {
      bounded.data = boundedActorData(bounded.data, dataBytes);
    }
    if (serializedBytes(bounded) > maxPayloadBytes) {
      delete bounded.data;
      if (bounded.text) {
        bounded.text = boundedActorText(bounded.text, contentBytes);
      }
    }
    if (serializedBytes(bounded) > maxPayloadBytes) {
      bounded = {
        id: bounded.id,
        actorId: bounded.actorId,
        actorName: bounded.actorName,
        direction: bounded.direction,
        source: boundedActorText(bounded.source, 1_024),
        createdAt: bounded.createdAt,
        ...(bounded.action ? { action: bounded.action } : {}),
        ...(bounded.runId ? { runId: bounded.runId } : {}),
        error: "Actor message content exceeded the mesh event limit",
      };
    }
    for (const key of Object.keys(message)) {
      delete (message as unknown as Record<string, unknown>)[key];
    }
    Object.assign(message, bounded);
    messages.push(bounded);
    if (messages.length > ACTOR_MESSAGE_HISTORY_LIMIT) {
      messages.splice(0, messages.length - ACTOR_MESSAGE_HISTORY_LIMIT);
    }
  }
}
