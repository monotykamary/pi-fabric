import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { FabricDashboard } from "../src/ui/dashboard.js";
import { wrapPlainText } from "../src/ui/format.js";
import type { ModelSource } from "../src/ui/model-picker.js";
import type { FabricThinking } from "../src/thinking.js";
import type { FabricDashboardSnapshot } from "../src/ui/types.js";
import { FabricWidget, shouldShowFabricWidget } from "../src/ui/widget.js";

const actorModelSource: ModelSource = {
  models: [
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
  ],
  lastUsed: {},
};

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
        runId: "run-1",
        phaseId: "audit",
      },
    ],
    actors: [
      {
        id: "actor-1",
        name: "advisor",
        status: "idle",
        runner: "pi",
        events: ["turn_end"],
        topics: ["team.review"],
        delivery: "mailbox",
        responseMode: "directive",
        triggerTurn: false,
        coalesce: true,
        model: "anthropic/claude-sonnet-4-6",
        queued: 0,
        messages: 2,
        createdAt: now - 120_000,
        updatedAt: now,
        instructions: "Advise only when useful.",
        recentMessages: [],
      },
    ],
    globalActors: [],
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
    const widget = new FabricWidget(theme, () => current, 5);
    const lines = widget.render(72);

    expect(lines.join("\n")).toContain("Repository migration");
    expect(lines.join("\n")).toContain("security-reviewer");
    expect(lines.join("\n")).toContain("Audit");
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines.every((line) => visibleWidth(line) <= 72)).toBe(true);
    const ansiLines = new FabricWidget(ansiTheme, () => current, 5).render(48);
    expect(ansiLines.every((line) => visibleWidth(line) <= 48)).toBe(true);
    expect(shouldShowFabricWidget(current, "auto")).toBe(true);
  });

  it("shows only agent-provider rows in the widget", () => {
    const current = snapshot();
    const customCall = current.runs[0]!.calls.find((call) => call.kind === "extension")!;
    current.runs[0]!.calls = [
      {
        ...customCall,
        id: "custom-index",
        label: "Custom index",
        status: "running",
        entityKind: "custom",
        progress: "Indexing packages",
      },
    ];

    const withAgent = new FabricWidget(theme, () => current, 8).render(120).join("\n");
    expect(withAgent).toContain("security-reviewer");
    expect(withAgent).not.toContain("Custom index");
    expect(withAgent).not.toContain("advisor");
    expect(withAgent).not.toContain("Package A");

    current.agents = [];
    const withoutAgents = new FabricWidget(theme, () => current, 8).render(120);
    expect(withoutAgents).toHaveLength(1);
    expect(withoutAgents.join("\n")).not.toContain("Custom index");
    expect(withoutAgents.join("\n")).not.toContain("advisor");
    expect(withoutAgents.join("\n")).not.toContain("Package A");
  });

  it("does not mount the auto widget for standalone non-agent state", () => {
    const current = snapshot();
    current.runs = [];
    current.agents = [];
    current.actors = [];
    expect(current.state[0]?.status).toBe("claimed");
    expect(shouldShowFabricWidget(current, "auto")).toBe(false);
  });

  it("keeps dashboard and widget agents in creation order", () => {
    const current = snapshot();
    current.actors = [];
    current.state = [];
    current.runs[0]!.calls = [];
    current.runs[0]!.items = [];
    const base = current.agents[0]!;
    current.agents = [
      { ...base, id: "third", name: "third-created", startedAt: 300, updatedAt: 700 },
      { ...base, id: "first", name: "first-created", startedAt: 100, updatedAt: 900 },
      { ...base, id: "second", name: "second-created", startedAt: 200, updatedAt: 800 },
    ];

    const widgetText = new FabricWidget(theme, () => current, 8).render(120).join("\n");
    expect(widgetText.indexOf("first-created")).toBeLessThan(widgetText.indexOf("second-created"));
    expect(widgetText.indexOf("second-created")).toBeLessThan(widgetText.indexOf("third-created"));

    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      const dashboardText = dashboard.render(120).join("\n");
      expect(dashboardText.indexOf("first-created")).toBeLessThan(
        dashboardText.indexOf("second-created"),
      );
      expect(dashboardText.indexOf("second-created")).toBeLessThan(
        dashboardText.indexOf("third-created"),
      );

      current.agents[2]!.updatedAt = 1_000;
      current.agents[0]!.updatedAt = 0;
      const refreshed = dashboard.render(120).join("\n");
      expect(refreshed.indexOf("first-created")).toBeLessThan(
        refreshed.indexOf("second-created"),
      );
      expect(refreshed.indexOf("second-created")).toBeLessThan(
        refreshed.indexOf("third-created"),
      );
    } finally {
      dashboard.dispose();
    }
  });

  it("keeps completed runs visible and summarizes actors without listing them", () => {
    const current = snapshot();
    const run = current.runs[0];
    if (!run) throw new Error("missing fixture run");
    run.status = "completed";
    run.finishedAt = current.now - 20_000;
    current.agents[0]!.status = "completed";
    current.state = [];
    current.actors = [];
    // A completed run remains visible through agent_settled so its rows do not collapse.
    expect(shouldShowFabricWidget(current, "auto")).toBe(true);
    // An explicit dismissal watermark can still hide retained history.
    current.widgetDismissedAt = current.now;
    expect(shouldShowFabricWidget(current, "auto")).toBe(false);
    // ambient actors keep the widget visible regardless
    current.actors = snapshot().actors;
    expect(shouldShowFabricWidget(current, "auto")).toBe(true);
    const lines = new FabricWidget(theme, () => current, 5).render(72);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Fabric session");
    expect(lines[0]).toContain("1 actor");
    expect(lines.join("\n")).not.toContain("advisor");
  });

  it("keeps a bounded terminal agent result cue through settle", () => {
    const current = snapshot();
    const run = current.runs[0]!;
    run.status = "completed";
    run.finishedAt = current.now;
    current.actors = [];
    current.state = [];
    current.agents[0]!.status = "completed";
    current.agents[0]!.finishedAt = current.now;
    delete current.agents[0]!.currentTool;
    current.agents[0]!.text = "Found a concrete regression";

    const lines = new FabricWidget(theme, () => current, 5).render(72).join("\n");
    expect(lines).toContain("security-reviewer");
    expect(lines).toContain("result: Found a concrete regression");

    current.widgetDismissedAt = current.now;
    expect(shouldShowFabricWidget(current, "auto")).toBe(false);
  });

  it("hides explicitly dismissed runs and resurfaces later ones", () => {
    const current = snapshot();
    const run = current.runs[0];
    if (!run) throw new Error("missing fixture run");
    run.calls = [
      { id: "c1", ref: "pi.bash", label: "pi.bash", kind: "tool", status: "completed", phaseId: "audit", startedAt: run.startedAt, updatedAt: current.now, finishedAt: current.now, detail: "done" },
    ];
    run.items = [];
    current.agents = [];
    current.actors = [];
    current.state = [];
    run.status = "completed";
    run.finishedAt = current.now;
    current.widgetDismissedAt = 0;
    // A freshly finished non-agent run remains summarized by its header only.
    expect(shouldShowFabricWidget(current, "auto")).toBe(true);
    const lines = new FabricWidget(theme, () => current, 8).render(72);
    expect(lines).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("pi.bash");
    // An explicit dismissal hides retained history.
    current.widgetDismissedAt = current.now;
    expect(shouldShowFabricWidget(current, "auto")).toBe(false);
    current.widgetDismissedAt = current.now + 1;
    expect(shouldShowFabricWidget(current, "auto")).toBe(false);
    // a later run that finishes after the dismiss shows again
    run.finishedAt = current.now + 2000;
    run.updatedAt = run.finishedAt;
    current.now = run.finishedAt;
    expect(shouldShowFabricWidget(current, "auto")).toBe(true);
  });

  it("keeps widget rows stable as agents complete", () => {
    const current = snapshot();
    current.actors = [];
    current.state = [];
    current.runs[0]!.items = [];
    current.runs[0]!.calls = [];
    current.agents = [
      { ...snapshot().agents[0]!, id: "agent-1", name: "alpha", status: "running" },
      { ...snapshot().agents[0]!, id: "agent-2", name: "beta", status: "running" },
    ];
    const widget = new FabricWidget(theme, () => current, 8);
    const first = widget.render(72);
    expect(first.length).toBe(3); // header + alpha + beta

    current.agents[1]!.status = "completed";
    const second = widget.render(72);
    expect(second).toHaveLength(first.length);
    expect(second.join("\n")).toContain("alpha");
    expect(second.join("\n")).toContain("beta");
    expect(second.every((line) => visibleWidth(line) > 0)).toBe(true);

    current.agents[0]!.status = "completed";
    const third = widget.render(72);
    expect(third).toHaveLength(first.length);
    expect(third.join("\n")).toContain("alpha");
    expect(third.join("\n")).toContain("beta");
  });

  it("leases rows within one run and releases them for a newer run", () => {
    const current = snapshot();
    const call = current.runs[0]!.calls.find((candidate) => candidate.kind === "extension")!;
    current.actors = [];
    current.state = [];
    current.runs[0]!.items = [];
    current.runs[0]!.calls = [
      {
        ...call,
        id: "custom-index",
        label: "Custom index",
        status: "running",
        entityKind: "custom",
      },
    ];
    const base = current.agents[0]!;
    current.agents = [
      { ...base, id: "agent-1", name: "alpha" },
      { ...base, id: "agent-2", name: "beta" },
    ];
    const widget = new FabricWidget(theme, () => current, 8);
    const withAgents = widget.render(72);
    expect(withAgents).toHaveLength(3);

    current.agents = [];
    const withoutAgents = widget.render(72);
    expect(withoutAgents).toHaveLength(withAgents.length);
    expect(withoutAgents.join("\n")).not.toContain("Custom index");
    expect(withoutAgents.at(-1)).toBe("");

    const previousRun = current.runs[0]!;
    current.runs[0] = {
      ...previousRun,
      id: "run-2",
      name: "Smaller follow-up",
      startedAt: current.now,
      updatedAt: current.now,
    };
    const newerRun = widget.render(72);
    expect(newerRun).toHaveLength(1);
    expect(newerRun.join("\n")).not.toContain("Custom index");
  });

  it("keeps the hidden-row marker visible at the width boundary", () => {
    const current = snapshot();
    current.actors = [];
    current.state = [];
    current.runs[0]!.items = [];
    current.runs[0]!.calls = [];
    current.agents = [
      { ...current.agents[0]!, id: "agent-one", name: "a very long active agent name", status: "running" },
      { ...current.agents[0]!, id: "agent-two", name: "second", status: "running" },
    ];
    const lines = new FabricWidget(theme, () => current, 2).render(24);
    expect(lines[1]).toContain("+1");
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
  });

  it("reports whether the rendered output changed", () => {
    const current = snapshot();
    current.actors = [];
    current.state = [];
    current.runs[0]!.items = [];
    current.runs[0]!.calls = [];
    current.runs[0]!.status = "completed";
    current.runs[0]!.finishedAt = current.now;
    current.agents = [];
    const widget = new FabricWidget(theme, () => current, 8);
    expect(widget.hasChanged()).toBe(true); // never rendered
    widget.render(72);
    expect(widget.hasChanged()).toBe(false); // identical
    current.runs[0]!.name = "Changed title";
    expect(widget.hasChanged()).toBe(true); // content changed
    widget.render(72);
    expect(widget.hasChanged()).toBe(false); // re-rendered, now identical
  });

  it("groups dashboard entities by type within the selected sidebar phase", () => {
    const current = snapshot();
    const task = current.runs[0]!.items[0]!;
    current.runs[0]!.items.push({
      ...task,
      id: "custom-review",
      label: "Custom review",
      kind: "custom",
    });
    const extensionCall = current.runs[0]!.calls.find((call) => call.kind === "extension")!;
    current.runs[0]!.calls.push({
      ...extensionCall,
      id: "custom-call",
      label: "Custom provider activity",
      entityKind: "custom",
    });
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      const renderedLines = dashboard.render(120);
      const rendered = renderedLines.join("\n");
      expect(rendered).toContain("Activity");
      expect(rendered).toContain("Discover");
      expect(rendered).toContain("Audit");
      expect(rendered).toContain("Agents (1)");
      expect(rendered).toContain("Extensions (1)");
      expect(rendered).toContain("Tasks (1)");
      expect(rendered).toContain("Custom items (2)");
      expect(rendered).not.toContain("Actors (1)");
      expect(rendered).not.toContain("Shared state (1)");
      expect(rendered.indexOf("Agents (1)")).toBeLessThan(rendered.indexOf("Extensions (1)"));
      expect(rendered.indexOf("Extensions (1)")).toBeLessThan(rendered.indexOf("Tasks (1)"));
      expect(rendered.indexOf("Tasks (1)")).toBeLessThan(rendered.indexOf("Custom items (2)"));
      for (const heading of ["Extensions (1)", "Tasks (1)", "Custom items (2)"]) {
        const headingIndex = renderedLines.findIndex((line) => line.includes(heading));
        expect(headingIndex).toBeGreaterThan(0);
        expect(renderedLines[headingIndex - 1]?.split("│")[2]?.trim()).toBe("");
      }
      expect(renderedLines.some((line) => /^│[^│]*│[^│]*Audit/.test(line))).toBe(false);

      dashboard.handleInput("G");
      const session = dashboard.render(120).join("\n");
      expect(session).toContain("Actors (1)");
      expect(session).toContain("Shared state (1)");
      expect(session.indexOf("Actors (1)")).toBeLessThan(session.indexOf("Shared state (1)"));
    } finally {
      dashboard.dispose();
    }
  });
  it("moves the cursor through type groups in each sidebar phase", () => {
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI,
      theme,
      snapshot,
      vi.fn(),
    );
    const inspectSelection = (): string => {
      dashboard.handleInput("\r");
      const detail = dashboard.render(120).join("\n");
      dashboard.handleInput("\x1b");
      return detail;
    };
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      expect(inspectSelection()).toContain("agent · security-reviewer");

      dashboard.handleInput("j");
      expect(inspectSelection()).toContain("call · project status");

      dashboard.handleInput("j");
      expect(inspectSelection()).toContain("item · Migrate packages");

      dashboard.handleInput("k");
      expect(inspectSelection()).toContain("call · project status");

      dashboard.handleInput("h");
      dashboard.handleInput("G");
      dashboard.handleInput("l");
      expect(inspectSelection()).toContain("actor · advisor");

      dashboard.handleInput("j");
      expect(inspectSelection()).toContain("state · Package A");
    } finally {
      dashboard.dispose();
    }
  });
  it("keeps the overview height stable when the entity action hint appears", () => {
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI,
      theme,
      snapshot,
      vi.fn(),
    );
    try {
      const withoutHint = dashboard.render(120);
      expect(withoutHint.join("\n")).not.toContain("enter details");

      dashboard.handleInput("l");
      const withHint = dashboard.render(120);
      expect(withHint.join("\n")).toContain("enter details");
      expect(withHint).toHaveLength(withoutHint.length);

      dashboard.handleInput("h");
      expect(dashboard.render(120)).toHaveLength(withoutHint.length);
    } finally {
      dashboard.dispose();
    }
  });

  it("renders a responsive sidebar with a heading-free grouped activity pane", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn());
    try {
      const overview = dashboard.render(120);
      const overviewText = overview.join("\n");
      expect(overviewText).toContain("Activity");
      expect(overviewText).toContain("Audit");
      expect(overviewText).toContain("Agents (1)");
      expect(overviewText).not.toContain("Actors (1)");
      expect(overviewText).toContain("security-reviewer");
      expect(overviewText).toContain("claude-opus-4-8");
      expect(overview.some((line) => /^│[^│]*│[^│]*Audit/.test(line))).toBe(false);
      expect(overview.every((line) => visibleWidth(line) <= 120)).toBe(true);
      expect(dashboard.render(60).every((line) => visibleWidth(line) <= 60)).toBe(true);
      const tooNarrow = dashboard.render(20);
      expect(tooNarrow.join("\n")).toContain("too narrow");
      expect(tooNarrow.every((line) => visibleWidth(line) <= 20)).toBe(true);
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
  it("renders call inputs and outputs with preview highlighting", () => {
    const current = snapshot();
    current.agents = [];
    current.actors = [];
    current.globalActors = [];
    current.state = [];
    current.runs[0]!.items = [];
    const now = current.now;
    current.runs[0]!.calls = [
      {
        id: "bash-detail",
        ref: "pi.bash",
        label: "pi.bash",
        kind: "tool",
        status: "completed",
        args: { command: "pnpm vitest run tests/fabric-ui.test.ts" },
        result: { ok: true, output: "Tests **passed**" },
        startedAt: now - 1_000,
        updatedAt: now,
        finishedAt: now,
      },
      {
        id: "edit-detail",
        ref: "pi.edit",
        label: "pi.edit",
        kind: "tool",
        status: "completed",
        args: {
          path: "src/example.ts",
          edits: [{ oldText: "const oldValue = 1;", newText: "const newValue = 2;" }],
        },
        result: { ok: true, output: "edited" },
        startedAt: now - 900,
        updatedAt: now,
        finishedAt: now,
      },
      {
        id: "write-detail",
        ref: "pi.write",
        label: "pi.write",
        kind: "tool",
        status: "completed",
        args: { path: "src/example.ts", content: "export const value = 2;" },
        result: { ok: true, created: true },
        startedAt: now - 800,
        updatedAt: now,
        finishedAt: now,
      },
      {
        id: "structured-detail",
        ref: "extensions.analyze",
        label: "analyze",
        kind: "extension",
        status: "completed",
        args: { query: "ui regressions", limit: 2 },
        result: { findings: [{ name: "cursor jump", fixed: true }] },
        startedAt: now - 700,
        updatedAt: now,
        finishedAt: now,
      },
    ];
    for (const call of current.runs[0]!.calls) call.phaseId = "audit";

    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 60 } } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    const openDetail = (index: number): string => {
      for (let step = 0; step < index; step++) dashboard.handleInput("j");
      dashboard.handleInput("\r");
      const pages: string[] = [];
      for (let scroll = 0; scroll < 20; scroll++) {
        pages.push(dashboard.render(100).join("\n"));
        dashboard.handleInput("j");
      }
      dashboard.handleInput("\x1b");
      return pages.join("\n");
    };
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      const bash = openDetail(0);
      expect(bash).toContain("Command:");
      expect(bash).toContain("pnpm vitest run tests/fabric-ui.test.ts");
      expect(bash).toContain("Output:");
      expect(bash).toContain("Tests passed");
      expect(bash).not.toContain("**passed**");

      const edit = openDetail(1);
      expect(edit).toContain("Edits:");
      expect(edit).toContain("const oldValue = 1;");
      expect(edit).toContain("const newValue = 2;");

      const write = openDetail(1);
      expect(write).toContain("Content:");
      expect(write).toContain("export const value = 2;");
      expect(write).toContain("Output:");
      expect(write).toContain("created: true");

      const structured = openDetail(1);
      expect(structured).toContain("Input:");
      expect(structured).toContain("query: ui regressions");
      expect(structured).toContain("limit: 2");
      expect(structured).toContain("Output:");
      expect(structured).toContain("findings:");
      expect(structured).toContain("fixed: true");
    } finally {
      dashboard.dispose();
    }
  });

  it("renders agent task and result as Markdown and structured values as YAML", () => {
    const current = snapshot();
    current.agents[0]!.task = "## Planned checks\n\n- Inspect **authentication**";
    current.agents[0]!.text = "### Findings\n\n1. Found a **rotation gap**";
    current.agents[0]!.value = {
      findings: [{ severity: "high", path: "src/auth.ts" }],
      approved: false,
    };
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 60 } } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      dashboard.handleInput("\r");
      const firstPage = dashboard.render(100).join("\n");
      for (let index = 0; index < 30; index++) dashboard.handleInput("j");
      const lastPage = dashboard.render(100).join("\n");
      const detail = `${firstPage}\n${lastPage}`;

      expect(detail).toContain("Task:");
      expect(detail).toContain("Planned checks");
      expect(detail).toContain("Inspect authentication");
      expect(detail).not.toContain("## Planned checks");
      expect(detail).not.toContain("**authentication**");
      expect(detail).toContain("Result:");
      expect(detail).toContain("Findings");
      expect(detail).toContain("Found a rotation gap");
      expect(detail).toContain("Value:");
      expect(detail).toContain("findings:");
      expect(detail).toContain("- severity: high");
      expect(detail).toContain("path: src/auth.ts");
      expect(detail).toContain("approved: false");
      expect(detail).not.toContain('{"findings"');
      expect(detail.split("\n").every((line) => visibleWidth(line) <= 100)).toBe(true);
    } finally {
      dashboard.dispose();
    }
  });

  const openActorDetail = (dashboard: FabricDashboard): void => {
    dashboard.handleInput("G");
    dashboard.handleInput("l");
    dashboard.handleInput("\r");
  };

  it("offers a per-actor model picker from the actor detail view", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const onActorModel = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
      onActorModel,
    });
    try {
      openActorDetail(dashboard);
      const detail = dashboard.render(120);
      expect(detail.join("\n")).toContain("advisor");
      expect(detail.join("\n")).toContain("m model");

      // Open the picker.
      dashboard.handleInput("m");
      const picker = dashboard.render(120);
      const pickerText = picker.join("\n");
      expect(pickerText).toContain('Model for actor "advisor"');
      expect(pickerText).toContain("Inherit");
      expect(pickerText).toContain("claude-sonnet-4-5");
      expect(picker.every((line) => visibleWidth(line) <= 120)).toBe(true);

      // Select the first real model (Inherit is index 0; one down lands on it).
      dashboard.handleInput("\x1b[B");
      dashboard.handleInput("\r");
      expect(onActorModel).toHaveBeenCalledWith("actor-1", "anthropic/claude-sonnet-4-5");

      // Selecting closes the picker and returns to the actor detail.
      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
      expect(after.join("\n")).not.toContain('Model for actor "advisor"');
    } finally {
      dashboard.dispose();
    }
  });

  it("uses the Claude runtime catalog for a Claude actor", () => {
    const current = snapshot();
    current.actors[0]!.runner = "claude";
    current.actors[0]!.model = "claude/haiku";
    const onActorModel = vi.fn();
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
      {
        modelSource: actorModelSource,
        claudeModelSource: {
          models: [{ provider: "claude", id: "haiku", name: "Haiku (runtime)" }],
          lastUsed: {},
        },
        onActorModel,
      },
    );
    try {
      openActorDetail(dashboard);
      dashboard.handleInput("m");
      const picker = dashboard.render(120).join("\n");
      expect(picker).toContain('Model for Claude actor "advisor"');
      expect(picker).toContain("Haiku (runtime)");
      dashboard.handleInput("\r");
      expect(onActorModel).toHaveBeenCalledWith("actor-1", "claude/haiku");
    } finally {
      dashboard.dispose();
    }
  });

  it("picking Inherit clears the actor model override", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const onActorModel = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
      onActorModel,
    });
    try {
      openActorDetail(dashboard);
      dashboard.handleInput("m");
      // Inherit is the default selection (index 0).
      dashboard.handleInput("\r");
      expect(onActorModel).toHaveBeenCalledWith("actor-1", undefined);
      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
    } finally {
      dashboard.dispose();
    }
  });

  it("canceling the picker returns to the detail without changing the model", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const onActorModel = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
      onActorModel,
    });
    try {
      openActorDetail(dashboard);
      dashboard.handleInput("m");
      dashboard.handleInput("\x1b");
      expect(onActorModel).not.toHaveBeenCalled();
      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
      expect(after.join("\n")).not.toContain('Model for actor "advisor"');
    } finally {
      dashboard.dispose();
    }
  });

  it("offers a per-actor thinking picker from the actor detail view", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const onActorThinking = vi.fn<(id: string, thinking: FabricThinking | undefined) => void>();
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
      onActorThinking,
    });
    try {
      openActorDetail(dashboard);
      const detail = dashboard.render(120);
      expect(detail.join("\n")).toContain("advisor");
      expect(detail.join("\n")).toContain("e thinking");

      // Open the thinking picker.
      dashboard.handleInput("e");
      const picker = dashboard.render(120);
      const pickerText = picker.join("\n");
      expect(pickerText).toContain('Thinking level for actor "advisor"');
      expect(pickerText).toContain("Inherit");
      expect(pickerText).toContain("Medium");
      expect(picker.every((line) => visibleWidth(line) <= 120)).toBe(true);

      // Inherit is index 0; "medium" is index 4 (off=1, minimal=2, low=3, medium=4).
      dashboard.handleInput("\x1b[B");
      dashboard.handleInput("\x1b[B");
      dashboard.handleInput("\x1b[B");
      dashboard.handleInput("\x1b[B");
      dashboard.handleInput("\r");
      expect(onActorThinking).toHaveBeenCalledWith("actor-1", "medium");

      // Selecting closes the picker and returns to the actor detail.
      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
      expect(after.join("\n")).not.toContain('Thinking level for actor "advisor"');
    } finally {
      dashboard.dispose();
    }
  });

  it("picking Inherit clears the actor thinking override", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const onActorThinking = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
      onActorThinking,
    });
    try {
      openActorDetail(dashboard);
      dashboard.handleInput("e");
      // Inherit is the default selection (index 0) for an actor with no thinking set.
      dashboard.handleInput("\r");
      expect(onActorThinking).toHaveBeenCalledWith("actor-1", undefined);
      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
    } finally {
      dashboard.dispose();
    }
  });

  it("canceling the thinking picker returns to the detail without changing thinking", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const onActorThinking = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
      onActorThinking,
    });
    try {
      openActorDetail(dashboard);
      dashboard.handleInput("e");
      dashboard.handleInput("\x1b");
      expect(onActorThinking).not.toHaveBeenCalled();
      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
      expect(after.join("\n")).not.toContain('Thinking level for actor "advisor"');
    } finally {
      dashboard.dispose();
    }
  });

  it("does not offer the thinking picker when no onActorThinking is wired", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn());
    try {
      openActorDetail(dashboard);
      const detail = dashboard.render(120);
      expect(detail.join("\n")).not.toContain("e thinking");
      // Pressing e is a no-op: still in the actor detail.
      dashboard.handleInput("e");
      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
    } finally {
      dashboard.dispose();
    }
  });

  it("does not offer the picker when no model source is wired", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn());
    try {
      openActorDetail(dashboard);
      const detail = dashboard.render(120);
      expect(detail.join("\n")).not.toContain("m model");
      // Pressing m is a no-op: still in the actor detail.
      dashboard.handleInput("m");
      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
    } finally {
      dashboard.dispose();
    }
  });

  it("offers a per-actor host-event picker from the actor detail view", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const onActorEvents = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
      onActorEvents,
    });
    try {
      openActorDetail(dashboard);
      const detail = dashboard.render(120);
      expect(detail.join("\n")).toContain("v events");
      // clear is offered by its own callback, not wired in this test.
      expect(detail.join("\n")).not.toContain("c clear");

      // Open the events picker. The fixture actor subscribes to turn_end only.
      dashboard.handleInput("v");
      const picker = dashboard.render(120);
      const pickerText = picker.join("\n");
      expect(pickerText).toContain('Host events for actor "advisor"');
      expect(pickerText).toContain("[x] turn_end");
      expect(pickerText).toContain("[ ] input");
      expect(picker.every((line) => visibleWidth(line) <= 120)).toBe(true);

      // Toggle input on (index 0), move down to turn_end, toggle it off, apply.
      dashboard.handleInput(" ");
      dashboard.handleInput("\x1b[B");
      dashboard.handleInput(" ");
      dashboard.handleInput("\r");
      expect(onActorEvents).toHaveBeenCalledWith("actor-1", ["input"]);

      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
      expect(after.join("\n")).not.toContain('Host events for actor "advisor"');
    } finally {
      dashboard.dispose();
    }
  });

  it("canceling the events picker returns to the detail without changing events", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const onActorEvents = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
      onActorEvents,
    });
    try {
      openActorDetail(dashboard);
      dashboard.handleInput("v");
      dashboard.handleInput("\x1b");
      expect(onActorEvents).not.toHaveBeenCalled();
      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
      expect(after.join("\n")).not.toContain('Host events for actor "advisor"');
    } finally {
      dashboard.dispose();
    }
  });

  it("clearing the mailbox invokes onClearMessages without leaving the detail", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const onClearMessages = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
      onClearMessages,
    });
    try {
      openActorDetail(dashboard);
      const detail = dashboard.render(120);
      expect(detail.join("\n")).toContain("c clear");

      dashboard.handleInput("c");
      expect(onClearMessages).toHaveBeenCalledWith("actor-1");

      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
    } finally {
      dashboard.dispose();
    }
  });

  it("does not offer the events or clear actions when not wired", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
    });
    try {
      openActorDetail(dashboard);
      const detail = dashboard.render(120);
      expect(detail.join("\n")).not.toContain("v events");
      expect(detail.join("\n")).not.toContain("c clear");
      // Pressing v/c is a no-op: still in the actor detail.
      dashboard.handleInput("v");
      dashboard.handleInput("c");
      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
    } finally {
      dashboard.dispose();
    }
  });
  it("shows active and completed run-owned work in the Agents group", () => {
    const current = snapshot();
    const run = current.runs[0]!;
    current.actors = [];
    current.globalActors = [];
    current.state = [];
    current.events = [];
    run.status = "completed";
    run.finishedAt = current.now - 1_000;
    for (const phase of run.phases) phase.status = "completed";
    run.items = [];
    run.calls = [
      {
        id: "spawn-active",
        ref: "agents.spawn",
        label: "background-active",
        kind: "agent",
        status: "completed",
        entityId: "agent-active",
        startedAt: current.now - 2_000,
        updatedAt: current.now - 1_900,
        finishedAt: current.now - 1_900,
      },
      {
        id: "spawn-done",
        ref: "agents.spawn",
        label: "background-done",
        kind: "agent",
        status: "completed",
        entityId: "agent-done",
        startedAt: current.now - 3_000,
        updatedAt: current.now - 2_900,
        finishedAt: current.now - 2_900,
      },
    ];
    const { phaseId: _phaseId, ...unphasedAgent } = snapshot().agents[0]!;
    current.agents = [
      {
        ...unphasedAgent,
        id: "agent-active",
        name: "background-active",
        status: "running",
        runId: run.id,
      },
      {
        ...unphasedAgent,
        id: "agent-done",
        name: "background-done",
        status: "completed",
        runId: run.id,
      },
    ];

    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      const all = dashboard.render(120).join("\n");
      expect(all).toContain("Agents (2)");
      expect(all).toContain("background-active");
      expect(all).toContain("background-done");
      expect(all).toContain("Run activity");

      dashboard.handleInput("f");
      const active = dashboard.render(120).join("\n");
      expect(active).toContain("background-active");
      expect(active).not.toContain("background-done");

      dashboard.handleInput("f");
      const completed = dashboard.render(120).join("\n");
      expect(completed).not.toContain("background-active");
      expect(completed).toContain("background-done");
    } finally {
      dashboard.dispose();
    }
  });

  it("keeps lifecycle calls and linked agents in their sidebar phases", () => {
    const current = snapshot();
    const run = current.runs[0]!;
    current.actors = [];
    current.globalActors = [];
    current.state = [];
    run.currentPhaseId = "implement";
    run.phases = [
      {
        id: "spawn",
        name: "Spawn agents",
        status: "completed",
        total: 1,
        startedAt: current.now - 10_000,
        updatedAt: current.now - 9_000,
        finishedAt: current.now - 9_000,
      },
      {
        id: "implement",
        name: "Implement",
        status: "running",
        total: 1,
        startedAt: current.now - 9_000,
        updatedAt: current.now,
      },
    ];
    run.calls = [
      {
        id: "spawn-agent",
        ref: "agents.spawn",
        label: "worker",
        kind: "agent",
        status: "completed",
        phaseId: "spawn",
        entityId: "agent-1",
        startedAt: current.now - 10_000,
        updatedAt: current.now - 9_000,
        finishedAt: current.now - 9_000,
      },
      {
        id: "wait-agent",
        ref: "agents.wait",
        label: "wait for worker",
        kind: "agent",
        status: "running",
        phaseId: "implement",
        entityId: "agent-1",
        startedAt: current.now - 8_000,
        updatedAt: current.now,
      },
    ];
    run.items = [];
    current.agents[0] = {
      ...current.agents[0]!,
      name: "worker",
      phaseId: "spawn",
    };

    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      const implementLines = dashboard.render(120);
      const implement = implementLines.join("\n");
      expect(implement).toContain("Agents (1)");
      expect(implement).toContain("wait for worker");
      expect(implement).toContain("Spawn agents");
      expect(implement).toContain("Implement");
      expect(implementLines.some((line) => /^│[^│]*│[^│]*Implement/.test(line))).toBe(false);

      dashboard.handleInput("k");
      const spawn = dashboard.render(120).join("\n");
      expect(spawn).toContain("Agents (1)");
      expect(spawn).toContain("worker");
      expect(spawn).not.toContain("wait for worker");
    } finally {
      dashboard.dispose();
    }
  });

  it("keeps the selected run stable when newer activity reorders the run list", () => {
    const current = snapshot();
    const newest = current.runs[0]!;
    const older = structuredClone(newest);
    older.id = "run-older";
    older.name = "Older retained run";
    older.updatedAt -= 10_000;
    current.runs = [newest, older];
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("[");
      expect(dashboard.render(120).join("\n")).toContain("Older retained run");

      const later = structuredClone(newest);
      later.id = "run-later";
      later.name = "Later activity";
      current.runs = [later, newest, older];
      const afterRefresh = dashboard.render(120).join("\n");
      expect(afterRefresh).toContain("Older retained run");
      expect(afterRefresh).not.toContain("Fabric · Later activity");
    } finally {
      dashboard.dispose();
    }
  });

  it("keeps an open detail visible when its status leaves the current filter", () => {
    const current = snapshot();
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      dashboard.handleInput("f");
      dashboard.handleInput("\r");
      expect(dashboard.render(120).join("\n")).toContain("Review the migration");

      current.agents[0]!.status = "completed";
      const completedDetail = dashboard.render(120).join("\n");
      expect(completedDetail).toContain("Review the migration");
      expect(completedDetail).toContain("One-shot agent");
    } finally {
      dashboard.dispose();
    }
  });

  it("steers, follows up, and safely stops an agent from the overview", () => {
    const current = snapshot();
    const onAgentSteer = vi.fn();
    const onAgentFollowUp = vi.fn();
    const onAgentStop = vi.fn();
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
      { onAgentSteer, onAgentFollowUp, onAgentStop },
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      expect(dashboard.render(120).join("\n")).toContain("agent actions: s steer · u follow-up · x stop");

      dashboard.handleInput("s");
      expect(dashboard.render(120).join("\n")).toContain("steer now · security-reviewer");
      dashboard.handleInput("focus on auth checks");
      dashboard.handleInput("\r");
      expect(onAgentSteer).toHaveBeenCalledWith("agent-1", "focus on auth checks");

      dashboard.handleInput("\x1b");
      dashboard.handleInput("u");
      expect(dashboard.render(120).join("\n")).toContain("follow up after completion");
      dashboard.handleInput("summarize remaining risks");
      dashboard.handleInput("\r");
      expect(onAgentFollowUp).toHaveBeenCalledWith("agent-1", "summarize remaining risks");

      dashboard.handleInput("\x1b");
      dashboard.handleInput("x");
      expect(onAgentStop).not.toHaveBeenCalled();
      expect(dashboard.render(120).join("\n")).toContain("x again to stop");
      dashboard.handleInput("x");
      expect(onAgentStop).toHaveBeenCalledWith("agent-1");
    } finally {
      dashboard.dispose();
    }
  });

  it("opens contextual keyboard help", () => {
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      snapshot,
      vi.fn(),
    );
    try {
      dashboard.handleInput("?");
      const help = dashboard.render(100).join("\n");
      expect(help).toContain("Fabric dashboard help");
      expect(help).not.toContain("s steer now");
      expect(help).not.toContain("m model");
      dashboard.handleInput("\x1b");
      expect(dashboard.render(100).join("\n")).toContain("Repository migration");
    } finally {
      dashboard.dispose();
    }
  });

  it("shows completed-agent result summaries and activity-group metrics", () => {
    const current = snapshot();
    current.agents[0]!.status = "completed";
    current.agents[0]!.finishedAt = current.now;
    current.agents[0]!.text = "Found two concrete authentication gaps.";
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      dashboard.render(120);
      const overview = dashboard.render(120).join("\n");
      expect(overview).toContain("result: Found two concrete authentication gaps.");
      expect(overview).toContain("Agents (1)");
      expect(overview).toContain("5.2k tok");
    } finally {
      dashboard.dispose();
    }
  });

  it("advertises and opens actor controls directly from the overview", () => {
    const current = snapshot();
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
      { modelSource: actorModelSource, onActorModel: vi.fn(), onActorThinking: vi.fn() },
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("j");
      dashboard.handleInput("l");
      const overview = dashboard.render(120).join("\n");
      expect(overview).toContain("actor actions: m model · e thinking");

      dashboard.handleInput("m");
      expect(dashboard.render(120).join("\n")).toContain('Model for actor "advisor"');
    } finally {
      dashboard.dispose();
    }
  });

  it("opens a live transcript preview and toggles back to summary", () => {
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 28 } } as unknown as TUI,
      theme,
      snapshot,
      vi.fn(),
      {
        agentTranscript: () => ({
          truncated: true,
          entries: [
            { id: "message-1", kind: "assistant", label: "Agent", text: "## Live review\n\nReviewing the **event stream**.\n\n| Area | Status |\n| --- | --- |\n| Tail | Active |", status: "running" },
            { id: "tool-1", kind: "tool", label: "pi.read", text: "src/ui/dashboard.ts", status: "running" },
          ],
        }),
      },
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      expect(dashboard.render(120).join("\n")).toContain("space live transcript peek");
      dashboard.handleInput(" ");
      const transcript = dashboard.render(80).join("\n");
      expect(transcript).toContain("transcript · live");
      expect(transcript).toContain("earlier activity omitted");
      expect(transcript).toContain("Live review");
      expect(transcript).toContain("Reviewing the event stream");
      expect(transcript).toContain("Tail");
      expect(transcript).toContain("Active");
      expect(transcript).not.toContain("| --- | --- |");
      expect(transcript).toContain("pi.read · running · src/ui/dashboard.ts");
      expect(transcript.split("\n").filter((line) => line.includes("pi.read"))).toHaveLength(1);
      expect(transcript).toContain("G follow:on");

      dashboard.handleInput("k");
      expect(dashboard.render(80).join("\n")).toContain("G follow:on");
      dashboard.handleInput("G");
      expect(dashboard.render(80).join("\n")).toContain("G follow:on");
      dashboard.handleInput("t");
      expect(dashboard.render(80).join("\n")).toContain("Review the migration for security defects");
    } finally {
      dashboard.dispose();
    }
  });

  it("pauses only after real transcript scrolling and resumes at the growing tail", () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({
      id: `message-${index}`,
      kind: "assistant" as const,
      label: "Agent",
      text: `streamed update ${index}`,
      status: "completed" as const,
    }));
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 12 } } as unknown as TUI,
      theme,
      snapshot,
      vi.fn(),
      { agentTranscript: () => ({ entries, truncated: false }) },
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      dashboard.handleInput(" ");
      expect(dashboard.render(80).join("\n")).toContain("streamed update 29");

      dashboard.handleInput("k");
      const paused = dashboard.render(80).join("\n");
      expect(paused).toContain("G follow:off");
      entries.push({ id: "message-30", kind: "assistant", label: "Agent", text: "new tail update", status: "completed" });
      expect(dashboard.render(80).join("\n")).not.toContain("new tail update");

      dashboard.handleInput("G");
      const followed = dashboard.render(80).join("\n");
      expect(followed).toContain("G follow:on");
      expect(followed).toContain("new tail update");
    } finally {
      dashboard.dispose();
    }
  });

  it("includes error status in the failed filter", () => {
    const current = snapshot();
    current.agents[0]!.status = "error";
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("f");
      dashboard.handleInput("f");
      dashboard.handleInput("f");
      expect(dashboard.render(120).join("\n")).toContain("security-reviewer");
    } finally {
      dashboard.dispose();
    }
  });

  it("pins an inspected entity to its run and phase during live reordering", () => {
    const current = snapshot();
    const inspectedRun = current.runs[0]!;
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      dashboard.handleInput("\r");
      expect(dashboard.render(120).join("\n")).toContain("Review the migration for security defects");

      const { phaseId: _phaseId, ...unphasedAgent } = current.agents[0]!;
      current.agents.push({
        ...unphasedAgent,
        id: "agent-unphased",
        name: "new background agent",
      });
      const later = structuredClone(inspectedRun);
      later.id = "run-later-live";
      later.name = "Later live run";
      current.runs = [later, inspectedRun];

      const refreshed = dashboard.render(120).join("\n");
      expect(refreshed).toContain("Review the migration for security defects");
      expect(refreshed).not.toContain("Later live run");

      dashboard.handleInput("\x1b");
      const resumed = dashboard.render(120).join("\n");
      expect(resumed).toContain("Later live run");
    } finally {
      dashboard.dispose();
    }
  });

  it("keeps narrow detail and editor modes operable", () => {
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      snapshot,
      vi.fn(),
      {
        onAgentSteer: vi.fn(),
        agentTranscript: () => ({
          entries: [{ id: "narrow", kind: "assistant", label: "Agent", text: "narrow live transcript", status: "running" }],
          truncated: false,
        }),
      },
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      dashboard.handleInput("\r");
      const narrow = dashboard.render(20).join("\n");
      expect(narrow).toContain("migration for");
      expect(narrow).toContain("esc");
      dashboard.handleInput("t");
      expect(dashboard.render(20).join("\n")).toContain("narrow live");
      dashboard.handleInput("s");
      const editor = dashboard.render(20).join("\n");
      expect(editor).toContain("steer");
      expect(editor).toContain("esc cancel");
    } finally {
      dashboard.dispose();
    }
  });

  it("bounds dashboard height using the overlay terminal", () => {
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 12 } } as unknown as TUI,
      theme,
      snapshot,
      vi.fn(),
    );
    try {
      expect(dashboard.render(100).length).toBeLessThanOrEqual(12);
    } finally {
      dashboard.dispose();
    }
  });

  it("preserves CJK and emoji while wrapping by display width", () => {
    const value = "界界界界 🚀 mission";
    const lines = wrapPlainText(value, 4);
    expect(lines.every((line) => visibleWidth(line) <= 4)).toBe(true);
    expect(lines.join("").replaceAll(" ", "")).toBe(value.replaceAll(" ", ""));
    expect(wrapPlainText("界", 1)).toEqual(["…"]);
    expect(wrapPlainText("👩‍💻x", 2)).toEqual(["👩‍💻", "x"]);
  });

});

