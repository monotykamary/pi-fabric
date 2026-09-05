import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  FabricConversationState,
  FabricConversationView,
  type FabricConversationDelivery,
  type FabricConversationOptions,
  type FabricConversationTarget,
} from "../src/ui/conversation.js";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { nativeTranscript, userMessage, assistantMessage } from "./fixtures/native-conversation.js";
initTheme("dark", false);

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const deferred = (): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const makeTargets = (): FabricConversationTarget[] => [
  {
    id: "main",
    name: "Main",
    kind: "main",
    status: "running",
    canSteer: true,
    canFollowUp: true,
    canStop: false,
  },
  {
    id: "a",
    name: "Agent A",
    kind: "agent",
    parentId: "main",
    status: "running",
    canSteer: true,
    canFollowUp: true,
    canStop: true,
    cwd: "/tmp/a",
  },
  {
    id: "b",
    name: "Agent B",
    kind: "agent",
    parentId: "main",
    status: "completed",
    canSteer: false,
    canFollowUp: false,
    canStop: false,
    readOnlyReason: "one-shot completed",
  },
  {
    id: "child",
    name: "Nested",
    kind: "agent",
    parentId: "a",
    status: "running",
    canSteer: true,
    canFollowUp: true,
    canStop: true,
  },
];

const transcriptFor = (id: string) => nativeTranscript([
  userMessage(`hello from ${id}`),
  { ...assistantMessage(""), content: [{ type: "toolCall", id: `${id}:t1`, name: "bash", arguments: { command: "ls" } }] },
  { role: "toolResult", toolCallId: `${id}:t1`, toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 },
  assistantMessage(`reply for ${id}`, 4),
]);

interface Harness {
  view: FabricConversationView;
  state: FabricConversationState;
  send: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  loadOlder: ReturnType<typeof vi.fn>;
  loadNewer: ReturnType<typeof vi.fn>;
  loadLatest: ReturnType<typeof vi.fn>;
  tui: TUI;
  keybindings: Pick<KeybindingsManager, "matches" | "getKeys">;
}

interface HarnessOverrides {
  targets?: () => FabricConversationTarget[];
  initialTargetId?: string;
  send?: (id: string, message: string, delivery: FabricConversationDelivery) => Promise<unknown>;
  keybindings?: Harness["keybindings"];
  rows?: number;
  transcript?: FabricConversationOptions["transcript"];
}

const makeHarness = (overrides: HarnessOverrides = {}): Harness => {
  const state = new FabricConversationState();
  const tui = {
    requestRender: vi.fn(),
    terminal: { rows: overrides.rows ?? 40 },
  } as unknown as TUI;
  const keybindings: Harness["keybindings"] = overrides.keybindings ?? {
    matches: () => false,
    getKeys: () => [],
  };
  const send = vi.fn(overrides.send ?? (async () => undefined));
  const options: FabricConversationOptions = {
    targets: overrides.targets ?? makeTargets,
    initialTargetId: overrides.initialTargetId ?? "a",
    state,
    transcript: overrides.transcript ?? ((id) => transcriptFor(id)),
    loadOlder: vi.fn(() => true),
    loadNewer: vi.fn(() => true),
    loadLatest: vi.fn(() => true),
    send,
    stop: vi.fn(async () => undefined),
    close: vi.fn(),
    keybindings,
  };
  const view = new FabricConversationView(tui, theme, options);
  return {
    view,
    state,
    send: options.send as Harness["send"],
    stop: options.stop as Harness["stop"],
    close: options.close as Harness["close"],
    loadOlder: options.loadOlder as Harness["loadOlder"],
    loadNewer: options.loadNewer as Harness["loadNewer"],
    loadLatest: options.loadLatest as Harness["loadLatest"],
    tui,
    keybindings,
  };
};

const renderText = (view: FabricConversationView, width = 80): string =>
  view.render(width).join("\n");

const type = (view: FabricConversationView, text: string): void => {
  for (const char of text) view.handleInput(char);
};

