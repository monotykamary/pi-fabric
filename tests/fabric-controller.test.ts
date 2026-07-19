import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { FabricActivityRun } from "../src/activity/types.js";
import type { FabricState } from "../src/fabric-state.js";
import { FabricUiController } from "../src/ui/controller.js";
import type { FabricDashboard } from "../src/ui/dashboard.js";

const theme = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
} as unknown as Theme;

const stubActor = {
  id: "actor-1",
  name: "advisor",
  status: "idle",
  events: ["turn_end"],
  topics: [],
  delivery: "mailbox",
  responseMode: "text",
  triggerTurn: false,
  coalesce: true,
  queued: 0,
  messages: 0,
  createdAt: 0,
  updatedAt: 0,
};

const stubState = () =>
  ({
    initialized: true,
    config: {
      ui: { enabled: true, refreshMs: 60_000, eventHistory: 80, widget: "hidden" },
      mesh: { enabled: false },
    },
    activity: { subscribe: vi.fn(() => () => {}), runs: vi.fn(() => []), reset: vi.fn() },
    mainAgentInfo: vi.fn(() => ({
      id: "session:test",
      name: "Main",
      kind: "main",
      status: "idle",
      runner: "pi",
      transport: "host",
      cwd: "/tmp/project",
      sessionId: "test",
      startedAt: 1,
      updatedAt: 1,
      pendingMessages: false,
      local: true,
    })),
    queueUserMessage: vi.fn().mockResolvedValue({
      queued: true,
      messageId: "message-1",
      routed: "main",
    }),
    subagents: { list: vi.fn(() => []), subscribeUi: vi.fn(() => () => {}) },
    actors: {
      list: vi.fn(() => [stubActor]),
      messages: vi.fn(() => []),
      instructions: vi.fn(() => "Advise only when useful."),
      setModel: vi.fn().mockResolvedValue(undefined),
      setThinking: vi.fn().mockResolvedValue(undefined),
      setEvents: vi.fn().mockResolvedValue(undefined),
      setInstructions: vi.fn().mockResolvedValue(undefined),
      clearMessages: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(() => () => {}),
    },
    globalActors: {
      list: vi.fn(() => []),
      resolve: vi.fn(() => undefined),
      create: vi.fn(() => ({ id: "g1", name: "x", createdAt: 0, updatedAt: 0 })),
      update: vi.fn(() => ({ id: "g1", name: "x", createdAt: 0, updatedAt: 0 })),
      remove: vi.fn(() => ({ removed: true })),
      toRequest: vi.fn(() => ({ name: "x", instructions: "y" })),
    },
    mesh: { read: vi.fn(() => []), latestOffset: vi.fn(() => 0), list: vi.fn(() => []) },
    widgetDismissedAt: 0,
  }) as unknown as FabricState;

