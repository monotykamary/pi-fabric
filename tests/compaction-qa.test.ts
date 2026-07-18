import { describe, expect, it } from "vitest";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { normalizeEntries } from "../src/compaction/normalize.js";
import { project } from "../src/compaction/projections.js";
import { generateProbes, checkProbes, qaReport } from "../src/compaction/qa.js";
import { renderSummary } from "../src/compaction/render.js";

let entryId = 0;
let messageClock = 0;

const nextEntryId = (): string => `qa-e${++entryId}`;
const timestamp = (): string => `2024-02-01T00:00:${String(messageClock).padStart(2, "0")}Z`;
const tick = (): number => ++messageClock;

const user = (text: string): SessionMessageEntry => ({
  type: "message",
  id: nextEntryId(),
  parentId: null,
  timestamp: timestamp(),
  message: { role: "user", content: text, timestamp: tick() },
});

const textPart = (text: string): { type: "text"; text: string } => ({ type: "text", text });
const toolCallPart = (id: string, name: string, args: Record<string, unknown>): {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
} => ({ type: "toolCall", id, name, arguments: args });

type AssistantPart = ReturnType<typeof textPart> | ReturnType<typeof toolCallPart>;

const assistant = (...parts: AssistantPart[]): SessionMessageEntry => ({
  type: "message",
  id: nextEntryId(),
  parentId: null,
  timestamp: timestamp(),
  message: {
    role: "assistant",
    content: parts,
    api: "anthropic",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: tick(),
  },
});

const toolResult = (toolCallId: string, toolName: string, text: string, isError = false): SessionMessageEntry => ({
  type: "message",
  id: nextEntryId(),
  parentId: null,
  timestamp: timestamp(),
  message: {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [textPart(text)],
    isError,
    timestamp: tick(),
  },
});

interface QaFixture {
  events: ReturnType<typeof normalizeEntries>;
  summary: string;
}

const buildFixture = (): QaFixture => {
  entryId = 0;
  messageClock = 0;
  const filler = Array.from({ length: 125 }, (_, index) => textPart(`deterministic progress ${index}`));
  const entries: SessionEntry[] = [
    user("Implement reconstruction QA.\nKeep fidelity measurable.\nUse typed events.\nDo not retain prose."),
    assistant(toolCallPart("qa-edit", "edit", { path: "src/compaction/qa.ts" })),
    toolResult("qa-edit", "edit", "updated qa.ts"),
    assistant(toolCallPart("docs-edit", "edit", { path: "docs/compaction.md" })),
    toolResult("docs-edit", "edit", "updated compaction.md"),
    assistant(toolCallPart("test-write", "write", { path: "tests/compaction-qa.test.ts" })),
    toolResult("test-write", "write", "created compaction-qa.test.ts"),
    assistant(toolCallPart("missing-read", "read", { path: "src/missing.ts" })),
    toolResult("missing-read", "read", "ENOENT: no such file or directory", true),
    assistant(toolCallPart("commit", "bash", { command: "git commit -m 'test reconstruction qa'" })),
    toolResult("commit", "bash", "[feature abc1234] test reconstruction qa\n 3 files changed"),
    user("Add mutation tests"),
    assistant(...filler),
    user("Verify the report"),
  ];
  const events = normalizeEntries(entries);
  const summary = renderSummary(project(events), {
    firstEntryId: entries[0]!.id,
    lastEntryId: entries.at(-1)!.id,
    lastTimestamp: entries.at(-1)!.timestamp,
  });
  return { events, summary };
};

const dropSection = (summary: string, header: string): string => {
  const start = summary.indexOf(header);
  if (start < 0) return summary;
  const end = summary.indexOf("\n\n", start);
  return end < 0 ? summary.slice(0, start) : summary.slice(0, start) + summary.slice(end + 2);
};

const failedIds = (fixture: QaFixture, summary: string): string[] =>
  qaReport(fixture.events, fixture.events.length, summary).failures.map(({ probe }) => probe.id);

