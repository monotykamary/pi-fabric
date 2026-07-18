import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  compactionRequestBoundsError,
  encodeCompactionRequest,
} from "../compaction/instructions.js";

// A pending-intent controller for the host Pi session's context compaction.
//
// Compaction here is a deliberate, advisory-then-committed act: the model (or a
// skill) requests a compaction by calling `request()`, which only records the
// *intent*. The host commits it later at a safe boundary — `agent_settled`,
// never mid-turn and never while a turn is in flight — by calling
// `maybeCommit(context)`, which forwards to `ExtensionContext.compact()`.
//
// This mirrors Schema's harness-enforced gate: there is exactly one write path
// from thought (intent) to action (commit), and the host — not the model —
// decides when it is safe. The model cannot compact the running context
// directly; it can only ask, and the ask is a single replaceable slot.

export interface CompactRequestIntent {
  reason?: string;
  instructions?: string;
  preserve?: string[];
  requestedBy?: string;
}

export interface CompactPendingIntent {
  reason?: string;
  instructions?: string;
  preserve?: string[];
  requestedBy: string;
  requestedAt: number;
}

type CompactCommitStatus = "committed" | "failed" | "cancelled";


export interface CompactLastCommit {
  at: number;
  requestedBy: string;
  status: CompactCommitStatus;
  summary?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  error?: string;
}

export interface CompactStatus {
  pending?: CompactPendingIntent;
  last?: CompactLastCommit;
}

export interface CompactControllerHooks {
  // Fired when a new intent is recorded (request replaces any pending one).
  onRequest?: (intent: CompactPendingIntent) => void;
  // Fired when the host commits (or fails to commit) a recorded intent.
  // "cancelled" is reported when pi reports "Compaction cancelled" /
  // "Already compacted"; the intent is still cleared quietly.
  onCommit?: (info: CompactLastCommit) => void;
}

const DEFAULT_REQUESTED_BY = "model";

const isString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const checkedPreserve = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("compact preserve must be an array of strings");
  }
  return [...value];
};

export class CompactController {
  #pending: CompactPendingIntent | undefined;
  #last: CompactLastCommit | undefined;
  #inFlight = false;
  readonly #hooks: CompactControllerHooks;

  constructor(hooks: CompactControllerHooks = {}) {
    this.#hooks = hooks;
  }

  // Record a pending compaction intent. A single slot: a new request replaces
  // any pending one, keeping the latest instructions.
  request(intent: CompactRequestIntent): CompactPendingIntent {
    const preserve = checkedPreserve(intent.preserve);
    const request = {
      ...(intent.instructions !== undefined ? { instructions: intent.instructions } : {}),
      ...(preserve !== undefined ? { preserve } : {}),
    };
    const boundsError = compactionRequestBoundsError(request);
    if (boundsError) throw new Error(boundsError.message);
    if (preserve !== undefined) encodeCompactionRequest(request);
    const pending: CompactPendingIntent = {
      requestedBy: isString(intent.requestedBy) ? intent.requestedBy! : DEFAULT_REQUESTED_BY,
      requestedAt: Date.now(),
      ...(isString(intent.reason) ? { reason: intent.reason } : {}),
      ...(isString(intent.instructions) ? { instructions: intent.instructions } : {}),
      ...(preserve !== undefined ? { preserve } : {}),
    };
    this.#pending = pending;
    this.#hooks.onRequest?.(pending);
    return pending;
  }

  // Clear a pending intent without committing. Safe to call when nothing is
  // pending.
  cancel(): void {
    this.#pending = undefined;
  }

  status(): CompactStatus {
    return {
      ...(this.#pending ? { pending: this.#pending } : {}),
      ...(this.#last ? { last: this.#last } : {}),
    };
  }

  // Commit the pending intent at a safe boundary. Called from the host at
  // `agent_settled` — never mid-turn. If a commit is already in flight, or no
  // intent is pending, this is a no-op. Forwards to
  // `ExtensionContext.compact()`; pi core applies the compaction safely.
  maybeCommit(context: ExtensionContext): void {
    if (this.#inFlight) return;
    const pending = this.#pending;
    if (!pending) return;
    // Capture the intent's fields before forwarding so the async callbacks
    // below do not depend on closure-narrowed references to `pending`.
    const requestedBy = pending.requestedBy;
    const instructions = pending.preserve
      ? encodeCompactionRequest({
          ...(pending.instructions !== undefined ? { instructions: pending.instructions } : {}),
          preserve: pending.preserve,
        })
      : pending.instructions;
    // Hold the exact intent object we are committing. A new request() may
    // replace `this.#pending` while this commit is in flight; on completion we
    // only clear the intent we actually committed (by identity), leaving any
    // newer intent for the next settled boundary.
    const committing = pending;
    this.#inFlight = true;
    const clearCommittedIntent = (): void => {
      if (this.#pending === committing) this.#pending = undefined;
    };
    try {
      context.compact({
        ...(instructions ? { customInstructions: instructions } : {}),
        onComplete: (result) => {
          this.#last = {
            at: Date.now(),
            requestedBy,
            status: "committed",
            summary: result.summary,
            tokensBefore: result.tokensBefore,
            ...(result.estimatedTokensAfter !== undefined
              ? { estimatedTokensAfter: result.estimatedTokensAfter }
              : {}),
          };
          clearCommittedIntent();
          this.#inFlight = false;
          this.#hooks.onCommit?.(this.#last);
        },
        onError: (error) => {
          const message = error?.message ?? "Compaction error";
          // "Compaction cancelled" / "Already compacted": nothing to compact;
          // clear quietly without recording a failure.
          if (message === "Compaction cancelled" || message === "Already compacted") {
            clearCommittedIntent();
            this.#inFlight = false;
            return;
          }
          this.#last = {
            at: Date.now(),
            requestedBy,
            status: "failed",
            error: message,
          };
          clearCommittedIntent();
          this.#inFlight = false;
          this.#hooks.onCommit?.(this.#last);
        },
      });
    } catch (error) {
      this.#inFlight = false;
      this.#last = {
        at: Date.now(),
        requestedBy,
        status: "failed",
        error: error instanceof Error ? error.message : "Compaction failed to start",
      };
      clearCommittedIntent();
      this.#hooks.onCommit?.(this.#last);
    }
  }
}
