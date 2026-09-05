import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFabricEscapeHalt } from "../src/ui/escape-halt.js";

function harness() {
  vi.useFakeTimers();
  let input: ((data: string) => unknown) | undefined;
  const unsubscribe = vi.fn();
  const notify = vi.fn();
  const context = {
    mode: "tui",
    ui: {
      notify,
      onTerminalInput: (handler: (data: string) => unknown) => { input = handler; return unsubscribe; },
    },
  } as unknown as ExtensionContext;
  const options = {
    enabled: vi.fn(() => true),
    ownsInput: vi.fn(() => false),
    halted: vi.fn(() => false),
    halt: vi.fn(() => 2),
  };
  const dispose = installFabricEscapeHalt(context, options);
  return { context, options, dispose, notify, unsubscribe, input: (data: string) => input?.(data) };
}

afterEach(() => vi.useRealTimers());

describe("Fabric Escape ownership", () => {
  it("observes native Escape without consuming it and halts once after debounce", () => {
    const h = harness();
    expect(h.input("\x1b")).toBeUndefined();
    expect(h.options.halt).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(h.options.halt).toHaveBeenCalledOnce();
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("halted 2 actors"), "warning");
    h.dispose();
  });

  it("never treats closing a Fabric view as a native interrupt", () => {
    const h = harness();
    h.options.ownsInput.mockReturnValue(true);
    h.input("\x1b");
    // Pi now delivers this same key to the focused view, which closes it.
    h.options.ownsInput.mockReturnValue(false);
    vi.advanceTimersByTime(100);
    expect(h.options.halt).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    h.dispose();
  });

  it("drops a pending interrupt when a conversation opens during the debounce", () => {
    const h = harness();
    h.input("\x1b");
    h.options.ownsInput.mockReturnValue(true);
    vi.advanceTimersByTime(100);
    expect(h.options.halt).not.toHaveBeenCalled();
    h.dispose();
  });

  it("does not confuse complete or split arrow sequences with Escape", () => {
    const h = harness();
    h.input("\x1b[A");
    vi.advanceTimersByTime(100);
    h.input("\x1b");
    vi.advanceTimersByTime(30);
    h.input("[B");
    vi.advanceTimersByTime(100);
    expect(h.options.halt).not.toHaveBeenCalled();
    h.dispose();
  });

  it("cancels delayed work on teardown, not just the input subscription", () => {
    const h = harness();
    h.input("\x1b");
    h.dispose();
    vi.advanceTimersByTime(100);
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    expect(h.options.halt).not.toHaveBeenCalled();
  });

  it("respects disabled and already-halted states without noisy notifications", () => {
    const h = harness();
    h.options.enabled.mockReturnValue(false);
    h.input("\x1b");
    vi.advanceTimersByTime(100);
    h.options.enabled.mockReturnValue(true);
    h.options.halted.mockReturnValue(true);
    h.input("\x1b");
    vi.advanceTimersByTime(100);
    expect(h.options.halt).not.toHaveBeenCalled();
    h.options.halted.mockReturnValue(false);
    h.options.halt.mockReturnValue(0);
    h.input("\x1b");
    vi.advanceTimersByTime(100);
    expect(h.notify).not.toHaveBeenCalled();
    h.dispose();
  });

  it("does not attach terminal input in RPC mode", () => {
    const onTerminalInput = vi.fn();
    const context = { mode: "rpc", ui: { onTerminalInput } } as unknown as ExtensionContext;
    installFabricEscapeHalt(context, {
      enabled: () => true, ownsInput: () => false, halted: () => false, halt: () => 0,
    })();
    expect(onTerminalInput).not.toHaveBeenCalled();
  });
});
