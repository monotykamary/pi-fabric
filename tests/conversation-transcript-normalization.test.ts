import { describe, expect, it } from "vitest";
import {
  focusTranscriptDiagnostics,
  unwrapActorEnvelopeText,
} from "../src/ui/conversation-transcript.js";
import { TranscriptAccumulator } from "../src/ui/transcript-parser.js";
import { projectAgentTranscript } from "../src/ui/transcript.js";

const directEnvelope = (message: string, id = "envelope-uuid-1", source = "direct"): string =>
  [
    `Fabric actor message from ${source}:`,
    JSON.stringify({ source, payload: { message }, id }, null, 2),
  ].join("\n\n");

describe("direct actor envelope unwrapping", () => {
  it("unwraps a validated direct actor envelope to its payload message", () => {
    expect(unwrapActorEnvelopeText(directEnvelope("Hello!"))).toBe("Hello!");
  });

  it("unwraps envelopes with extra envelope fields and nested payload data", () => {
    const text = [
      "Fabric actor message from direct:",
      JSON.stringify(
        {
          source: "direct",
          payload: { message: "Hi", extra: { kept: true } },
          id: "abc",
          meta: "ignored",
        },
        null,
        2,
      ),
    ].join("\n\n");
    expect(unwrapActorEnvelopeText(text)).toBe("Hi");
  });

  it("preserves ordinary user JSON that lacks the actor envelope prefix", () => {
    const json = JSON.stringify({ source: "direct", payload: { message: "Hello!" } }, null, 2);
    expect(unwrapActorEnvelopeText(json)).toBeUndefined();
  });

  it("preserves non-direct sources and host-event envelopes", () => {
    expect(unwrapActorEnvelopeText(directEnvelope("Hello!", "id", "mesh"))).toBeUndefined();
    expect(
      unwrapActorEnvelopeText(directEnvelope("Hello!", "id", "host-event")),
    ).toBeUndefined();
  });

  it("preserves malformed JSON, non-string payloads, and markdown bodies", () => {
    expect(unwrapActorEnvelopeText("Fabric actor message from direct:\n\n{not json")).toBeUndefined();
    expect(
      unwrapActorEnvelopeText(
        `Fabric actor message from direct:\n\n${JSON.stringify({ source: "direct", payload: { message: 42 } }, null, 2)}`,
      ),
    ).toBeUndefined();
    expect(
      unwrapActorEnvelopeText(
        `Fabric actor message from direct:\n\n${JSON.stringify({ source: "direct", payload: {} }, null, 2)}`,
      ),
    ).toBeUndefined();
    expect(unwrapActorEnvelopeText("Fabric actor message from direct:\n\n# Heading\n\nbody")).toBeUndefined();
  });

  it("rejects blank payload messages so entries are not emptied", () => {
    expect(unwrapActorEnvelopeText(directEnvelope("   "))).toBeUndefined();
  });
});

describe("user message start/end identity deduplication", () => {
  const userEvent = (type: "message_start" | "message_end", text: string, timestamp: number) => ({
    type,
    message: { role: "user", content: [{ type: "text", text }], timestamp },
  });

  it("collapses a native RPC message_start/message_end pair into one user bubble", () => {
    const transcript = projectAgentTranscript([
      userEvent("message_start", directEnvelope("Hello!"), 1_700_000_000_000),
      userEvent("message_end", directEnvelope("Hello!"), 1_700_000_000_000),
    ]);

    const users = transcript.entries.filter((entry) => entry.kind === "user");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ kind: "user", label: "User", text: "Hello!" });
  });

  it("stays deduplicated across incremental appends", () => {
    const accumulator = new TranscriptAccumulator();
    accumulator.append([userEvent("message_start", "Hello!", 1_700_000_000_000)]);
    expect(accumulator.snapshot().entries.filter((entry) => entry.kind === "user")).toHaveLength(1);
    accumulator.append([userEvent("message_end", "Hello!", 1_700_000_000_000)]);
    expect(accumulator.snapshot().entries.filter((entry) => entry.kind === "user")).toHaveLength(1);
    expect(accumulator.snapshot().entries.at(-1)).toMatchObject({ text: "Hello!" });
  });

  it("preserves genuinely repeated separate user turns with identical text", () => {
    const transcript = projectAgentTranscript([
      userEvent("message_start", "Hello!", 1_700_000_000_000),
      userEvent("message_end", "Hello!", 1_700_000_000_000),
      userEvent("message_start", "Hello!", 1_700_000_005_000),
      userEvent("message_end", "Hello!", 1_700_000_005_000),
    ]);

    const users = transcript.entries.filter((entry) => entry.kind === "user");
    expect(users).toHaveLength(2);
    expect(users.map((entry) => entry.text)).toEqual(["Hello!", "Hello!"]);
  });

  it("deduplicates session message lines against start/end events sharing identity", () => {
    const transcript = projectAgentTranscript([
      { type: "message", message: { role: "user", content: "Hello!", timestamp: 1_700_000_000_000 } },
      userEvent("message_start", "Hello!", 1_700_000_000_000),
      userEvent("message_end", "Hello!", 1_700_000_000_000),
    ]);

    expect(transcript.entries.filter((entry) => entry.kind === "user")).toHaveLength(1);
  });

  it("preserves different content and repeated turns with the same millisecond timestamp", () => {
    const events = ["first", "second", "second"].flatMap((text) => [
      userEvent("message_start", text, 123), userEvent("message_end", text, 123),
    ]);
    expect(projectAgentTranscript(events).entries.filter((entry) => entry.kind === "user").map((entry) => entry.text))
      .toEqual(["first", "second", "second"]);
  });

  it("preserves user Markdown indentation inside a direct actor envelope", () => {
    const text = "    const indented = true;\n\n  keep spaces  ";
    const transcript = projectAgentTranscript([userEvent("message_end", directEnvelope(text), 123)]);
    expect(transcript.entries[0]?.text).toBe(text);
  });

  it("leaves events without timestamps untouched rather than deduplicating by text", () => {
    const transcript = projectAgentTranscript([
      { type: "message_start", message: { role: "user", content: "Hello!" } },
      { type: "message_end", message: { role: "user", content: "Hello!" } },
    ]);

    expect(transcript.entries.filter((entry) => entry.kind === "user")).toHaveLength(2);
  });

  it("does not merge user and assistant entries or unrelated events", () => {
    const transcript = projectAgentTranscript([
      userEvent("message_start", "Question?", 1_700_000_000_000),
      userEvent("message_end", "Question?", 1_700_000_000_000),
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Answer" }],
          timestamp: 1_700_000_000_000,
        },
      },
    ]);

    expect(transcript.entries.filter((entry) => entry.kind === "user")).toHaveLength(1);
    expect(transcript.entries.filter((entry) => entry.kind === "assistant")).toHaveLength(1);
  });
});