describe("FabricUiController dashboard wiring", () => {
  it("passes every actor callback to the dashboard so all pickers are available", async () => {
    const state = stubState();
    const controller = new FabricUiController(state);
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    let dashboard: FabricDashboard | undefined;
    const context = {
      mode: "tui",
      modelRegistry: { getAvailable: () => [] },
      ui: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        custom: vi.fn(async (factory: any) => {
          dashboard = factory(tui, theme, {}, () => {}) as FabricDashboard;
        }),
        notify: vi.fn(),
        setWidget: vi.fn(),
      },
    } as unknown as ExtensionContext;

    try {
      await controller.openDashboard(context);
      expect(dashboard).toBeDefined();
      // Enter the entities pane and open the actor detail.
      dashboard!.handleInput("l");
      dashboard!.handleInput("\r");
      const detail = dashboard!.render(120).join("\n");
      expect(detail).toContain("advisor");
      // Each hint is gated on its callback being wired by the controller;
      // this guards against regressions like the thinking picker being omitted.
      expect(detail).toContain("m model");
      expect(detail).toContain("e thinking");
      expect(detail).toContain("v events");
      expect(detail).toContain("c clear");
    } finally {
      dashboard?.dispose();
      controller.stop();
    }
  });

  it("routes Main dashboard messages through FabricState", async () => {
    const state = stubState();
    const controller = new FabricUiController(state);
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    let dashboard: FabricDashboard | undefined;
    const context = {
      mode: "tui",
      modelRegistry: { getAvailable: () => [] },
      ui: {
        custom: vi.fn(async (factory: (
          tui: TUI,
          theme: Theme,
          keybindings: unknown,
          done: () => void,
        ) => FabricDashboard) => {
          dashboard = factory(tui, theme, {}, () => {});
        }),
        notify: vi.fn(),
        setWidget: vi.fn(),
      },
    } as unknown as ExtensionContext;

    try {
      await controller.openDashboard(context);
      dashboard!.handleInput("l");
      dashboard!.handleInput("g");
      dashboard!.handleInput("s");
      dashboard!.handleInput("focus on the failing test");
      dashboard!.handleInput("\r");
      expect(state.queueUserMessage).toHaveBeenCalledWith(
        "session:test",
        "focus on the failing test",
        "steer",
      );
    } finally {
      dashboard?.dispose();
      controller.stop();
    }
  });

  it("does not refresh settled sessions on an idle timer", async () => {
    vi.useFakeTimers();
    const state = stubState();
    state.config.ui.refreshMs = 100;
    vi.mocked(state.actors.list).mockReturnValue([]);
    const settledRun: FabricActivityRun = {
      id: "settled-run",
      name: "Large settled run",
      status: "completed",
      phases: [],
      calls: Array.from({ length: 1_000 }, (_, index) => ({
        id: `call-${index}`,
        ref: "pi.read",
        label: "pi.read",
        kind: "tool",
        status: "completed",
        startedAt: index,
        updatedAt: index,
        finishedAt: index,
      })),
      items: [],
      events: [],
      startedAt: 0,
      updatedAt: 1_000,
      finishedAt: 1_000,
    };
    vi.mocked(state.activity.runs).mockReturnValue([settledRun]);
    const context = {
      mode: "tui",
      ui: { setWidget: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const controller = new FabricUiController(state);
    try {
      controller.start(context);
      expect(state.activity.runs).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(state.activity.runs).toHaveBeenCalledTimes(1);
    } finally {
      controller.stop();
      vi.useRealTimers();
    }
  });

  it("wakes settled UI state when actors or detached agents change", async () => {
    vi.useFakeTimers();
    const state = stubState();
    state.config.ui.refreshMs = 500;
    let onActor = (): void => {};
    let onSubagent = (): void => {};
    vi.mocked(state.actors.subscribe).mockImplementation((listener) => {
      onActor = listener;
      return () => {};
    });
    vi.mocked(state.subagents.subscribeUi).mockImplementation((listener) => {
      onSubagent = listener;
      return () => {};
    });
    const context = {
      mode: "tui",
      ui: { setWidget: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const controller = new FabricUiController(state);
    try {
      controller.start(context);
      expect(state.activity.runs).toHaveBeenCalledTimes(1);
      onActor();
      await vi.advanceTimersByTimeAsync(100);
      expect(state.activity.runs).toHaveBeenCalledTimes(2);
      onSubagent();
      await vi.advanceTimersByTimeAsync(100);
      expect(state.activity.runs).toHaveBeenCalledTimes(3);
    } finally {
      controller.stop();
      vi.useRealTimers();
    }
  });

  it("coalesces bursty activity updates into a 10 Hz refresh", async () => {
    vi.useFakeTimers();
    const state = stubState();
    state.config.ui.refreshMs = 500;
    let onActivity = (): void => {};
    vi.mocked(state.activity.subscribe).mockImplementation((listener) => {
      onActivity = listener;
      return () => {};
    });
    const context = {
      mode: "tui",
      ui: { setWidget: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const controller = new FabricUiController(state);
    try {
      controller.start(context);
      expect(state.activity.runs).toHaveBeenCalledTimes(1);
      for (let index = 0; index < 25; index++) onActivity();
      await vi.advanceTimersByTimeAsync(99);
      expect(state.activity.runs).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.activity.runs).toHaveBeenCalledTimes(2);
    } finally {
      controller.stop();
      vi.useRealTimers();
    }
  });

  it("surfaces dashboard refresh failures while retaining the last snapshot", async () => {
    const state = stubState();
    vi.mocked(state.activity.runs).mockImplementation(() => {
      throw new Error("corrupt activity state");
    });
    const notify = vi.fn();
    const context = {
      mode: "tui",
      modelRegistry: { getAvailable: () => [] },
      ui: {
        custom: vi.fn(async () => undefined),
        notify,
        setWidget: vi.fn(),
      },
    } as unknown as ExtensionContext;
    const controller = new FabricUiController(state);
    try {
      await controller.openDashboard(context);
      expect(notify).toHaveBeenCalledWith(
        "Fabric dashboard refresh failed: corrupt activity state",
        "warning",
      );
    } finally {
      controller.stop();
    }
  });
});
