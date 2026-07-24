import { afterEach, describe, expect, it, vi } from "vitest";
import { spinnerFrame, type SpinnerTimerState, updateSpinner } from "../src/ui/spinner.js";

describe("spinner", () => {
  afterEach(() => vi.useRealTimers());

  it("uses the widget frame sequence at 250ms intervals", () => {
    expect([0, 250, 500, 750, 1_000].map(spinnerFrame)).toEqual(["◐", "◓", "◑", "◒", "◐"]);
  });

  it("keeps only one timer active and stops invalidating after completion", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const invalidate = vi.fn();
    const state: SpinnerTimerState = {};

    expect(updateSpinner(state, true, invalidate)).toBe("◐");
    const timer = state.timer;
    expect(timer).toBeDefined();
    expect(updateSpinner(state, true, invalidate)).toBe("◐");
    expect(state.timer).toBe(timer);

    vi.advanceTimersByTime(250);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(state.timer).toBeUndefined();
    expect(updateSpinner(state, true, invalidate)).toBe("◓");

    updateSpinner(state, false, invalidate);
    expect(state.timer).toBeUndefined();
    vi.advanceTimersByTime(1_000);
    expect(invalidate).toHaveBeenCalledOnce();
  });
});
