import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { FabricDashboard } from "../src/ui/dashboard.js";
import type { FabricDashboardSnapshot } from "../src/ui/types.js";
import { FabricWidget, shouldShowFabricWidget } from "../src/ui/widget.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const ansiTheme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
  bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[49m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as Theme;

const snapshot = (): FabricDashboardSnapshot => {
  const now = Date.now();
  return {
    now,
    runs: [
      {
        id: "run-1",
        name: "Repository migration",
        description: "Port packages in two phases",
        status: "running",
        currentPhaseId: "audit",
        startedAt: now - 70_000,
        updatedAt: now,
        phases: [
          {
            id: "discover",
            name: "Discover",
            status: "completed",
            total: 1,
            startedAt: now - 70_000,
            updatedAt: now - 60_000,
            finishedAt: now - 60_000,
          },
          {
            id: "audit",
            name: "Audit",
            status: "running",
            total: 3,
            startedAt: now - 60_000,
            updatedAt: now,
          },
        ],
        calls: [
          {
            id: "call-agent",
            ref: "agents.run",
            label: "security-reviewer",
            kind: "agent",
            status: "running",
            phaseId: "audit",
            entityId: "agent-1",
            entityKind: "agent",
            startedAt: now - 40_000,
            updatedAt: now,
          },
          {
            id: "call-tool",
            ref: "extensions.project_status",
            label: "project status",
            kind: "extension",
            status: "completed",
            phaseId: "audit",
            startedAt: now - 30_000,
            updatedAt: now - 29_000,
            finishedAt: now - 29_000,
          },
        ],
        items: [
          {
            id: "packages",
            label: "Migrate packages",
            kind: "task",
            status: "running",
            phaseId: "audit",
            completed: 1,
            total: 3,
            createdAt: now - 50_000,
            updatedAt: now,
          },
        ],
        events: [],
      },
    ],
    agents: [
      {
        id: "agent-1",
        name: "security-reviewer",
        status: "running",
        transport: "process",
        cwd: "/tmp/project",
        task: "Review the migration for security defects",
        model: "anthropic/claude-opus-4-8",
        currentTool: "grep",
        startedAt: now - 40_000,
        updatedAt: now,
        turns: 2,
        toolCalls: 6,
        usage: { input: 4000, output: 1200, cacheRead: 0, cacheWrite: 0, cost: 0.04 },
        phaseId: "audit",
      },
    ],
    actors: [
      {
        id: "actor-1",
        name: "advisor",
        status: "idle",
        events: ["turn_end"],
        topics: ["team.review"],
        delivery: "mailbox",
        responseMode: "directive",
        triggerTurn: false,
        model: "anthropic/claude-sonnet-4-6",
        queued: 0,
        messages: 2,
        createdAt: now - 120_000,
        updatedAt: now,
        recentMessages: [],
      },
    ],
    state: [
      {
        key: "tasks/package-a",
        label: "Package A",
        status: "claimed",
        owner: "security-reviewer",
        value: { status: "claimed", owner: "security-reviewer" },
        version: 2,
        updatedAt: now,
      },
    ],
    events: [
      {
        id: "event-1",
        sequence: 1,
        topic: "team.review",
        kind: "finding",
        from: { id: "actor-1", name: "advisor", kind: "actor" },
        text: "Review started",
        createdAt: now,
      },
    ],
  };
};

describe("Fabric dynamic UI", () => {
  it("renders a bounded compact activity widget", () => {
    const current = snapshot();
    const widget = new FabricWidget(theme, () => current, 5, 10_000);
    const lines = widget.render(72);

    expect(lines.join("\n")).toContain("Repository migration");
    expect(lines.join("\n")).toContain("security-reviewer");
    expect(lines.join("\n")).toContain("Audit");
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines.every((line) => visibleWidth(line) <= 72)).toBe(true);
    const ansiLines = new FabricWidget(ansiTheme, () => current, 5, 10_000).render(48);
    expect(ansiLines.every((line) => visibleWidth(line) <= 48)).toBe(true);
    expect(shouldShowFabricWidget(current, "auto", 10_000)).toBe(true);
  });

  it("collapses completed runs while retaining ambient actor presence", () => {
    const current = snapshot();
    const run = current.runs[0];
    if (!run) throw new Error("missing fixture run");
    run.status = "completed";
    run.finishedAt = current.now - 20_000;
    current.agents[0]!.status = "completed";
    current.state = [];
    current.actors = [];
    expect(shouldShowFabricWidget(current, "auto", 10_000)).toBe(false);

    current.actors = snapshot().actors;
    expect(shouldShowFabricWidget(current, "auto", 10_000)).toBe(true);
    const lines = new FabricWidget(theme, () => current, 5, 10_000).render(72);
    expect(lines[0]).toContain("Fabric session");
    expect(lines.join("\n")).toContain("advisor");
  });

  it("keeps a stable height as nested calls complete", () => {
    const current = snapshot();
    const run = current.runs[0];
    if (!run) throw new Error("missing fixture run");
    run.calls = [
      { id: "c1", ref: "pi.bash", label: "bash one", kind: "tool", status: "running", phaseId: "audit", startedAt: run.startedAt, updatedAt: current.now },
      { id: "c2", ref: "pi.bash", label: "bash two", kind: "tool", status: "running", phaseId: "audit", startedAt: run.startedAt, updatedAt: current.now },
    ];
    run.items = [];
    current.agents = [];
    current.actors = [];
    current.state = [];

    const widget = new FabricWidget(theme, () => current, 8, 10_000);
    const first = widget.render(72);
    expect(first.length).toBe(3);
    expect(first[0]).toContain("0/2");
    expect(first.some((line) => line.includes("bash one"))).toBe(true);
    expect(first.some((line) => line.includes("bash two"))).toBe(true);

    run.calls[0]!.status = "completed";
    run.calls[0]!.finishedAt = current.now;
    const second = widget.render(72);
    expect(second.length).toBe(3);
    expect(second[0]).toContain("1/2");
    expect(second.some((line) => line.includes("bash one"))).toBe(true);
    expect(second.some((line) => line.includes("bash two"))).toBe(true);

    run.calls[1]!.status = "completed";
    run.calls[1]!.finishedAt = current.now;
    const third = widget.render(72);
    expect(third.length).toBe(3);
    expect(third[0]).toContain("2/2");

    run.id = "run-stable-2";
    run.calls = [
      { id: "c3", ref: "pi.bash", label: "bash three", kind: "tool", status: "running", phaseId: "audit", startedAt: run.startedAt, updatedAt: current.now },
    ];
    const fourth = widget.render(72);
    expect(fourth.length).toBe(2);
  });

  it("renders a responsive two-pane dashboard and agent details", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn());
    try {
      const overview = dashboard.render(120);
      const overviewText = overview.join("\n");
      expect(overviewText).toContain("Phases");
      expect(overviewText).toContain("Audit");
      expect(overviewText).toContain("security-reviewer");
      expect(overviewText).toContain("claude-opus-4-8");
      expect(overview.every((line) => visibleWidth(line) <= 120)).toBe(true);
      expect(dashboard.render(60).every((line) => visibleWidth(line) <= 60)).toBe(true);
      const ansiDashboard = new FabricDashboard(tui, ansiTheme, snapshot, vi.fn());
      try {
        expect(ansiDashboard.render(96).every((line) => visibleWidth(line) <= 96)).toBe(true);
      } finally {
        ansiDashboard.dispose();
      }

      dashboard.handleInput("l");
      dashboard.handleInput("\r");
      const detail = dashboard.render(80);
      const detailText = detail.join("\n");
      expect(detailText).toContain("Review the migration for security defects");
      expect(detailText).toContain("anthropic/claude-opus-4-8");
      expect(detail.every((line) => visibleWidth(line) <= 80)).toBe(true);
    } finally {
      dashboard.dispose();
    }
  });
});