describe("Fabric dashboard global actors and instructions editor", () => {
  const baseSnapshot = (): FabricDashboardSnapshot => {
    const now = Date.now();
    return {
      now,
      runs: [],
      agents: [],
      actors: [
        {
          id: "actor-1",
          name: "advisor",
          status: "idle",
          runner: "pi",
          events: [],
          topics: [],
          delivery: "mailbox",
          responseMode: "text",
          triggerTurn: false,
          coalesce: true,
          queued: 0,
          messages: 0,
          createdAt: now,
          updatedAt: now,
          instructions: "Advise only when useful.",
          recentMessages: [],
        },
      ],
      globalActors: [
        {
          id: "g-actor-1",
          name: "global-reviewer",
          instructions: "You are a global reviewer template.",
          runner: "pi",
          events: ["turn_end"],
          topics: [],
          delivery: "mailbox",
          responseMode: "directive",
          triggerTurn: false,
          coalesce: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
      state: [],
      events: [],
    };
  };

  it("lists global templates and offers import/instructions/delete in their detail", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
    const onImportActor = vi.fn();
    const onGlobalInstructions = vi.fn();
    const onRemoveGlobalActor = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, baseSnapshot, vi.fn(), {
      onGlobalInstructions,
      onImportActor,
      onRemoveGlobalActor,
    });
    try {
      const overview = dashboard.render(120).join("\n");
      expect(overview).toContain("global-reviewer");
      expect(overview).toContain("global template");

      // Move from the project actor to the global template and open its detail.
      dashboard.handleInput("l");
      dashboard.handleInput("j");
      dashboard.handleInput("\r");
      const detail = dashboard.render(120).join("\n");
      expect(detail).toContain("Instructions");
      expect(detail).toContain("i instructions");
      expect(detail).toContain("p import");
      expect(detail).toContain("d delete");

      dashboard.handleInput("p");
      expect(onImportActor).toHaveBeenCalledWith("g-actor-1");
      dashboard.handleInput("d");
      expect(onRemoveGlobalActor).toHaveBeenCalledWith("g-actor-1");
    } finally {
      dashboard.dispose();
    }
  });

  it("exports a project actor and edits its instructions in the embedded editor", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
    const onActorInstructions = vi.fn();
    const onExportActor = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, baseSnapshot, vi.fn(), {
      onActorInstructions,
      onExportActor,
    });
    try {
      // Open the first entity, the project actor.
      dashboard.handleInput("l");
      dashboard.handleInput("\r");
      const detail = dashboard.render(120).join("\n");
      expect(detail).toContain("x export→global");
      expect(detail).toContain("i instructions");

      dashboard.handleInput("x");
      expect(onExportActor).toHaveBeenCalledWith("actor-1");

      // open the embedded instructions editor
      dashboard.handleInput("i");
      const editor = dashboard.render(120).join("\n");
      expect(editor).toContain("instructions · advisor");
      expect(editor).toContain("enter submit");

      // Enter submits the (unchanged) text to the actor callback and returns to detail
      dashboard.handleInput("\r");
      expect(onActorInstructions).toHaveBeenCalledWith("actor-1", "Advise only when useful.");
      const after = dashboard.render(120).join("\n");
      expect(after).toContain("advisor");
    } finally {
      dashboard.dispose();
    }
  });
});
