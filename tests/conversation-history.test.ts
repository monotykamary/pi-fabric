import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FabricConversationState, FabricConversationView, type FabricConversationTarget } from "../src/ui/conversation.js";
import * as historyHelpers from "../src/ui/conversation-history.js";
import { nativeTranscript, userMessage, assistantMessage } from "./fixtures/native-conversation.js";

initTheme("dark", false);
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text,
  bold: (text: string) => text } as unknown as Theme;
const views: FabricConversationView[] = [];
const originalBindings = getKeybindings();
afterEach(() => { for (const view of views.splice(0)) view.dispose(); vi.restoreAllMocks(); setKeybindings(originalBindings); });
const tick = async () => { await new Promise((done) => setTimeout(done, 0)); };
const up = "\x1b[A", down = "\x1b[B";
function harness(state = new FabricConversationState(), mode: "regular" | "fullscreen" = "regular") {
  const targets: FabricConversationTarget[] = ["a", "b"].map((id) => ({ id, name: id, kind: "actor", status: "idle",
    canSteer: true, canFollowUp: true, canStop: false }));
  const transcript = vi.fn((id: string) => nativeTranscript([userMessage(`seed ${id}`), assistantMessage(`answer ${id}`)]));
  const send = vi.fn(async (_id: string, _text: string, _lane: string) => {});
  const tui = { mode, terminal: { rows: 30, columns: 80, write: vi.fn() }, requestRender: vi.fn() } as unknown as TUI;
  const view = new FabricConversationView(tui, theme, { state, initialTargetId: "a", targets: () => targets, transcript,
    send, stop: vi.fn(), close: vi.fn(), loadOlder: vi.fn(() => false), loadNewer: vi.fn(() => false), loadLatest: vi.fn(() => false),
    copyToClipboard: vi.fn(async () => {}), appearance: { editorPaddingX: 0, outputPad: 1 } });
  views.push(view);
  const render = (width = 80) => view.render(width);
  const input = (data: string) => { view.handleInput(data); render(); };
  const draft = () => state.view(state.selectedId!).draft;
  const type = (text: string) => { state.view(state.selectedId!).draft = text; render(); };
  const submit = async (text: string, delivery = "\r") => { type(text); input(delivery); await tick(); render(); };
  render();
  return { view, state, targets, transcript, send, render, input, draft, type, submit };
}