describe("compaction reconstruction QA", () => {
  it("passes against the real normalize → project → render engine output", () => {
    const fixture = buildFixture();
    const probes = generateProbes(fixture.events, fixture.events.length);
    const checked = checkProbes(fixture.summary, probes);
    const report = qaReport(fixture.events, fixture.events.length, fixture.summary);

    expect(probes.some((probe) => probe.class === "content" && probe.id === "goal")).toBe(true);
    expect(probes.some((probe) => probe.class === "content" && probe.answer === "compaction.md")).toBe(true);
    expect(probes.some((probe) => probe.class === "content" && probe.answer === "read src/missing.ts: ENOENT: no such file or directory")).toBe(true);
    expect(probes.some((probe) => probe.id.startsWith("commit:"))).toBe(false);
    expect(fixture.summary).not.toContain("[Commits]");
    expect(probes.some((probe) => probe.class === "address" && probe.id.startsWith("earlier-turn-address:"))).toBe(true);
    expect(probes.some((probe) => probe.class === "address" && probe.id === "footer-recall")).toBe(true);
    expect(checked.failed).toEqual([]);
    expect(checked.passed).toHaveLength(probes.length);
    expect(report).toEqual({ score: 1, contentScore: 1, addressScore: 1, failures: [] });
  });

  it("fails the unresolved-error probe when Outstanding Context is dropped", () => {
    const fixture = buildFixture();
    const mutated = dropSection(fixture.summary, "[Outstanding Context]");
    expect(failedIds(fixture, mutated)).toContainEqual(expect.stringMatching(/^unresolved-error:/));
  });

  it("fails a file probe when a modified file is removed from Files And Changes", () => {
    const fixture = buildFixture();
    const mutated = fixture.summary.replace("  docs/compaction.md [entry qa-e4]\n", "");
    const failure = qaReport(fixture.events, fixture.events.length, mutated).failures.find(
      ({ probe }) => probe.question.includes("docs/compaction.md"),
    );
    expect(failure?.probe.id).toMatch(/^modified-file:/);
  });

  it("fails the recall-address probe when the footer is dropped", () => {
    const fixture = buildFixture();
    const footer = fixture.summary.lastIndexOf("\n\n---\n[compacted ");
    expect(footer).toBeGreaterThan(0);
    const mutated = `${fixture.summary.slice(0, footer)}\n`;
    expect(failedIds(fixture, mutated)).toContain("footer-recall");
  });

  it("fails turn-count and address probes when Earlier Turns is truncated", () => {
    const fixture = buildFixture();
    const mutated = fixture.summary.replace('"Add mutation tests" [entry qa-e12]\n', "");
    const failures = qaReport(fixture.events, fixture.events.length, mutated).failures;
    expect(failures.some(({ probe }) => probe.id.startsWith("earlier-turn-count:") && probe.answer === '"Add mutation tests"')).toBe(true);
    expect(failures.some(({ probe }) => probe.id.startsWith("earlier-turn-address:") && probe.answer === '"Add mutation tests"')).toBe(true);
  });

  it("scores bounded omission ranges instead of requiring every large-list item inline", () => {
    entryId = 0;
    messageClock = 0;
    const entries: SessionEntry[] = [user("Bounded cumulative QA goal")];
    for (let index = 0; index < 48; index++) {
      const id = `bounded-edit-${index}`;
      entries.push(
        assistant(toolCallPart(id, "edit", { path: `src/bounded/file-${index}.ts` })),
        toolResult(id, "edit", `edited ${index}`),
        user(`Scope change ${index}`),
      );
    }
    const events = normalizeEntries(entries);
    const summary = renderSummary(project(events), {
      firstEntryId: entries[0]!.id,
      lastEntryId: entries.at(-1)!.id,
      lastTimestamp: entries.at(-1)!.timestamp,
    });
    const probes = generateProbes(events, events.length);
    expect(summary).toContain("omitted 24 file addresses");
    expect(summary).toContain("omitted 16 earlier turns");
    expect(probes.some((probe) => probe.id.startsWith("modified-file-omission:"))).toBe(true);
    expect(probes.some((probe) => probe.id.startsWith("earlier-turn-omission:"))).toBe(true);
    expect(qaReport(events, events.length, summary).failures).toEqual([]);
  });

  it("generates identical probes and reports for identical inputs", () => {
    const fixture = buildFixture();
    const firstProbes = generateProbes(fixture.events, fixture.events.length);
    const secondProbes = generateProbes(fixture.events, fixture.events.length);
    const firstReport = qaReport(fixture.events, fixture.events.length, fixture.summary);
    const secondReport = qaReport(fixture.events, fixture.events.length, fixture.summary);
    expect(secondProbes).toEqual(firstProbes);
    expect(secondReport).toEqual(firstReport);
  });
});
