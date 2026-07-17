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

  it("keeps completed runs until settle, then dismisses but retains actors", () => {
    const current = snapshot();
    const run = current.runs[0];
    if (!run) throw new Error("missing fixture run");
    run.status = "completed";
    run.finishedAt = current.now - 20_000;
    current.agents[0]!.status = "completed";
    current.state = [];
    current.actors = [];
    // a completed run stays visible until the turn settles
    expect(shouldShowFabricWidget(current, "auto")).toBe(true);
    // settling (agent_settled) dismisses it
    current.widgetDismissedAt = current.now;
    expect(shouldShowFabricWidget(current, "auto")).toBe(false);
    // ambient actors keep the widget visible regardless
    current.actors = snapshot().actors;
    expect(shouldShowFabricWidget(current, "auto")).toBe(true);
    const lines = new FabricWidget(theme, () => current, 5).render(72);
    expect(lines[0]).toContain("Fabric session");
    expect(lines.join("\n")).toContain("advisor");
  });

  it("keeps a bounded terminal agent result cue until settle", () => {
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

  it("hides dismissed runs and resurfaces later ones", () => {
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
    // a freshly-finished run shows as a single-line summary
    expect(shouldShowFabricWidget(current, "auto")).toBe(true);
    const lines = new FabricWidget(theme, () => current, 8).render(72);
    expect(lines.length).toBe(1);
    // a new prompt dismisses the run (it finished before the prompt) -> hidden
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

  it("compacts widget rows as agents complete without blank padding", () => {
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
    expect(second.length).toBe(2); // header + alpha
    expect(second.join("\n")).toContain("alpha");
    expect(second.every((line) => visibleWidth(line) > 0)).toBe(true);

    current.agents[0]!.status = "completed";
    const third = widget.render(72);
    expect(third.length).toBe(1); // header only
    expect(visibleWidth(third[0]!)).toBeGreaterThan(0);
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

  it("renders a responsive two-pane dashboard and agent details", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn());
    try {
      const overview = dashboard.render(120);
      const overviewText = overview.join("\n");
      expect(overviewText).toContain("Activity");
      expect(overviewText).toContain("Audit");
      expect(overviewText).toContain("security-reviewer");
      expect(overviewText).toContain("claude-opus-4-8");
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

  const openActorDetail = (dashboard: FabricDashboard): void => {
    // Activity pane: move from the auto-selected "audit" phase to session state.
    dashboard.handleInput("j");
    // The run-owned agent stays in its phase, so the actor is the first session entity.
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
  it("shows active and completed run-owned work in an Run activity panel", () => {
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
      expect(dashboard.render(120).join("\n")).toContain("Run activity");
      dashboard.handleInput("l");
      const all = dashboard.render(120).join("\n");
      expect(all).toContain("background-active");
      expect(all).toContain("background-done");
      expect(all).toMatch(/Run activity\s+1\/2/);

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
      dashboard.handleInput("l");
      const overview = dashboard.render(120).join("\n");
      expect(overview).toContain("result: Found two concrete authentication gaps.");
      expect(overview).toContain("1 agent");
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
      dashboard.handleInput("l");
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

      // entities pane → down to the global template → open its detail
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
      // entities pane → open the project actor detail (entity index 0)
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
