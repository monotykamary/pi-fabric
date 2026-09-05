import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { ConversationTextSelection } from "../src/ui/conversation-selection.js";

const theme = { fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => `\x1b[44m${value}\x1b[0m` } as unknown as Theme;

describe("preview-owned transcript selection", () => {
  it("copies multiline text in either direction without terminal control sequences", () => {
    const rows = ["\x1b]133;A\x07\x1b[31malpha beta\x1b[0m", "gamma delta"];
    for (const reverse of [false, true]) {
      const selection = new ConversationTextSelection();
      selection.start(rows, reverse ? 1 : 0, reverse ? 5 : 6);
      selection.finish(reverse ? 0 : 1, reverse ? 6 : 5);
      expect(selection.text()).toBe("beta\ngamma");
      expect(selection.source).toBe(rows);
      expect(stripTerminalSequences(selection.highlight(rows[0]!, 0, theme))).toBe("alpha beta");
      selection.clear();
      expect(selection.text()).toBeUndefined();
      expect(selection.source).toBeUndefined();
    }
  });

  it("snaps wide and combined graphemes without changing rendered row width", () => {
    const rows = ["A界🙂e\u0301Z"];
    const selection = new ConversationTextSelection();
    selection.start(rows, 0, 2);
    selection.finish(0, 6);
    expect(selection.text()).toBe("界🙂e\u0301");
    expect(visibleWidth(selection.highlight(rows[0]!, 0, theme))).toBe(7);
    expect(stripTerminalSequences(selection.highlight(rows[0]!, 0, theme))).toBe(rows[0]);
  });

  it("does not select on a click or slice image payloads", () => {
    const selection = new ConversationTextSelection();
    const image = "\x1b_Ga=T;payload\x1b\\image";
    selection.start([image], 0, 0);
    selection.finish(0, 0);
    expect(selection.active).toBe(false);
    selection.start([image], 0, 0);
    selection.finish(0, 5);
    expect(selection.text()).toBe("image");
    expect(selection.highlight(image, 0, theme)).toBe(image);
  });

  it("retains a reference instead of iterating the full history on drag", () => {
    const rows = new Proxy(Array.from({ length: 100_000 }, () => "line"), {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new Error("full history iteration");
        return Reflect.get(target, property, receiver);
      },
    });
    const selection = new ConversationTextSelection();
    selection.start(rows, 50_000, 0);
    selection.finish(50_001, 4);
    expect(selection.text()).toBe("line\nline");
  });
});
