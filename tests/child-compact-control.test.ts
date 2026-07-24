import { describe, expect, it, vi } from "vitest";
import { ChildCompactControl } from "../src/agents/compact-control.js";
import type { AgentCompactionStatus } from "../src/agents/types.js";

const setup = () => {
  const frames: Array<{ id: string; type: "compact"; customInstructions?: string }> = [];
  const statuses: AgentCompactionStatus[] = [];
  const close = vi.fn();
  let now = 100;
  const control = new ChildCompactControl("run-1", {
    send: (frame) => frames.push(frame),
    close,
    update: (status) => statuses.push(status),
    now: () => ++now,
  });
  return { control, frames, statuses, close };
};

describe("ChildCompactControl", () => {
  it("queues a mid-turn request and starts compaction only after agent_settled", () => {
    const state = setup();
    state.control.queue("Keep findings");
    expect(state.frames).toEqual([]);
    expect(state.statuses.at(-1)?.status).toBe("queued");
    expect(state.close).not.toHaveBeenCalled();

    state.control.childSettled();
    expect(state.frames).toEqual([{
      id: "fabric-compact-run-1-1",
      type: "compact",
      customInstructions: "Keep findings",
    }]);
    expect(state.statuses.at(-1)?.status).toBe("in_flight");
    expect(state.close).not.toHaveBeenCalled();
  });

  it("waits for both the correlated response and compaction_end before shutdown", () => {
    const state = setup();
    state.control.queue();
    state.control.childSettled();
    state.control.observe({
      type: "response",
      command: "compact",
      id: "fabric-compact-run-1-1",
      success: true,
    });
    expect(state.close).not.toHaveBeenCalled();
    state.control.observe({ type: "compaction_end", aborted: false });
    expect(state.statuses.at(-1)?.status).toBe("completed");
    expect(state.close).toHaveBeenCalledOnce();
  });

  it("accepts compaction_end before the correlated response", () => {
    const state = setup();
    state.control.queue();
    state.control.childSettled();
    state.control.observe({ type: "compaction_end", aborted: false });
    expect(state.close).not.toHaveBeenCalled();
    state.control.observe({
      type: "response",
      command: "compact",
      id: "fabric-compact-run-1-1",
      success: true,
    });
    expect(state.statuses.at(-1)?.status).toBe("completed");
    expect(state.close).toHaveBeenCalledOnce();
  });

  it("records RPC rejection and compaction errors without aborting the active turn", () => {
    const rejected = setup();
    rejected.control.queue();
    expect(rejected.frames).toEqual([]);
    rejected.control.childSettled();
    rejected.control.observe({
      type: "response",
      command: "compact",
      id: "fabric-compact-run-1-1",
      success: false,
      error: "compact unavailable",
    });
    expect(rejected.statuses.at(-1)).toMatchObject({
      status: "failed",
      error: "compact unavailable",
    });
    expect(rejected.close).toHaveBeenCalledOnce();

    const failed = setup();
    failed.control.queue();
    failed.control.childSettled();
    failed.control.observe({ type: "compaction_end", errorMessage: "summary failed" });
    failed.control.observe({
      type: "response",
      command: "compact",
      id: "fabric-compact-run-1-1",
      success: true,
    });
    expect(failed.statuses.at(-1)).toMatchObject({
      status: "failed",
      error: "summary failed",
    });
    expect(failed.close).toHaveBeenCalledOnce();
  });

  it("coalesces queued requests to the latest instructions deterministically", () => {
    const state = setup();
    state.control.queue("first");
    state.control.queue("second");
    state.control.queue("latest");
    state.control.childSettled();
    expect(state.frames).toHaveLength(1);
    expect(state.frames[0]).toMatchObject({ customInstructions: "latest" });
    expect(state.statuses.at(-1)).toMatchObject({
      status: "in_flight",
      coalescedRequests: 2,
    });
  });

  it("runs one coalesced follow-on request before one-shot shutdown", () => {
    const state = setup();
    state.control.queue("first");
    state.control.childSettled();
    state.control.queue("second");
    state.control.queue("latest");
    state.control.observe({ type: "compaction_end", aborted: false });
    state.control.observe({
      type: "response",
      command: "compact",
      id: "fabric-compact-run-1-1",
      success: true,
    });
    expect(state.frames).toHaveLength(2);
    expect(state.frames[1]).toMatchObject({
      id: "fabric-compact-run-1-2",
      customInstructions: "latest",
    });
    expect(state.close).not.toHaveBeenCalled();
    state.control.observe({
      type: "response",
      command: "compact",
      id: "fabric-compact-run-1-2",
      success: true,
    });
    state.control.observe({ type: "compaction_end", aborted: false });
    expect(state.close).toHaveBeenCalledOnce();
    expect(state.statuses.at(-1)?.attempts).toBe(2);
  });
});
