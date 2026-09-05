import type { FabricTranscriptEntry } from "./transcript.js";
import { recordOf } from "./transcript-sanitization.js";

const DIRECT_ENVELOPE_PREFIX = "Fabric actor message from direct:";

/**
 * Display-only unwrapping of a Fabric direct actor message envelope.
 *
 * Actors receive messages as `Fabric actor message from <source>:` followed by
 * a JSON envelope. When that envelope is a validated direct actor message, this
 * returns the human payload text so transcripts show a normal user bubble.
 * Everything else — ordinary user JSON, code, malformed input, host-event
 * envelopes, non-direct sources — is preserved untouched by returning undefined.
 */
export const unwrapActorEnvelopeText = (text: string): string | undefined => {
  if (!text.startsWith(DIRECT_ENVELOPE_PREFIX)) return undefined;
  const body = text.slice(DIRECT_ENVELOPE_PREFIX.length).trimStart();
  if (!body.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const envelope = recordOf(parsed);
  if (!envelope || envelope.source !== "direct") return undefined;
  const payload = recordOf(envelope.payload);
  if (!payload || typeof payload.message !== "string") return undefined;
  const message = payload.message;
  return message.trim() ? message : undefined;
};

export interface FocusedTranscriptView {
  /** Entries to render in the focused (collapsed) view. */
  entries: FabricTranscriptEntry[];
  /** Raw diagnostics hidden by collapse; render these when expanded. */
  hiddenDiagnostics: FabricTranscriptEntry[];
}

const workerWarningCount = (entry: FabricTranscriptEntry): number => {
  if (entry.kind !== "error" || entry.label !== "Worker stderr" || typeof entry.text !== "string") return 0;
  if (entry.warningCount !== undefined) return entry.warningCount;
  const lines = entry.text.split(/\r?\n/).filter((line) => line.trim());
  // Never collapse a mixed warning/error chunk just because its first line is a warning.
  return lines.length > 0 && lines.every((line) => /^\s*Warning:/.test(line)) ? lines.length : 0;
};

/**
 * Pure focused-view projection: collapses runs of worker stderr warnings into
 * one diagnostics summary entry without discarding anything — hidden originals
 * come back in `hiddenDiagnostics` so an expand toggle can render them. Real
 * errors (non-warning stderr) always stay visible.
 */
export const focusTranscriptDiagnostics = (
  entries: FabricTranscriptEntry[],
  expandHint = "Ctrl+O",
): FocusedTranscriptView => {
  const focused: FabricTranscriptEntry[] = [];
  const hidden: FabricTranscriptEntry[] = [];
  let run: FabricTranscriptEntry[] = [];

  const flushRun = (): void => {
    if (run.length === 0) return;
    const count = run.reduce((sum, entry) => sum + workerWarningCount(entry), 0);
    if (count === 1) {
      focused.push(run[0]!);
    } else {
      focused.push({
        id: `diagnostics-${run[0]!.id}`,
        kind: "status",
        label: "Diagnostics",
        text: `${count} worker warnings collapsed (${expandHint} to expand)`,
        status: "completed",
      });
      hidden.push(...run);
    }
    run = [];
  };

  for (const entry of entries) {
    if (workerWarningCount(entry) > 0) run.push(entry);
    else {
      flushRun();
      focused.push(entry);
    }
  }
  flushRun();
  return { entries: focused, hiddenDiagnostics: hidden };
};
