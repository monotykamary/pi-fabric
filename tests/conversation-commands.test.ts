import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, type TUI, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FabricConversationState, FabricConversationView, type FabricConversationTarget } from "../src/ui/conversation.js";
import { conversationAssistantText, conversationCommandCompletion, CONVERSATION_COMMANDS } from "../src/ui/conversation-commands.js";
import { FabricConversationTranscriptRenderer } from "../src/ui/conversation-render.js";
import { nativeTranscript, assistantMessage, userMessage } from "./fixtures/native-conversation.js";

initTheme("dark", false);
const theme = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value,
  bold: (value: string) => value } as unknown as Theme;
const views: FabricConversationView[] = [];
afterEach(() => { for (const view of views.splice(0)) view.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); });
const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
function harness(mode: "regular" | "fullscreen" = "regular", outputPad: 0 | 1 = 1) {
  const state = new FabricConversationState();
  const targets: FabricConversationTarget[] = ["a", "b"].map((id) => ({ id, name: id, kind: "agent", status: "completed",
    canSteer: false, canFollowUp: false, canStop: false, readOnlyReason: "finished" }));
  let transcript = nativeTranscript([userMessage("user text"), assistantMessage("**child response**")]);
  const copy = vi.fn(async (_text: string) => {});
  const send = vi.fn();
  const close = vi.fn();
  const latest = vi.fn(() => false);
  const stop = vi.fn(async (_id: string) => {});
  const terminal = { rows: 25, columns: 100, write: vi.fn() };
  const tui = { mode, terminal, requestRender: vi.fn() } as unknown as TUI;
  const view = new FabricConversationView(tui, theme, {
    state, targets: () => targets, initialTargetId: "a", transcript: () => transcript,
    loadOlder: () => false, loadNewer: () => false, loadLatest: latest, send, stop, close,
    copyToClipboard: copy, appearance: { editorPaddingX: 0, outputPad, copyOnSelect: false },
  });
  views.push(view);
  const render = () => view.render(100).map(stripTerminalSequences);
  const type = (text: string) => { state.view(state.selectedId!).draft = text; render(); };
  const command = (text: string) => { type(text); view.handleInput("\r"); };
  return { view, state, targets, copy, send, stop, close, tui, terminal, render, type, command, latest,
    setTranscript: (next: typeof transcript) => { transcript = next; } };
}