describe("worker stderr diagnostics collapse", () => {
  const warning = (text: string, id: string) => ({
    id,
    kind: "error" as const,
    label: "Worker stderr",
    text,
    status: "failed" as const,
  });

  it("collapses repeated startup warnings into one diagnostics summary", () => {
    const warnings = [
      'Warning: No models match pattern "neuralwatt/kimi-k3"',
      'Warning: No models match pattern "hypercharm/qwen3.8-max"',
      'Warning: No models match pattern "zro/glm-5.2"',
    ].map((text, index) => warning(text, `stderr-${index}`));
    const view = focusTranscriptDiagnostics([
      warning("unrelated before", "before"),
      ...warnings,
      { id: "after", kind: "user", label: "User", text: "Hello!", status: "completed" },
    ]);

    expect(view.entries).toHaveLength(3);
    expect(view.entries[1]).toMatchObject({
      kind: "status",
      label: "Diagnostics",
      text: "3 worker warnings collapsed (Ctrl+O to expand)",
    });
    expect(view.hiddenDiagnostics).toEqual(warnings);
  });

  it("keeps single warnings and real errors visible without hiding anything", () => {
    const lone = warning("Warning: one off warning", "lone");
    const error = warning("Error: connection refused", "real");
    const view = focusTranscriptDiagnostics([lone, error]);

    expect(view.entries).toEqual([lone, error]);
    expect(view.hiddenDiagnostics).toEqual([]);
  });

  it("collapses a single multi-warning chunk and keeps mixed errors visible", () => {
    const transcript = projectAgentTranscript([
      { type: "worker_stderr", text: 'Warning: model one\nWarning: model two\n' },
      { type: "worker_stderr", text: 'Warning: model three\nError: credentials rejected\n' },
    ]);
    const view = focusTranscriptDiagnostics(transcript.entries, "alt+o");
    expect(view.entries[0]?.text).toBe("2 worker warnings collapsed (alt+o to expand)");
    expect(view.entries[1]?.text).toContain("Error: credentials rejected");
    expect(view.hiddenDiagnostics).toEqual([transcript.entries[0]]);
  });

  it("never reclassifies a mixed stderr chunk as warnings after clipping", () => {
    const text = 'Warning: before\n'.repeat(50) + 'Error: important failure\n' + 'Warning: after\n'.repeat(50);
    const transcript = projectAgentTranscript([{ type: "worker_stderr", text }]);
    expect(transcript.entries[0]?.warningCount).toBe(0);
    expect(focusTranscriptDiagnostics(transcript.entries).hiddenDiagnostics).toEqual([]);
  });

  it("collapses separate warning runs independently and retains originals", () => {
    const runA = [warning("Warning: a1", "a1"), warning("Warning: a2", "a2")];
    const runB = [warning("Warning: b1", "b1")];
    const divider = { id: "turn", kind: "user" as const, label: "User", text: "Hi", status: "completed" as const };
    const view = focusTranscriptDiagnostics([...runA, divider, ...runB]);

    expect(view.entries).toHaveLength(3);
    expect(view.entries.filter((entry) => entry.kind === "status")).toHaveLength(1);
    expect(view.hiddenDiagnostics).toEqual(runA);
    expect(view.entries).toContain(divider);
    expect(view.entries).toContain(runB[0]);
  });
});
