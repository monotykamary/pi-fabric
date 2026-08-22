import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("prewalk prompt isolation", () => {
  it("does not add prewalk state or guidance to before_agent_start", () => {
    const extensionSource = fs.readFileSync(
      path.join(process.cwd(), "src", "index.ts"),
      "utf8",
    );
    const toolSource = fs.readFileSync(
      path.join(process.cwd(), "src", "fabric-exec-tool.ts"),
      "utf8",
    );
    const start = extensionSource.indexOf('pi.on("before_agent_start"');
    const end = extensionSource.indexOf("registerFabricCommand", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const handler = extensionSource.slice(start, end);
    expect(handler.toLowerCase()).not.toContain("prewalk");

    const guidelinesStart = toolSource.indexOf("promptGuidelines: [");
    const guidelinesEnd = toolSource.indexOf("parameters:", guidelinesStart);
    expect(guidelinesStart).toBeGreaterThanOrEqual(0);
    expect(guidelinesEnd).toBeGreaterThan(guidelinesStart);
    const guidelines = toolSource.slice(guidelinesStart, guidelinesEnd).toLowerCase();
    expect(guidelines).not.toContain("prewalk");
    expect(guidelines).not.toContain("handoff");
  });

  it("keeps coding guidance outcome-oriented and context-bounded", () => {
    const toolSource = fs.readFileSync(
      path.join(process.cwd(), "src", "fabric-exec-tool.ts"),
      "utf8",
    );
    const start = toolSource.indexOf("promptGuidelines: [");
    const end = toolSource.indexOf("parameters:", start);
    const guidelines = toolSource.slice(start, end);
    const visibleGuidelines = guidelines
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith('"') && line.endsWith('",'));
    const visibleGuidelineChars = visibleGuidelines.reduce(
      (total, line) => total + line.length - 3,
      0,
    );

    expect(visibleGuidelines).toHaveLength(6);
    expect(visibleGuidelineChars).toBeLessThanOrEqual(2_200);
    expect(guidelines).toContain("acceptance ledger");
    expect(guidelines).toContain("direct behavioral probes");
    expect(guidelines).toContain("requested public symbols, registrations, and configuration entries");
    expect(guidelines).toContain("smallest checks that cover the ledger");
    expect(guidelines).toContain("instead of rerunning unchanged passing checks");
    expect(guidelines).toContain("A build alone is not completion");
    expect(guidelines).toContain("one `pi.edit({path, edits:[...]})`");
    expect(guidelines).toContain("`all:true` only for intentional repeated exact anchors");
    expect(guidelines).toContain("`literal:true` for exact punctuated text");
    expect(guidelines).toContain("fan-out search limits small");
    expect(guidelines).toContain("`settle:true` for tests or probes");
    expect(guidelines).toContain("`timeout` in seconds once");
    expect(guidelines).toContain("batch only independent, bounded work");
    expect(guidelines).toContain("not raw logs or unused intermediate results");
    expect(guidelines).toContain("pass payloads through top-level `strings`");
    expect(guidelines).toContain("prefer `pi.edit`/`pi.write`");
    expect(guidelines).toContain("`pi.bash`: no cwd/stdin");
    expect(guidelines).toContain("`display.name` and objective `display.description`");
    expect(guidelines).toContain("pairs them with verified outcomes");
    expect(guidelines).toContain("deterministic compaction");
  });

  it("runs handoff from finalized outer message_end without aborting nested calls", () => {
    const extensionSource = fs.readFileSync(
      path.join(process.cwd(), "src", "index.ts"),
      "utf8",
    );
    const toolSource = fs.readFileSync(
      path.join(process.cwd(), "src", "fabric-exec-tool.ts"),
      "utf8",
    );
    const start = extensionSource.indexOf('pi.on("tool_result"');
    const end = extensionSource.indexOf('pi.on("tool_execution_end"', start);
    const boundaryHandlers = extensionSource.slice(start, end);

    expect(boundaryHandlers).toContain('pi.on("message_end"');
    expect(boundaryHandlers).toContain("state.runHandoffAtBoundary");
    expect(toolSource).toContain("state.claimHandoff");
  });

  it("disarms the captured task from the agent_settled lifecycle", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "index.ts"), "utf8");
    const start = source.indexOf('pi.on("agent_settled"');
    const end = source.indexOf('pi.on("tool_call"', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain("state.prewalk.settleTask");
  });
});