describe("preview-local commands", () => {
  it.each(CONVERSATION_COMMANDS)("remembers $value before its local action", async ({ value }) => {
    const h = harness();
    h.command(value);
    await tick();
    expect(h.state.view("a").promptHistory?.at(-1)).toBe(value);
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each([100, 24, 12])("reserves copy-result geometry before the clipboard settles at width %i", async (width) => {
    const h = harness();
    h.setTranscript(nativeTranscript([
      userMessage(Array.from({ length: 100 }, (_, i) => `history ${i}`).join("\n")),
      assistantMessage("child response"),
    ]));
    let resolve!: () => void;
    h.copy.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    h.render();
    h.view.handleInput("/co");
    await vi.waitFor(() => expect(h.render().join("\n")).toContain("/copy selection"));
    h.view.handleInput("\r");
    const frame = () => h.view.render(width).map(stripTerminalSequences);
    const pending = frame();
    expect(pending.join("\n")).toContain("Copying…");
    const scroll = h.state.view("a").scroll;
    const border = pending.findIndex((line) => /^─+$/.test(line));
    await tick();
    expect(frame()).toEqual(pending);
    resolve();
    await tick();
    const done = frame();
    expect(h.state.view("a").scroll).toBe(scroll);
    expect(done.findIndex((line) => /^─+$/.test(line))).toBe(border);
    const notice = pending.findIndex((line) => line.includes("Copying…"));
    expect(done.slice(0, notice)).toEqual(pending.slice(0, notice));
    expect(done.join("\n")).toContain("Copied");
    expect(done.join("\n")).not.toContain("Copying…");
    expect(h.state.view("a").draft).toBe("");
  });

  it("keeps reserved copy geometry stable across a pending resize", async () => {
    const h = harness();
    h.setTranscript(nativeTranscript([
      userMessage(Array.from({ length: 100 }, (_, i) => `history ${i}`).join("\n")), assistantMessage("response"),
    ]));
    let resolve!: () => void;
    h.copy.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    h.command("/copy");
    h.render();
    await tick();
    h.terminal.columns = 18;
    h.terminal.rows = 18;
    const pending = h.view.render(18).map(stripTerminalSequences);
    const scroll = h.state.view("a").scroll;
    resolve();
    await tick();
    const done = h.view.render(18).map(stripTerminalSequences);
    const notice = pending.findIndex((line) => line.includes("Copying…"));
    expect(done.slice(0, notice)).toEqual(pending.slice(0, notice));
    expect(h.state.view("a").scroll).toBe(scroll);
    expect(done).toHaveLength(18);
    expect(done.every((line) => visibleWidth(line) <= 18)).toBe(true);
  });

  it("does not leave pending slash feedback after a shortcut supersedes it", async () => {
    const h = harness();
    let resolve!: () => void;
    h.copy.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    h.command("/copy");
    await tick();
    h.view.handleInput("\x1b[99;6u");
    resolve();
    await tick();
    expect(h.copy).toHaveBeenCalledTimes(2);
    expect(h.render().join("\n")).not.toContain("Copying…");
    h.view.handleInput("x");
    expect(h.render().join("\n")).not.toContain("Copied last");
  });

  it("does not re-anchor history when copy settles after the user scrolls", async () => {
    const h = harness();
    h.setTranscript(nativeTranscript([
      userMessage(Array.from({ length: 100 }, (_, i) => `history ${i}`).join("\n")), assistantMessage("response"),
    ]));
    let resolve!: () => void;
    h.copy.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    h.command("/copy");
    h.render();
    await tick();
    h.view.handleMouse({ type: "wheel", button: "none", wheelDelta: -12, x: 1, y: 1, screenX: 1, screenY: 1,
      width: 100, height: 25, shift: false, ctrl: false, alt: false });
    h.render();
    const scroll = h.state.view("a").scroll;
    resolve();
    await tick();
    expect(h.render().join("\n")).not.toContain("Copied last");
    expect(h.state.view("a").scroll).toBe(scroll);
    expect(h.state.view("a").following).toBe(false);
  });

  it("still performs the requested copy when a newer command arrives before its microtask", async () => {
    const h = harness();
    h.command("/copy");
    h.command("/help");
    await tick();
    expect(h.copy).toHaveBeenCalledWith("**child response**");
    expect(h.render().join("\n")).toContain("Commands: /copy");
    expect(h.render().join("\n")).not.toContain("Copied last");
  });

  it("does not let a pending copy replace a newer slash notification", async () => {
    const h = harness();
    let resolve!: () => void;
    h.copy.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    h.command("/copy");
    await tick();
    h.command("/help");
    const frame = h.render();
    resolve();
    await tick();
    expect(h.render()).toEqual(frame);
    expect(h.render().join("\n")).toContain("Commands: /copy");
  });

  it.each(["regular", "fullscreen"] as const)("renders persistent slash results like Pi status messages (%s)", async (mode) => {
    const h = harness(mode);
    h.command("/copy");
    await tick();
    const expected = new Text(theme.fg("dim", "Copied last assistant response"), 1, 0).render(100);
    const frame = h.view.render(100);
    const index = frame.indexOf(expected[0]!);
    expect(index).toBeGreaterThan(h.render().findIndex((line) => line.includes("child response")));
    expect(frame.slice(index - 1, index + expected.length)).toEqual(["", ...expected]);
    expect(index).toBeLessThan(h.render().findIndex((line) => /^─+$/.test(line)));
    h.view.handleInput("new draft");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    expect(h.render().join("\n")).toContain("Copied last assistant response");
    expect(h.state.view("a").draft).toBe("new draft");
    h.command("/help");
    expect(h.render().join("\n")).not.toContain("Copied last assistant response");
    h.view.selectTarget("b");
    expect(h.render().join("\n")).not.toContain("Commands: /copy");
    h.view.selectTarget("a");
    expect(h.render().join("\n")).not.toContain("Commands: /copy");
  });

  it("wraps errors using Pi's output padding, without an expiring header", () => {
    const h = harness("regular", 0);
    h.command("/copy selection");
    const expected = new Text(theme.fg("error", "Error: No transcript text selected. Drag to select first."), 0, 0).render(35);
    const frame = h.view.render(35);
    const index = frame.indexOf(expected[0]!);
    expect(index).toBeGreaterThan(1);
    expect(frame.slice(index - 1, index + expected.length)).toEqual(["", ...expected]);
    expect(frame.every((line) => visibleWidth(line) <= 35)).toBe(true);
    h.view.handleInput("x");
    expect(h.render().join("\n")).toContain("Error: No transcript text selected");
    expect(h.copy).not.toHaveBeenCalled();
  });

  it("uses native dim/error colors and keeps tiny terminal frames bounded", async () => {
    const fg = vi.spyOn(theme, "fg");
    const h = harness();
    h.command("/copy");
    await tick();
    expect(fg).toHaveBeenCalledWith("dim", "Copied last assistant response");
    h.command("/copy selection");
    expect(fg).toHaveBeenCalledWith("error", "Error: No transcript text selected. Drag to select first.");
    h.command("/help");
    for (const rows of [2, 8, 25]) {
      h.terminal.rows = rows;
      for (const width of [1, 12, 35, 100]) {
        const frame = h.view.render(width);
        expect(frame).toHaveLength(rows);
        expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    }
  });

  it("slices a large retained history instead of copying it to append notices", async () => {
    let reads = 0;
    const rows = Array.from({ length: 100_000 }, (_, i) => `history ${i}`);
    const history = new Proxy(rows, { get(target, key, receiver) {
      if (key === Symbol.iterator) throw new Error("notification copied full history");
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    } });
    vi.spyOn(FabricConversationTranscriptRenderer.prototype, "render").mockReturnValue(history);
    const h = harness();
    h.command("/copy");
    await tick();
    reads = 0;
    expect(h.render().join("\n")).toContain("Copied last assistant response");
    expect(reads).toBeLessThanOrEqual(40);
    expect(rows).toHaveLength(100_000);
    h.view.handleMouse({ type: "wheel", button: "none", wheelDelta: -20, x: 1, y: 1, screenX: 1, screenY: 1,
      width: 100, height: 25, shift: false, ctrl: false, alt: false });
    expect(h.render().join("\n")).not.toContain("Copied last assistant response");
  });

  it("lets scrolling win over a command notice before its first paint", () => {
    const h = harness();
    h.setTranscript(nativeTranscript([userMessage(Array.from({ length: 100 }, (_, i) => `history ${i}`).join("\n"))]));
    h.state.view("a").following = false;
    h.state.view("a").scroll = 20;
    h.command("/help");
    h.view.handleMouse({ type: "wheel", button: "none", wheelDelta: -3, x: 1, y: 1, screenX: 1, screenY: 1,
      width: 100, height: 25, shift: false, ctrl: false, alt: false });
    h.render();
    expect(h.state.view("a").scroll).toBe(17);
  });

  it("clears displayed notices on session reset without modifying model history", async () => {
    const h = harness();
    const transcript = nativeTranscript([assistantMessage("child response")]);
    const original = JSON.stringify(transcript);
    h.setTranscript(transcript);
    h.command("/copy");
    await tick();
    expect(h.render().join("\n")).toContain("Copied last assistant response");
    expect(JSON.stringify(transcript)).toBe(original);
    h.state.clear();
    expect(h.render().join("\n")).not.toContain("Copied last assistant response");
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each(["picker", "session", "dispose"])("drops late copy results after %s", async (action) => {
    const h = harness();
    let resolve!: () => void;
    h.copy.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    h.command("/copy");
    await tick();
    if (action === "picker") { h.command("/agents"); h.view.handleInput("\x1b"); }
    if (action === "session") h.state.clear();
    if (action === "dispose") h.view.dispose();
    const renders = vi.mocked(h.tui.requestRender).mock.calls.length;
    resolve();
    await tick();
    expect(vi.mocked(h.tui.requestRender)).toHaveBeenCalledTimes(renders);
    expect(h.render().join("\n")).not.toContain("Copied last assistant response");
  });

  it("reports stop success and failure without changing its confirmation safety", async () => {
    const h = harness();
    h.targets[0]!.canStop = true;
    h.command("/stop");
    h.view.handleInput("x");
    expect(h.render().join("\n")).not.toContain("Press enter again");
    expect(h.stop).not.toHaveBeenCalled();
    h.command("/stop");
    h.view.handleInput("\r");
    await tick();
    expect(h.render().some((line) => line.startsWith(" Stop requested for a"))).toBe(true);
    h.stop.mockRejectedValueOnce(new Error("backend unavailable"));
    h.command("/stop");
    h.view.handleInput("\r");
    await tick();
    expect(h.render().some((line) => line.startsWith(" Error: Stop failed for a: backend unavailable"))).toBe(true);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("keeps shortcut feedback out of the slash notification block", async () => {
    const h = harness();
    h.view.handleInput("\x1b[99;6u");
    await tick();
    expect(h.copy).toHaveBeenCalledTimes(1);
    h.view.handleInput("x");
    expect(h.render().join("\n")).not.toContain("Copied last");
  });

  it("shows slash results on an older page without reading newer history", () => {
    const h = harness();
    h.setTranscript(nativeTranscript([userMessage(Array.from({ length: 100 }, (_, i) => `history ${i}`).join("\n"))], { hasNewer: true }));
    h.state.view("a").following = false;
    h.state.view("a").scroll = 0;
    h.command("/copy");
    const frame = h.render();
    const index = frame.findIndex((line) => line.includes("Error: Use /latest before /copy"));
    expect(index).toBeGreaterThan(1);
    expect(frame.slice(index - 1, index)).toEqual([""]);
    expect(h.latest).not.toHaveBeenCalled();
    expect(h.state.view("a").following).toBe(false);
    expect(h.copy).not.toHaveBeenCalled();
    h.command("/latest");
    expect(h.render().join("\n")).toContain("Following latest output");
  });

  it("renders stop confirmation/cancellation and rejects stale stop results", async () => {
    const h = harness();
    h.targets[0]!.canStop = true;
    h.command("/stop");
    expect(h.render().some((line) => line.startsWith(" Press enter again to stop a"))).toBe(true);
    h.view.handleInput("\x1b");
    expect(h.render().some((line) => line.startsWith(" Stop cancelled"))).toBe(true);
    expect(h.stop).not.toHaveBeenCalled();
    let resolve!: () => void;
    h.stop.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    h.command("/stop");
    h.view.handleInput("\r");
    await tick();
    h.view.selectTarget("b");
    h.view.selectTarget("a");
    resolve();
    await tick();
    expect(h.render().join("\n")).not.toContain("Stop requested");
  });

  it("copies only the selected participant's assistant text, even read-only", async () => {
    const h = harness();
    h.command("/copy");
    await tick();
    expect(h.copy).toHaveBeenCalledWith("**child response**");
    expect(h.send).not.toHaveBeenCalled();
    expect(h.state.view("a").draft).toBe("");
    expect(h.render().join("\n")).toContain("Copied last assistant response");
  });

  it("keeps clipboard failures and newer drafts intact", async () => {
    const h = harness();
    h.copy.mockRejectedValueOnce(new Error("clipboard unavailable"));
    h.command("/copy");
    await tick();
    expect(h.state.view("a").draft).toBe("/copy");
    expect(h.render().join("\n")).toContain("Copy failed: clipboard unavailable");
    let resolve!: () => void;
    h.copy.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    h.command("/copy");
    await tick();
    h.type("new draft");
    resolve();
    await tick();
    expect(h.state.view("a").draft).toBe("new draft");
  });

  it("serializes clipboard writes so the latest requested copy wins", async () => {
    const h = harness();
    let resolve!: () => void;
    h.copy.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    h.command("/copy");
    await tick();
    h.setTranscript(nativeTranscript([assistantMessage("newer response")]));
    h.command("/copy");
    await tick();
    expect(h.copy).toHaveBeenCalledTimes(1);
    resolve();
    await tick();
    expect(h.copy).toHaveBeenCalledTimes(2);
    expect(h.copy).toHaveBeenLastCalledWith("newer response");
  });

  it("does not apply stale copy feedback after switching targets or closing", async () => {
    const h = harness();
    let resolve!: () => void;
    h.copy.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    h.command("/copy");
    await tick();
    h.view.selectTarget("b");
    h.view.selectTarget("a");
    resolve();
    await tick();
    expect(h.render().join("\n")).not.toContain("Copied last");
    h.view.dispose();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("does not call an old response latest when a newer page is unloaded", async () => {
    const h = harness();
    h.setTranscript(nativeTranscript([assistantMessage("old response")], { hasNewer: true }));
    h.command("/copy");
    await tick();
    expect(h.copy).not.toHaveBeenCalled();
    expect(h.render().join("\n")).toContain("Use /latest before /copy");
    h.command("/latest");
    expect(h.latest).toHaveBeenCalledWith("a");
    expect(h.state.view("a").following).toBe(true);
  });

  it("keeps help, unsupported commands and queued command edits local", async () => {
    const h = harness();
    h.command("/help");
    expect(h.render().join("\n")).toContain("Commands: /copy [selection]");
    for (const command of ["/model", "/copy all", "!pwd"]) {
      h.command(command);
      expect(h.render().join("\n")).toContain("Unsupported command");
    }
    await expect(h.state.queues.get("a")!.dispatch("/model", "steer")).rejects.toThrow("Control input");
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each(["regular", "fullscreen"] as const)("selects ANSI-free child text and protects the draft (%s)", async (mode) => {
    const h = harness(mode);
    const lines = h.render();
    const y = lines.findIndex((line) => line.includes("child response"));
    const x = lines[y]!.indexOf("child response");
    h.view.handleInput(`\x1b[<0;${x + 1};${y + 1}M`);
    h.view.handleInput(`\x1b[<32;${x + 6};${y + 1}M`);
    h.view.handleInput(`\x1b[<0;${x + 6};${y + 1}m`);
    h.type("untouched draft");
    h.view.handleInput("\x03");
    await tick();
    expect(h.copy).toHaveBeenCalledWith("child");
    expect(h.state.view("a").draft).toBe("untouched draft");
    h.setTranscript(nativeTranscript([assistantMessage("changed while selected")]));
    expect(h.render().join("\n")).toContain("child response");
    h.view.handleInput("\x1b");
    expect(h.close).not.toHaveBeenCalled();
    expect(h.render().join("\n")).toContain("changed while selected");
    h.view.handleInput("\x1b");
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("supports explicit selection copy and clears selection on resize and target changes", async () => {
    const h = harness();
    const frame = h.render();
    const y = frame.findIndex((line) => line.includes("child response"));
    const x = frame[y]!.indexOf("child response");
    h.view.handleInput(`\x1b[<0;${x + 1};${y + 1}M`);
    h.view.handleInput(`\x1b[<0;${x + 6};${y + 1}m`);
    h.command("/copy selection");
    await tick();
    expect(h.copy).toHaveBeenCalledWith("child");
    h.view.render(90);
    h.command("/copy selection");
    await tick();
    expect(h.copy).toHaveBeenCalledTimes(1);
    expect(h.render().join("\n")).toContain("No transcript text selected");
    h.view.selectTarget("b");
    h.command("/copy selection");
    expect(h.render().join("\n")).toContain("No transcript text selected");
    h.view.dispose();
    expect(h.tui.terminal.write).toHaveBeenCalledWith("\x1b[?1002l\x1b[?1000l\x1b[?1006l");
  });

  it("reports an empty assistant response without calling the clipboard", async () => {
    const h = harness();
    h.setTranscript(nativeTranscript([userMessage("only a user message")]));
    h.command("/copy");
    await tick();
    expect(h.copy).not.toHaveBeenCalled();
    expect(h.render().join("\n")).toContain("No assistant response to copy");
  });

  it("rejects commands introduced by editing an already queued message", async () => {
    const h = harness();
    h.targets[0]!.status = "running";
    h.targets[0]!.canSteer = true;
    delete h.targets[0]!.readOnlyReason;
    h.render();
    const queue = h.state.queues.get("a")!;
    expect(queue.stage("ordinary queued message", "steer").ok).toBe(true);
    h.view.handleInput("\x1b[1;3A");
    expect(queue.editingActive).toBe(true);
    h.view.handleInput("\x15");
    h.view.handleInput("/copy");
    h.view.handleInput("\r");
    expect(queue.editingActive).toBe(false);
    expect(queue.render(100).join("\n")).toContain("/copy");
    expect(await queue.submit("steer")).toBe(false);
    expect(queue.render(100).join("\n")).toContain("/copy");
    expect(h.send).not.toHaveBeenCalled();
    expect(h.copy).not.toHaveBeenCalled();
  });

  it("has a bounded command-only completion provider", async () => {
    const provider = conversationCommandCompletion(() => true);
    const options = { signal: new AbortController().signal };
    const suggestions = await provider.getSuggestions(["/co"], 0, 3, options);
    expect(suggestions?.items.map((item) => item.value)).toEqual(["/copy", "/copy selection"]);
    expect(provider.applyCompletion(["/co"], 0, 3, suggestions!.items[0]!, "/co").lines).toEqual(["/copy "]);
    expect(await provider.getSuggestions(["/model"], 0, 6, options)).toBeNull();
    expect(await provider.getSuggestions(["src/"], 0, 4, options)).toBeNull();
    expect(await conversationCommandCompletion(() => false).getSuggestions(["/"], 0, 1, options)).toBeNull();
    expect(CONVERSATION_COMMANDS).toHaveLength(7);
  });

  it("matches native assistant-only copy semantics without exposing thinking or tools", () => {
    const message = { ...assistantMessage(""), content: [
      { type: "thinking" as const, thinking: "private reasoning" }, { type: "text" as const, text: "answer" },
    ] };
    expect(conversationAssistantText(nativeTranscript([message, { ...assistantMessage(""), stopReason: "aborted", content: [] }]))).toBe("answer");
    expect(conversationAssistantText(nativeTranscript([{ ...assistantMessage(""), content: [{ type: "toolCall", id: "x", name: "bash", arguments: {} }] }]))).toBeUndefined();
  });
});