describe("preview native prompt history", () => {
  it("keeps slash history session-local, target-scoped and absent from transcripts", async () => {
    const h = harness();
    const transcript = nativeTranscript([userMessage("seed a"), assistantMessage("answer a")]);
    const original = JSON.stringify(transcript);
    h.transcript.mockImplementation((id) => id === "a" ? transcript : nativeTranscript([userMessage("seed b")]));
    await h.submit("/help");
    await h.submit(" /copy ");
    await h.submit("/copy");
    expect(h.state.view("a").promptHistory).toEqual(["seed a", "/help", "/copy"]);
    expect(JSON.stringify(transcript)).toBe(original);
    expect(h.send).not.toHaveBeenCalled();
    h.view.selectTarget("b");
    h.render();
    h.input(up);
    expect(h.draft()).toBe("seed b");
    h.view.selectTarget("a");
    h.type("");
    h.view.dispose();
    const reopened = harness(h.state);
    reopened.input(up);
    expect(reopened.draft()).toBe("/copy");
    reopened.input(up);
    expect(reopened.draft()).toBe("/help");
    reopened.state.clear();
    reopened.input(up);
    expect(reopened.state.view("a").draft).toBe("seed a");
    expect(JSON.stringify(transcript)).toBe(original);
  });

  it("bounds ephemeral slash history using the same native limit and deduplication", () => {
    const h = harness();
    for (let i = 0; i < 110; i++) { h.type(`/unknown-${i}`); h.input("\r"); }
    h.input("\r");
    expect(h.state.view("a").promptHistory).toEqual(Array.from({ length: 100 }, (_, i) => `/unknown-${i + 10}`));
    expect(h.send).not.toHaveBeenCalled();
  });

  it("seeds only the newest 100 user texts and unwraps direct actor payloads", () => {
    const transcript = nativeTranscript(Array.from({ length: 150 }, (_, i) => userMessage(`prompt ${i}`)));
    expect(historyHelpers.conversationPromptHistory(transcript)).toEqual(Array.from({ length: 100 }, (_, i) => `prompt ${i + 50}`));
    const messages = nativeTranscript([
      userMessage("  first  "), userMessage("first"), assistantMessage("not a user prompt"),
      { ...userMessage(""), role: "user", content: [{ type: "text", text: "second " }, { type: "image", data: "ignored", mimeType: "image/png" }, { type: "text", text: "prompt" }] },
      userMessage('Fabric actor message from direct: {"source":"direct","payload":{"message":"human text"}}'),
      userMessage("first"),
    ]);
    expect(historyHelpers.conversationPromptHistory(messages)).toEqual(["first", "second prompt", "human text", "first"]);
    const history: string[] = [];
    for (let i = 0; i < 150; i++) historyHelpers.appendConversationPrompt(history, `prompt ${i}`);
    historyHelpers.appendConversationPrompt(history, " prompt 149 ");
    historyHelpers.appendConversationPrompt(history, " ");
    expect(history).toHaveLength(100);
    expect(history[0]).toBe("prompt 50");
  });

  it("does no history extraction on ordinary rendering/typing and seeds once on demand", () => {
    const seed = vi.spyOn(historyHelpers, "conversationPromptHistory");
    const h = harness();
    for (let i = 0; i < 8; i++) h.input("x");
    expect(seed).not.toHaveBeenCalled();
    h.input(up);
    h.input(up);
    h.input(down);
    h.render();
    expect(seed).toHaveBeenCalledTimes(1);
  });

  it("honors dedicated native history bindings without changing global bindings", () => {
    const bindings = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.editor.historyPrevious": "ctrl+alt+p", "tui.editor.historyNext": "ctrl+alt+n",
    });
    setKeybindings(bindings);
    const h = harness();
    h.type("draft at end");
    h.input("\x1b[112;7u");
    expect(h.draft()).toBe("seed a");
    h.input("\x1b[110;7u");
    expect(h.draft()).toBe("draft at end");
    h.input("!");
    expect(h.draft()).toBe("draft at end!");
    expect(getKeybindings()).toBe(bindings);
  });

  it("lets slash completion own up/down before prompt history", async () => {
    const h = harness();
    h.input("/co");
    await vi.waitFor(() => expect(h.render().join("\n")).toContain("/copy selection"));
    h.input(down);
    h.input(up);
    expect(h.draft()).toBe("/co");
    expect(h.state.view("a").promptHistory).toBeUndefined();
    h.input("\x1b");
    h.type("");
    h.input(up);
    expect(h.draft()).toBe("seed a");
  });

  it("remembers accepted parked follow-ups without dispatching them", () => {
    const h = harness();
    const queue = h.state.queues.get("a")!;
    // Exercise the view's extension-mode parking branch with the real queue.
    vi.spyOn(queue, "mode", "get").mockReturnValue("extension");
    h.type("park for later");
    h.input("\x1b\r");
    expect(h.draft()).toBe("");
    expect(h.send).not.toHaveBeenCalled();
    h.input(up);
    expect(h.draft()).toBe("park for later");
  });

  it("sends and recalls expanded pasted content rather than stale paste markers", async () => {
    const h = harness();
    const text = Array.from({ length: 25 }, (_, i) => `pasted line ${i}`).join("\n");
    h.input(`\x1b[200~${text}\x1b[201~`);
    h.input("\r");
    await tick();
    expect(h.send).toHaveBeenCalledWith("a", text, "steer");
    h.input(up);
    expect(h.draft()).toBe(text);
  });

  it("retains history across a pending send without erasing a newer draft", async () => {
    const h = harness();
    let resolve!: () => void;
    h.send.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    await h.submit("pending prompt");
    h.input("\x03");
    h.input("newer draft");
    resolve();
    await tick();
    h.render();
    expect(h.draft()).toBe("newer draft");
    h.input(up);
    h.input(up);
    expect(h.draft()).toBe("pending prompt");
    h.input(down);
    expect(h.draft()).toBe("newer draft");
  });

  it.each(["regular", "fullscreen"] as const)("recalls loaded user prompts and restores the draft (%s)", (mode) => {
    const h = harness(undefined, mode);
    h.type("unfinished draft");
    h.input(up); // Native Up first moves to the start of a nonempty first line.
    expect(h.draft()).toBe("unfinished draft");
    h.input(up);
    expect(h.draft()).toBe("seed a");
    h.input(down);
    expect(h.draft()).toBe("unfinished draft");
    h.input("!");
    expect(h.draft()).toBe("!unfinished draft"); // Restores the cursor as well.
    expect(h.send).not.toHaveBeenCalled();
  });

  it("interleaves prompt attempts and ephemeral slash commands in submission order", async () => {
    const h = harness();
    await h.submit("  first  ");
    await h.submit("second", "\x1b\r");
    await h.submit("second");
    await h.submit("/help");
    h.input(up);
    expect(h.draft()).toBe("/help");
    h.input(up);
    expect(h.draft()).toBe("second");
    h.input(up);
    expect(h.draft()).toBe("first");
    h.input(up);
    expect(h.draft()).toBe("seed a");
    expect(h.send.mock.calls.map((call) => call[2])).toEqual(["steer", "followUp", "steer"]);
  });

  it("keeps target histories isolated across switches and reopening", async () => {
    const h = harness();
    await h.submit("only a");
    h.view.selectTarget("b");
    h.render();
    h.input(up);
    expect(h.draft()).toBe("seed b");
    h.type("");
    await h.submit("only b");
    h.view.selectTarget("a");
    h.render();
    h.input(up);
    expect(h.draft()).toBe("only a");
    h.type("");
    h.view.dispose();
    const reopened = harness(h.state);
    reopened.input(up);
    expect(reopened.draft()).toBe("only a");
    reopened.input(up);
    expect(reopened.draft()).toBe("seed a");
  });

  it("remembers failed slash attempts but not shell or read-only messages", async () => {
    const h = harness();
    h.targets[0]!.readOnlyReason = "finished";
    await h.submit("rejected text");
    await h.submit("/model");
    await h.submit("!pwd");
    h.type("");
    h.input(up);
    expect(h.draft()).toBe("/model");
    h.input(up);
    expect(h.draft()).toBe("seed a");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("keeps attempted-send history and the exact draft on a send failure", async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(new Error("offline"));
    await h.submit("retry this");
    expect(h.draft()).toBe("retry this");
    h.type("");
    h.input(up);
    expect(h.draft()).toBe("retry this");
  });

  it("resets native editor history with the parent session", async () => {
    const h = harness();
    await h.submit("old private draft");
    h.state.clear();
    h.transcript.mockImplementation(() => nativeTranscript([userMessage("new session seed")]));
    h.input(up); // Reset must also work before the next render/observation.
    expect(h.state.view("a").draft).toBe("new session seed");
    h.input(up);
    expect(h.state.view("a").draft).toBe("new session seed");
  });

  it("does not clear a queued-row editor when a matching composer send settles", async () => {
    const h = harness();
    let resolve!: () => void;
    h.send.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    await h.submit("matching text");
    const queue = h.state.queues.get("a")!;
    queue.stage("matching text", "steer");
    h.input("\x1b[1;3A");
    resolve();
    await tick();
    const frame = h.render().map(stripTerminalSequences);
    const border = frame.findIndex((line) => /^─+$/.test(line));
    expect(frame.slice(border + 1).join("\n")).toContain("matching text");
    h.input("\x1b");
    expect(h.draft()).toBe("");
    h.input(up);
    expect(h.draft()).toBe("matching text");
  });

  it("keeps queue-row arrows history-free and restores composer history after rollback", async () => {
    const h = harness();
    await h.submit("old composer prompt");
    h.type("unfinished composer");
    const queue = h.state.queues.get("a")!;
    expect(queue.stage("queued first\nqueued second", "steer").ok).toBe(true);
    h.input("\x1b[1;3A");
    expect(queue.editingActive).toBe(true);
    for (let i = 0; i < 4; i++) h.input(up);
    expect(h.render().join("\n")).toContain("queued first");
    const frame = h.render().map(stripTerminalSequences);
    const border = frame.findIndex((line) => /^─+$/.test(line));
    expect(frame.slice(border + 1).join("\n")).not.toContain("old composer prompt");
    h.input("\x1b");
    expect(h.draft()).toBe("unfinished composer");
    h.input(up);
    h.input(up);
    expect(h.draft()).toBe("old composer prompt");
    h.input(down);
    expect(h.draft()).toBe("unfinished composer");
  });

  it("leaves wrapped multiline cursor movement to Pi", () => {
    const h = harness();
    h.type("first line\nsecond line that wraps across the small editor");
    h.render(22);
    for (let i = 0; i < 3; i++) { h.view.handleInput(up); h.render(22); }
    expect(h.draft()).toBe("first line\nsecond line that wraps across the small editor");
    for (let i = 0; i < 5; i++) { h.view.handleInput(up); h.render(22); }
    expect(h.draft()).toBe("seed a");
  });
});
