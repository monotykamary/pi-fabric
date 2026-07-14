import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
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
    subagents: { list: vi.fn(() => []) },
    actors: {
      list: vi.fn(() => [stubActor]),
      messages: vi.fn(() => []),
      setModel: vi.fn().mockResolvedValue(undefined),
      setThinking: vi.fn().mockResolvedValue(undefined),
      setEvents: vi.fn().mockResolvedValue(undefined),
      clearMessages: vi.fn().mockResolvedValue(undefined),
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
});
