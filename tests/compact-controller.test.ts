import { describe, expect, it, vi } from "vitest";
import { ExtensionRunner, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decodeCompactionInstructions, FABRIC_COMPACTION_REQUEST_PREFIX } from "../src/compaction/instructions.js";
import {
  CompactController,
  type CompactLastCommit,
  type CompactPendingIntent,
} from "../src/core/compact-controller.js";

// A stub ExtensionContext whose `compact()` captures the options so a test can
// drive the async onComplete/onError callbacks deterministically. `isIdle()`
// is true by default (agent_settled boundary).
interface CapturedCompact {
  customInstructions?: string;
  onComplete: (result: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    estimatedTokensAfter?: number;
  }) => void;
  onError: (error: Error) => void;
}

interface CompactCapture {
  current: CapturedCompact | undefined;
}

const fakeContext = (capture: CompactCapture, idle = true): ExtensionContext =>
  ({
    compact(options?: {
      customInstructions?: string;
      onComplete?: (result: {
        summary: string;
        firstKeptEntryId: string;
        tokensBefore: number;
        estimatedTokensAfter?: number;
      }) => void;
      onError?: (error: Error) => void;
    }) {
      capture.current = {
        ...(options?.customInstructions ? { customInstructions: options.customInstructions } : {}),
        onComplete: options?.onComplete ?? (() => {}),
        onError: options?.onError ?? (() => {}),
      };
    },
    isIdle: () => idle,
  }) as unknown as ExtensionContext;

const committed = (tokensBefore = 1000): Parameters<CapturedCompact["onComplete"]>[0] => ({
  summary: "compacted summary",
  firstKeptEntryId: "entry-7",
  tokensBefore,
  estimatedTokensAfter: 200,
});