describe("FabricConversationView", () => {
  it("keeps native queue rows until an actual new user message is observed", async () => {
    let messages = [userMessage("repeat", 1)];
    const h = makeHarness({ transcript: () => nativeTranscript(messages) });
    type(h.view, "repeat");
    h.view.handleInput("\r");
    await flush();
    expect(h.state.peek("a")?.draft).toBe("");
    expect(renderText(h.view)).toContain("Steering: repeat");
    h.view.selectTarget("child");
    expect(renderText(h.view)).not.toContain("Steering: repeat");
    h.view.selectTarget("a");
    expect(renderText(h.view)).toContain("Steering: repeat");
    messages = [...messages, userMessage("repeat", 2)];
    expect(renderText(h.view)).not.toContain("Steering: repeat");
    expect(h.state.queues.get("a")?.rows()).toEqual([]);
    h.view.dispose();
  });

  it("routes sends to the selected target only and renders only its transcript", async () => {
    const h = makeHarness({ initialTargetId: "a" });
    type(h.view, "do the thing");
    h.view.handleInput("\r");
    await flush();
    expect(h.send).toHaveBeenCalledWith("a", "do the thing", "steer");
    const text = renderText(h.view);
    expect(text).toContain("reply for a");
    expect(text).not.toContain("reply for b");
    expect(h.state.selectedId).toBe("a");
  });

  it("explicit initialTargetId overrides state.selectedId", () => {
    const h = makeHarness({ initialTargetId: "a" });
    h.state.selectedId = "a";
    const view = new FabricConversationView(
      h.tui,
      theme,
      {
        targets: makeTargets,
        initialTargetId: "b",
        state: h.state,
        transcript: (id) => transcriptFor(id),
        loadOlder: () => true,
        loadNewer: () => true,
        loadLatest: () => true,
        send: async () => undefined,
        stop: async () => undefined,
        close: () => {},
      },
    );
    expect(h.state.selectedId).toBe("b");
    expect(view.selectTarget.length).toBe(1);
  });

  it("keeps a pending send pinned across navigation and clears only the accepted draft", async () => {
    const gate = deferred();
    const h = makeHarness({ initialTargetId: "a", send: () => gate.promise });
    type(h.view, "hello a");
    h.view.handleInput("\r");
    await flush();
    expect(h.send).toHaveBeenCalledWith("a", "hello a", "steer");
    // Draft retained (raw) until the owner acknowledges.
    expect(h.state.peek("a")?.draft).toBe("hello a");
    h.view.selectTarget("b");
    gate.resolve();
    await flush();
    expect(h.state.peek("a")?.draft).toBe("");
    expect(h.state.peek("b")?.draft).toBe("");
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("does not clear a newer edited draft when the original send resolves", async () => {
    const gate = deferred();
    const h = makeHarness({ initialTargetId: "a", send: () => gate.promise });
    type(h.view, "hello");
    h.view.handleInput("\r");
    type(h.view, "!");
    gate.resolve();
    await flush();
    expect(h.state.peek("a")?.draft).toBe("hello!");
    expect(h.view.render(80).join("\n")).toContain("hello!");
  });

  it("retains the raw draft on failed send and shows error feedback without closing", async () => {
    const gate = deferred();
    const h = makeHarness({ initialTargetId: "a", send: () => gate.promise });
    type(h.view, " spaced draft ");
    h.view.handleInput("\r");
    gate.reject(new Error("boom"));
    await flush();
    expect(h.state.peek("a")?.draft).toBe(" spaced draft ");
    const text = renderText(h.view);
    expect(text).toContain(" spaced draft ");
    expect(text).toContain("Send failed for Agent A (steer): boom");
    expect(h.close).not.toHaveBeenCalled();
  });

  it("restores per-target drafts when switching and reopening", () => {
    const h = makeHarness({ initialTargetId: "a" });
    type(h.view, "draft a");
    h.view.selectTarget("b");
    type(h.view, "draft b");
    h.view.selectTarget("a");
    expect(h.view.render(80).join("\n")).toContain("draft a");
    h.view.selectTarget("b");
    expect(h.view.render(80).join("\n")).toContain("draft b");
  });

  it("terminal completion disables sending without closing the viewer", async () => {
    const h = makeHarness({ initialTargetId: "b" });
    type(h.view, "late message");
    h.view.handleInput("\r");
    await flush();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    const text = renderText(h.view);
    expect(text).toContain("read-only: one-shot completed");
    expect(text).toContain("late message");
  });

  it("navigates nested hierarchy with ctrl+shift+arrows and closes to main", () => {
    const h = makeHarness({ initialTargetId: "a" });
    h.view.handleInput("\x1b[1;6C");
    expect(h.state.selectedId).toBe("child");
    h.view.handleInput("\x1b[1;6D");
    expect(h.state.selectedId).toBe("a");
    h.view.handleInput("\x1b[1;6D");
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("cycles non-main targets with ctrl+tab and shift+ctrl+tab", () => {
    const h = makeHarness({ initialTargetId: "a" });
    h.view.handleInput("\x1b[9;5u");
    expect(h.state.selectedId).toBe("b");
    h.view.handleInput("\x1b[9;6u");
    expect(h.state.selectedId).toBe("a");
  });

  it("pages older and newer via callbacks and follows latest on End", () => {
    const h = makeHarness({ initialTargetId: "a", keybindings: {
      matches: (data, action) => (action === "tui.altScreen.previousPrompt" && data === "\x1b[1;5A") || (action === "tui.altScreen.nextPrompt" && data === "\x1b[1;5B"),
      getKeys: () => [],
    } });
    h.view.handleInput("\x1b[1;5A");
    expect(h.loadOlder).toHaveBeenCalledWith("a");
    renderText(h.view);
    h.view.handleInput("\x1b[1;5B");
    expect(h.loadNewer).toHaveBeenCalledWith("a");
    h.view.handleInput("\x1b[F");
    expect(h.loadLatest).toHaveBeenCalledWith("a");
    h.view.handleInput("\x1b[5~");
    renderText(h.view);
    h.view.handleInput("\x1b[6~");
    expect(h.loadNewer).toHaveBeenCalledTimes(2);
  });

  it("selecting Main returns to the native session without stopping anything", () => {
    const h = makeHarness({ initialTargetId: "a" });
    h.view.selectTarget("main");
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.stop).not.toHaveBeenCalled();
  });

  it("picker lists Main and nested descendants; searching and selecting Main closes", () => {
    const h = makeHarness({ initialTargetId: "child" });
    h.view.handleInput("\x0e");
    const text = renderText(h.view);
    expect(text).toContain("Main (native session)");
    expect(text).toContain("Agent A");
    expect(text).toContain("Nested");
    // Search for Main, then confirm to return to the native session.
    type(h.view, "main");
    h.view.handleInput("\r");
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("shows unread markers from target.updatedAt without mutating state", () => {
    const targets = makeTargets();
    targets[2]!.updatedAt = 9_999;
    const h = makeHarness({ initialTargetId: "a", targets: () => targets });
    h.view.handleInput("\x0e");
    expect(renderText(h.view)).toContain("●");
    expect(h.state.peek("b")?.lastSeenUpdatedAt ?? 0).toBeLessThan(9_999);
  });

  it("escape closes the view without stopping any agent", () => {
    const h = makeHarness({ initialTargetId: "a" });
    h.view.handleInput("\x1b");
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.stop).not.toHaveBeenCalled();
  });

  it("/stop confirms then stops only the selected non-main target", async () => {
    const h = makeHarness({ initialTargetId: "a" });
    type(h.view, "/stop");
    h.view.handleInput("\r");
    expect(h.stop).not.toHaveBeenCalled();
    expect(renderText(h.view)).toContain("enter again to stop Agent A");
    h.view.handleInput("\r");
    await flush();
    expect(h.stop).toHaveBeenCalledWith("a");
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.close).not.toHaveBeenCalled();
  });

  it("escape cancels a pending /stop confirmation", () => {
    const h = makeHarness({ initialTargetId: "a" });
    type(h.view, "/stop");
    h.view.handleInput("\r");
    h.view.handleInput("\x1b");
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
  });

  it("never sends unsupported slash or shell commands to the target", async () => {
    const h = makeHarness({ initialTargetId: "a" });
    for (const command of ["/model", "!rm -rf /"]) {
      type(h.view, command);
      h.view.handleInput("\r");
      await flush();
      expect(h.send).not.toHaveBeenCalled();
      expect(h.close).not.toHaveBeenCalled();
      expect(renderText(h.view)).toContain("Unsupported command");
      expect(h.state.peek("a")?.draft).toBe(command);
      // Reset draft for the next iteration.
      h.view.handleInput("\x03");
    }
  });

  it("sends follow-up delivery through the injected app.message.followUp binding", async () => {
    const h = makeHarness({
      initialTargetId: "a",
      keybindings: {
        matches: (data, binding) => binding === "app.message.followUp" && data === "\x1b\x12",
        getKeys: (binding) => (binding === "app.message.followUp" ? ["alt+enter"] : []),
      },
    });
    type(h.view, "queued later");
    h.view.handleInput("\x1b\x12");
    await flush();
    expect(h.send).toHaveBeenCalledWith("a", "queued later", "followUp");
  });

  it("reports unbound configured bindings and does not fall back", () => {
    const h = makeHarness({ initialTargetId: "a" });
    type(h.view, "hi");
    h.view.handleInput("\x11");
    expect(h.send).not.toHaveBeenCalled();
    expect(renderText(h.view)).toContain("unbound");
  });

  it("expands tool previews with the native configured tools expand key", () => {
    const h = makeHarness({
      initialTargetId: "a",
      keybindings: {
        matches: (data, binding) => binding === "app.tools.expand" && data === "\x0f",
        getKeys: (binding) => (binding === "app.tools.expand" ? ["ctrl+o"] : []),
      },
    });
    const before = renderText(h.view);
    expect(before).not.toContain("input:");
    h.view.handleInput("\x0f");
    const after = renderText(h.view);
    expect(after).toContain("bash");
    expect(after).not.toContain("input:");
    expect(h.state.peek("a")?.toolsExpanded).toBe(true);
  });

  it("ctrl+c clears the composer draft instead of stopping anything", () => {
    const h = makeHarness({ initialTargetId: "a" });
    type(h.view, "scratch");
    h.view.handleInput("\x03");
    expect(h.state.peek("a")?.draft).toBe("");
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
  });

  it("propagates focus to the editor (IME cursor marker) immediately", () => {
    const h = makeHarness({ initialTargetId: "a" });
    const marker = "\x1b_pi:c\x07";
    expect(renderText(h.view)).toContain(marker);
    h.view.focused = false;
    expect(renderText(h.view)).not.toContain(marker);
    h.view.focused = true;
    expect(renderText(h.view)).toContain(marker);
  });

  it("close+reopen before ack blocks duplicate send and success clears the old draft", async () => {
    const gate = deferred();
    const h = makeHarness({ initialTargetId: "a", send: () => gate.promise });
    type(h.view, "hello a");
    h.view.handleInput("\r");
    await flush();
    expect(h.send).toHaveBeenCalledTimes(1);
    h.view.dispose();
    const reopened = new FabricConversationView(h.tui, theme, {
      targets: makeTargets,
      initialTargetId: "a",
      state: h.state,
      transcript: (id) => transcriptFor(id),
      loadOlder: () => true,
      loadNewer: () => true,
      loadLatest: () => true,
      send: h.send as unknown as FabricConversationOptions["send"],
      stop: async () => undefined,
      close: h.close as unknown as () => void,
    });
    // The new view reconciles editor text from the shared session draft.
    expect(renderText(reopened)).toContain("hello a");
    reopened.handleInput("\r");
    await flush();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.state.hasPendingSend("a", "hello a")).toBe(true);
    gate.resolve();
    await flush();
    expect(h.state.peek("a")?.draft).toBe("");
    expect(h.state.hasPendingSend("a", "hello a")).toBe(false);
    expect(renderText(reopened)).toContain("Steering: hello a");
    expect(h.state.queues.get("a")?.rows()).toEqual([expect.objectContaining({ text: "hello a", state: "dispatched" })]);
  });

  it("session clear before ack invalidates the in-flight send", async () => {
    const gate = deferred();
    const h = makeHarness({ initialTargetId: "a", send: () => gate.promise });
    type(h.view, "gone");
    h.view.handleInput("\r");
    h.state.clear();
    gate.resolve();
    await flush();
    expect(h.state.peek("a")).toBeUndefined();
    expect(h.state.hasPendingSend("a", "gone")).toBe(false);
  });

  it("constrains every line to terminal width and total to terminal rows", () => {
    const h = makeHarness({ initialTargetId: "a", rows: 40 });
    type(h.view, "wide draft that must wrap inside the editor budget");
    for (const width of [80, 30, 12]) {
      const lines = h.view.render(width);
      expect(lines.length).toBeLessThanOrEqual(40);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("prioritizes editor content and breadcrumb at tiny heights", () => {
    const h = makeHarness({ initialTargetId: "a", rows: 4 });
    type(h.view, "tiny");
    const lines = h.view.render(80);
    expect(lines.length).toBeLessThanOrEqual(4);
    const text = lines.join("\n");
    expect(text).toContain("tiny");
    expect(text).toContain("Main");
  });
});
