import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { DashboardModalController, type DashboardModalContent } from "../src/ui/dashboard-modal-controller.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const setup = () => {
  const requestRender = vi.fn();
  const tui = { requestRender, terminal: { rows: 40 } } as unknown as TUI;
  return { modal: new DashboardModalController(tui, theme), requestRender };
};
const frame = (width: number, content: DashboardModalContent) => [
  content.title, content.narrowTitle, content.hint, ...content.render(width),
];
const target = { id: "agent-1", name: "reviewer", kind: "agent" as const };

describe("DashboardModalController", () => {
  it("does not capture input, render, or request redraws without a modal", () => {
    const { modal, requestRender } = setup();
    expect(modal.handleInput("j")).toBe(false);
    expect(modal.render(80, frame)).toBeUndefined();
    expect(requestRender).not.toHaveBeenCalled();
  });

  it.each(["model", "thinking", "delivery", "events", "tools"] as const)(
    "focuses and forwards input to the %s picker, including cancel",
    (kind) => {
      const { modal, requestRender } = setup();
      const onClose = vi.fn();
      const child = { focused: false, handleInput: vi.fn(), render: vi.fn(() => ["choices"]) };
      modal.openPicker(kind, "advisor", (close) => {
        child.handleInput.mockImplementation((data: string) => { if (data === "\x1b") close(); });
        return child;
      }, onClose);
      expect(child.focused).toBe(true);
      const rendered = modal.render(80, frame)!;
      expect(rendered.slice(0, 3)).toEqual([
        `actor · advisor · ${kind}`,
        "actor · advisor",
        `  Enter to select · Esc to cancel${kind === "model" ? " · type to filter" : ""}`,
      ]);
      expect(child.render).toHaveBeenCalledWith(80);
      expect(modal.handleInput("?")).toBe(true);
      expect(modal.handleInput("\x1b")).toBe(true);
      expect(child.handleInput.mock.calls).toEqual([["?"], ["\x1b"]]);
      expect(onClose).toHaveBeenCalledOnce();
      expect(requestRender).toHaveBeenCalledTimes(2);
      expect(modal.handleInput("j")).toBe(false);
      expect(modal.render(80, frame)).toBeUndefined();
    },
  );

  it("keeps blank messages open, trims sent messages and consumes submit exactly once", () => {
    const { modal, requestRender } = setup();
    const submit = vi.fn();
    const close = vi.fn();
    modal.openMessage(target, "steer", submit, close);
    modal.handleInput("   ");
    expect(modal.handleInput("\r")).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    modal.handleInput("review this  ");
    expect(modal.handleInput("\r")).toBe(true);
    expect(submit).toHaveBeenCalledExactlyOnceWith("review this");
    expect(close).toHaveBeenCalledOnce();
    expect(requestRender).toHaveBeenCalledTimes(4);
    expect(modal.handleInput("\r")).toBe(false);
  });

  it.each(["", "  preserve whitespace  ", "first\nsecond"])(
    "preserves native Editor instruction submission (including empty text): %j",
    (text) => {
      const { modal } = setup();
      const submit = vi.fn();
      const close = vi.fn();
      modal.openInstructions("advisor", text, submit, close);
      expect(modal.render(80, frame)!.slice(0, 3)).toEqual([
        "instructions · advisor", "instructions · advisor",
        "  enter submit · shift+enter newline · esc cancel",
      ]);
      expect(modal.handleInput("\r")).toBe(true);
      expect(submit).toHaveBeenCalledExactlyOnceWith(text.trim());
      expect(close).toHaveBeenCalledOnce();
      expect(modal.render(80, frame)).toBeUndefined();
    },
  );

  it.each(["\x1b", "\x03"])("cancels both editors without submitting (%j)", (key) => {
    const { modal } = setup();
    const submit = vi.fn();
    const close = vi.fn();
    modal.openInstructions("advisor", "original", submit, close);
    modal.handleInput("changed");
    expect(modal.handleInput(key)).toBe(true);
    modal.openMessage(target, "followUp", submit, close);
    modal.handleInput("discard this");
    expect(modal.handleInput(key)).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(2);
    expect(modal.handleInput(key)).toBe(false);
  });

  it.each([
    ["main", "steer", "message or steer Main"],
    ["agent", "steer", "steer now"],
    ["peer", "followUp", "queue follow-up"],
    ["actor", "steer", "queue actor message"],
    ["meshParticipant", "followUp", "queue follow-up"],
  ] as const)("preserves %s/%s presentation", (kind, delivery, title) => {
    const { modal } = setup();
    modal.openMessage({ ...target, kind }, delivery, vi.fn(), vi.fn());
    expect(modal.render(80, frame)!.slice(0, 3)).toEqual([
      `${title} · reviewer`, `${delivery} · reviewer`,
      "  enter send · shift+enter newline · esc cancel",
    ]);
  });

  it("does not render a child at zero width and disposes without navigation", () => {
    const { modal } = setup();
    const close = vi.fn();
    const renderFrame = vi.fn(frame);
    modal.openInstructions("advisor", "original", vi.fn(), close);
    expect(modal.render(0, renderFrame)).toEqual([]);
    expect(renderFrame).not.toHaveBeenCalled();
    modal.dispose();
    modal.dispose();
    expect(close).not.toHaveBeenCalled();
    expect(modal.handleInput("\r")).toBe(false);
    expect(modal.render(80, frame)).toBeUndefined();
  });

  it("reopens a fresh editor after cancellation without retaining the draft", () => {
    const { modal } = setup();
    const submit = vi.fn();
    modal.openMessage(target, "steer", submit, vi.fn());
    modal.handleInput("old draft");
    modal.handleInput("\x1b");
    modal.openMessage(target, "followUp", submit, vi.fn());
    modal.handleInput("\r");
    expect(submit).not.toHaveBeenCalled();
    modal.handleInput("new draft");
    modal.handleInput("\r");
    expect(submit).toHaveBeenCalledExactlyOnceWith("new draft");
  });
});
