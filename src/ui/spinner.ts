const SPINNER_INTERVAL_MS = 250;

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;

export interface SpinnerTimerState {
  timer?: ReturnType<typeof setTimeout>;
}

export const spinnerFrame = (now = Date.now()): string =>
  SPINNER_FRAMES[Math.floor(now / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]!;

export const updateSpinner = (
  state: SpinnerTimerState,
  active: boolean,
  invalidate: () => void,
  now = Date.now(),
): string => {
  if (!active) {
    if (state.timer) clearTimeout(state.timer);
    delete state.timer;
    return spinnerFrame(now);
  }
  if (!state.timer) {
    const delay = SPINNER_INTERVAL_MS - (now % SPINNER_INTERVAL_MS);
    state.timer = setTimeout(() => {
      delete state.timer;
      invalidate();
    }, delay);
    state.timer.unref?.();
  }
  return spinnerFrame(now);
};
