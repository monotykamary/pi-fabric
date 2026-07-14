import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { FabricDashboard } from "../src/ui/dashboard.js";
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
        coalesce: true,
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

  const openActorDetail = (dashboard: FabricDashboard): void => {
    // Phases pane: move from the auto-selected "audit" phase to the session panel.
    dashboard.handleInput("j");
    // Switch to the entities pane and select the actor (index 1, after the
    // unlinked agent), then open its detail.
    dashboard.handleInput("l");
    dashboard.handleInput("j");
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
});