describe("CompactController", () => {
  it("records a pending intent and reports it via status", () => {
    const controller = new CompactController();
    const intent = controller.request({
      reason: "context nearly full",
      instructions: "Keep the file map",
      requestedBy: "model",
    });
    expect(intent.requestedBy).toBe("model");
    expect(intent.reason).toBe("context nearly full");
    expect(intent.instructions).toBe("Keep the file map");
    const status = controller.status();
    expect(status.pending).toEqual(intent);
    expect(status.last).toBeUndefined();
  });

  it("defaults requestedBy to model and omits empty fields", () => {
    const controller = new CompactController();
    const intent = controller.request({});
    expect(intent.requestedBy).toBe("model");
    expect(intent.reason).toBeUndefined();
    expect(intent.instructions).toBeUndefined();
  });

  it("a new request replaces the pending one, keeping latest instructions", () => {
    const controller = new CompactController();
    controller.request({ reason: "first", instructions: "A" });
    controller.request({ reason: "second", instructions: "B" });
    const pending = controller.status().pending;
    expect(pending?.reason).toBe("second");
    expect(pending?.instructions).toBe("B");
  });

  it("cancel clears the pending intent without touching last-commit", () => {
    const controller = new CompactController();
    controller.request({ reason: "x" });
    controller.cancel();
    expect(controller.status().pending).toBeUndefined();
  });

  it("maybeCommit is a no-op when no intent is pending", () => {
    const capture: CompactCapture = { current: undefined };
    const controller = new CompactController();
    controller.maybeCommit(fakeContext(capture));
    expect(capture.current).toBeUndefined();
  });

  it("maybeCommit is a no-op while a commit is already in flight", async () => {
    const capture: CompactCapture = { current: undefined };
    const controller = new CompactController();
    controller.request({ reason: "first" });
    const firstCommit = controller.maybeCommit(fakeContext(capture));
    expect(capture.current).toBeDefined();
    const first = capture.current!;
    capture.current = undefined;
    // A second intent arrives while the first commit is still in flight.
    controller.request({ reason: "second" });
    const reentrant = controller.maybeCommit(fakeContext(capture));
    expect(capture.current).toBeUndefined();
    // Completing the first commit clears in-flight; the second intent is still
    // pending and can now be committed at a later boundary.
    first.onComplete(committed());
    await Promise.all([firstCommit, reentrant]);
    expect(controller.status().last?.status).toBe("committed");
    expect(controller.status().pending?.reason).toBe("second");
    void controller.maybeCommit(fakeContext(capture));
    expect(capture.current).toBeDefined();
  });

  it("commits at a settled boundary: clears intent and records last-commit info", () => {
    const capture: CompactCapture = { current: undefined };
    const controller = new CompactController();
    controller.request({ instructions: "Keep the test plan" });
    controller.maybeCommit(fakeContext(capture));
    expect(capture.current?.customInstructions).toBe("Keep the test plan");
    capture.current!.onComplete(committed(1500));
    const status = controller.status();
    expect(status.pending).toBeUndefined();
    expect(status.last).toMatchObject({
      status: "committed",
      summary: "compacted summary",
      tokensBefore: 1500,
      estimatedTokensAfter: 200,
      requestedBy: "model",
    });
  });

  it("encodes typed preserve items with instructions", () => {
    const capture: CompactCapture = { current: undefined };
    const controller = new CompactController();
    controller.request({ instructions: "Keep the plan", preserve: ["rare fact", "src/a.ts"] });
    expect(controller.status().pending?.preserve).toEqual(["rare fact", "src/a.ts"]);
    controller.maybeCommit(fakeContext(capture));
    expect(capture.current?.customInstructions?.startsWith(FABRIC_COMPACTION_REQUEST_PREFIX)).toBe(true);
    const decoded = decodeCompactionInstructions(capture.current?.customInstructions);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("expected decoded instructions");
    expect(decoded.policy.mode).toBe("typed-v1");
    expect(decoded.requestLines.join("\n")).toContain("rare fact");
    capture.current!.onError(new Error("Already compacted"));
  });

  it("forwards customInstructions only when provided", () => {
    const capture: CompactCapture = { current: undefined };
    const controller = new CompactController();
    controller.request({ reason: "no instructions" });
    controller.maybeCommit(fakeContext(capture));
    expect(capture.current?.customInstructions).toBeUndefined();
    capture.current!.onError(new Error("Already compacted"));
  });

  it("clears quietly on 'Compaction cancelled' without recording a failure", () => {
    const capture: CompactCapture = { current: undefined };
    const controller = new CompactController();
    controller.request({ reason: "x" });
    controller.maybeCommit(fakeContext(capture));
    capture.current!.onError(new Error("Compaction cancelled"));
    const status = controller.status();
    expect(status.pending).toBeUndefined();
    expect(status.last).toBeUndefined();
  });

  it("clears quietly on 'Already compacted' without recording a failure", () => {
    const capture: CompactCapture = { current: undefined };
    const controller = new CompactController();
    controller.request({ reason: "x" });
    controller.maybeCommit(fakeContext(capture));
    capture.current!.onError(new Error("Already compacted"));
    const status = controller.status();
    expect(status.pending).toBeUndefined();
    expect(status.last).toBeUndefined();
  });

  it("records a failure and clears intent on other errors", () => {
    const capture: CompactCapture = { current: undefined };
    const controller = new CompactController();
    controller.request({ reason: "x" });
    controller.maybeCommit(fakeContext(capture));
    capture.current!.onError(new Error("API quota exceeded"));
    const status = controller.status();
    expect(status.pending).toBeUndefined();
    expect(status.last).toMatchObject({ status: "failed", error: "API quota exceeded" });
  });

  it("settles as failed without calling compact when the boundary signal is aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    const compact = vi.fn();
    const controller = new CompactController();
    controller.request({ reason: "aborted boundary" });
    await controller.maybeCommit({
      compact,
      signal: abort.signal,
    } as unknown as ExtensionContext);
    expect(compact).not.toHaveBeenCalled();
    expect(controller.status().pending).toBeUndefined();
    expect(controller.status().last).toMatchObject({
      status: "failed",
      error: "Compaction aborted before it started",
    });
  });

  it("records a failure when compact() throws synchronously", () => {
    const controller = new CompactController();
    const throwingContext = {
      compact() {
        throw new Error("compact unavailable");
      },
      isIdle: () => true,
    } as unknown as ExtensionContext;
    controller.request({ reason: "x" });
    controller.maybeCommit(throwingContext);
    const status = controller.status();
    expect(status.pending).toBeUndefined();
    expect(status.last).toMatchObject({ status: "failed", error: "compact unavailable" });
  });

  it("fires onRequest when an intent is recorded", () => {
    const requests: CompactPendingIntent[] = [];
    const controller = new CompactController({
      onRequest: (intent) => requests.push(intent),
    });
    controller.request({ reason: "a" });
    controller.request({ reason: "b" });
    expect(requests.map((r) => r.reason)).toEqual(["a", "b"]);
  });

  it("fires onCommit with committed info on success and failed info on error", async () => {
    const commits: CompactLastCommit[] = [];
    const controller = new CompactController({ onCommit: (info) => commits.push(info) });
    const capture: CompactCapture = { current: undefined };
    controller.request({ reason: "ok" });
    const first = controller.maybeCommit(fakeContext(capture));
    capture.current!.onComplete(committed());
    await first;
    controller.request({ reason: "bad" });
    const second = controller.maybeCommit(fakeContext(capture));
    capture.current!.onError(new Error("rate limited"));
    await second;
    expect(commits.map((c) => c.status)).toEqual(["committed", "failed"]);
    expect(commits[1]?.error ?? "").toBe("rate limited");
  });

  it("does not fire onCommit for cancelled/already-compacted (cleared quietly)", () => {
    const commits: CompactLastCommit[] = [];
    const controller = new CompactController({ onCommit: (info) => commits.push(info) });
    const capture: CompactCapture = { current: undefined };
    controller.request({ reason: "x" });
    controller.maybeCommit(fakeContext(capture));
    capture.current!.onError(new Error("Compaction cancelled"));
    expect(commits).toHaveLength(0);
  });

  it("resets in-flight after a failed commit so a new intent can be committed", async () => {
    const capture: CompactCapture = { current: undefined };
    const controller = new CompactController();
    controller.request({ reason: "first" });
    const first = controller.maybeCommit(fakeContext(capture));
    capture.current!.onError(new Error("API quota exceeded"));
    await first;
    controller.request({ reason: "second" });
    const second = controller.maybeCommit(fakeContext(capture));
    expect(capture.current).toBeDefined();
    capture.current!.onComplete(committed());
    await second;
    expect(controller.status().last?.status).toBe("committed");
  });

  it("keeps ExtensionRunner agent_settled pending until compaction completes", async () => {
    const timeline: string[] = [];
    const capture: CompactCapture = { current: undefined };
    const controller = new CompactController();
    controller.request({ reason: "event order" });
    const runner = Object.create(ExtensionRunner.prototype) as ExtensionRunner;
    Object.assign(runner as unknown as Record<string, unknown>, {
      extensions: [{
        path: "/extensions/pi-fabric/index.ts",
        handlers: new Map([["agent_settled", [async () => {
          timeline.push("handler:start");
          await controller.maybeCommit(fakeContext(capture));
          timeline.push("handler:end");
        }]]]),
      }],
      createContext: () => ({}),
      errorListeners: new Set(),
    });

    const emitted = runner.emit({ type: "agent_settled" }).then(() => {
      timeline.push("public:agent_settled");
    });
    await Promise.resolve();
    expect(timeline).toEqual(["handler:start"]);
    capture.current!.onComplete(committed());
    await emitted;
    expect(timeline).toEqual([
      "handler:start",
      "handler:end",
      "public:agent_settled",
    ]);
  });
});
