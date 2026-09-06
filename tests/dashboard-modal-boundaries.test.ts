import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { FabricDashboard } from "../src/ui/dashboard.js";
import type { FabricDashboardSnapshot } from "../src/ui/types.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const snapshot = (): FabricDashboardSnapshot => ({
  now: 1000,
  main: {
    id: "session:main", name: "Main", kind: "main", status: "idle", runner: "pi",
    transport: "host", cwd: "/tmp/project", sessionId: "main", startedAt: 0,
    updatedAt: 1000, pendingMessages: false, local: true,
  },
  peers: [], runs: [], agents: [], state: [], events: [],
  componentGraph: { components: [], edges: [], cycles: [] },
  actors: [{
    id: "actor-1", scope: "project", name: "advisor", status: "idle", runner: "pi",
    events: [], topics: [], delivery: "mailbox", responseMode: "text", triggerTurn: false,
    coalesce: true, queued: 0, messages: 0, createdAt: 0, updatedAt: 1000,
    instructions: "Original persona", recentMessages: [],
  }],
  globalActors: [{
    id: "global-1", name: "template", runner: "pi", instructions: "Template persona",
    events: [], topics: [], delivery: "mailbox", responseMode: "text", triggerTurn: false,
    coalesce: true, createdAt: 0, updatedAt: 1000,
  }],
});

const setup = () => {
  const onActorInstructions = vi.fn();
  const onGlobalInstructions = vi.fn();
  const onTargetMessage = vi.fn();
  const done = vi.fn();
  const tui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
  const dashboard = new FabricDashboard(tui, theme, snapshot, done, {
    onActorInstructions, onGlobalInstructions, onTargetMessage,
    onActorModel: vi.fn(), onActorThinking: vi.fn(), onActorEvents: vi.fn(),
    onActorTools: vi.fn(), onActorDeliveryPolicy: vi.fn(),
    modelSource: { models: [], lastUsed: {} },
  });
  dashboard.handleInput("l");
  return { dashboard, done, onActorInstructions, onGlobalInstructions, onTargetMessage };
};

const text = (dashboard: FabricDashboard) => dashboard.render(120).join("\n");

describe("dashboard modal/navigation boundary", () => {
  it.each(["m", "e", "y", "v", "o", "i", "s"])(
    "keeps modal %s rows bounded and retains the narrow fallback",
    (key) => {
      const { dashboard } = setup();
      try {
        dashboard.handleInput("\r");
        dashboard.handleInput(key);
        const label = key === "i" ? "instructions · advisor" : key === "s" ? "steer · advisor" : "actor · advisor";
        expect(dashboard.render(23)).toEqual([label, "esc cancel"]);
        for (const width of [0, 1, 12, 23, 24, 40, 120]) {
          expect(dashboard.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
        }
      } finally { dashboard.dispose(); }
    },
  );

  it("does not leak editor commands into help or dashboard close; cancel restores detail", () => {
    const { dashboard, done, onActorInstructions } = setup();
    try {
      dashboard.handleInput("\r");
      const before = text(dashboard);
      dashboard.handleInput("i");
      dashboard.handleInput("?");
      expect(text(dashboard)).toContain("instructions · advisor");
      dashboard.handleInput("\x03");
      expect(text(dashboard)).toBe(before);
      expect(onActorInstructions).not.toHaveBeenCalled();
      expect(done).not.toHaveBeenCalled();
    } finally { dashboard.dispose(); }
  });

  it.each([false, true])("returns to the pinned message detail (opened from detail=%s) on cancel and submit", (detail) => {
    const { dashboard, onTargetMessage, done } = setup();
    try {
      dashboard.handleInput("\r");
      const before = text(dashboard);
      if (!detail) dashboard.handleInput("\x1b");
      dashboard.handleInput("s");
      dashboard.handleInput("\x1b");
      expect(text(dashboard)).toBe(before);
      dashboard.handleInput("s");
      dashboard.handleInput("hello");
      dashboard.handleInput("\r");
      expect(onTargetMessage).toHaveBeenCalledExactlyOnceWith(
        { id: "actor-1", name: "advisor", kind: "actor" }, "hello", "steer",
      );
      expect(text(dashboard)).toBe(before);
      expect(done).not.toHaveBeenCalled();
    } finally { dashboard.dispose(); }
  });

  it("routes template instructions without calling the live actor callback", () => {
    const { dashboard, onActorInstructions, onGlobalInstructions } = setup();
    try {
      dashboard.handleInput("j");
      dashboard.handleInput("\r");
      const before = text(dashboard);
      dashboard.handleInput("i");
      expect(text(dashboard)).toContain("instructions · template");
      dashboard.handleInput("\r");
      expect(onGlobalInstructions).toHaveBeenCalledExactlyOnceWith("global-1", "Template persona");
      expect(onActorInstructions).not.toHaveBeenCalled();
      expect(text(dashboard)).toBe(before);
    } finally { dashboard.dispose(); }
  });
});
