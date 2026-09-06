import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardGraphController } from "../src/ui/dashboard-graph-controller.js";
import type { MeshEvent } from "../src/mesh/store.js";
import type { FabricProjectMeshRoute } from "../src/ui/topology.js";

const event = (id: string, fromId = "agent-1"): MeshEvent => ({
  id,
  sequence: 1,
  topic: "work",
  kind: "message",
  from: { id: fromId, name: "worker", kind: "agent" },
  createdAt: 1,
});
const route: FabricProjectMeshRoute = {
  id: "route-1",
  fromId: "agent-1",
  fromName: "worker",
  fromKind: "agent",
  targetId: "work",
  targetName: "work",
  targetKind: "topic",
  topic: "work",
  kind: "message",
  status: "running",
  count: 2,
  lastAt: 1,
};

describe("DashboardGraphController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("matches replay routes by topic, kind and sender id or name in event order", () => {
    const graph = new DashboardGraphController(vi.fn());
    const first = event("first", "old-agent-id");
    const second = event("second");
    const events = [{ ...event("unmatched"), kind: "other" }, first, second];
    graph.toggleReplay(events, [route]);
    expect(graph.replayFrame(events, [route])).toEqual({ event: first, route });
    expect(graph.replayLength).toBe(2);
    expect(graph.replayLabel).toBe("message");
    graph.stepReplay(100);
    expect(graph.replayFrame(events, [route])?.event).toBe(second);
    expect(graph.replayPlaying).toBe(false);
    graph.stepReplay(-100);
    expect(graph.replayIndex).toBe(0);
    graph.toggleReplay(events, [route]);
    expect(graph.replayIndex).toBeUndefined();
    expect(graph.replayPlaying).toBe(false);
  });

  it("clamps replay when history shrinks and exits when no matching routes remain", () => {
    const graph = new DashboardGraphController(vi.fn());
    const events = [event("first"), event("second")];
    graph.toggleReplay(events, [route]);
    graph.stepReplay(1);
    expect(graph.replayFrame(events.slice(0, 1), [route])?.event.id).toBe("first");
    expect(graph.replayIndex).toBe(0);
    expect(graph.replayFrame(events, [])).toBeUndefined();
    expect(graph.replayIndex).toBeUndefined();
    expect(graph.replayPlaying).toBe(false);
    graph.toggleReplay(events, []);
    graph.stepReplay(1);
    expect(graph.replayIndex).toBeUndefined();
  });

  it("advances once per effects tick, pauses at the end, and stops invalidating on cleanup", () => {
    const render = vi.fn();
    const graph = new DashboardGraphController(render);
    graph.toggleReplay([event("first"), event("second")], [route]);
    graph.startEffectsAnimation();
    graph.startEffectsAnimation();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(800);
    expect(graph.replayIndex).toBe(0);
    vi.advanceTimersByTime(80);
    expect(graph.replayIndex).toBe(1);
    vi.advanceTimersByTime(880);
    expect(graph.replayPlaying).toBe(false);
    graph.stopEffectsAnimation();
    const calls = render.mock.calls.length;
    vi.advanceTimersByTime(1_000);
    expect(render).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves bounded speeds and resets the replay clock on speed and playback changes", () => {
    const graph = new DashboardGraphController(vi.fn());
    graph.toggleReplay([event("first"), event("second")], [route]);
    graph.startEffectsAnimation();
    for (let i = 0; i < 5; i++) graph.changeReplaySpeed(-1);
    expect(graph.replaySpeed).toBe(0.5);
    for (let i = 0; i < 5; i++) graph.changeReplaySpeed(1);
    expect(graph.replaySpeed).toBe(4);
    vi.advanceTimersByTime(160);
    graph.togglePlayback();
    vi.advanceTimersByTime(400);
    expect(graph.replayIndex).toBe(0);
    graph.togglePlayback();
    vi.advanceTimersByTime(160);
    expect(graph.replayIndex).toBe(0);
    vi.advanceTimersByTime(80);
    expect(graph.replayIndex).toBe(1);
  });

  it("initializes the camera immediately, springs to new targets and stops at rest", () => {
    const graph = new DashboardGraphController(vi.fn());
    const point = { x: 10, y: 20 };
    graph.setCameraTarget(point);
    point.x = 999;
    expect(graph.camera).toEqual({ x: 10, y: 20 });
    expect(graph.cameraInitialized).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    graph.setCameraTarget({ x: 30, y: 40 });
    graph.setCameraTarget({ x: 30, y: 40 });
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(16);
    expect(graph.camera.x).toBeGreaterThan(10);
    expect(graph.camera.x).toBeLessThan(30);
    vi.advanceTimersByTime(5_000);
    expect(graph.camera).toEqual({ x: 30, y: 40 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("freezes camera motion on cleanup and owns directional geometry and effect preferences", () => {
    const render = vi.fn();
    const graph = new DashboardGraphController(render);
    graph.setPositions(new Map([
      ["left", { x: 0, y: 0 }],
      ["right", { x: 20, y: 0 }],
    ]));
    expect(graph.directionalTarget("left", "right")).toBe("right");
    graph.toggleHistory();
    graph.toggleReducedMotion();
    expect(graph.showHistory).toBe(true);
    expect(graph.reducedMotion).toBe(true);
    graph.setCameraTarget({ x: 0, y: 0 });
    graph.setCameraTarget({ x: 20, y: 0 });
    vi.advanceTimersByTime(32);
    graph.stopCameraAnimation();
    const stopped = { ...graph.camera };
    const calls = render.mock.calls.length;
    vi.advanceTimersByTime(1_000);
    expect(graph.camera).toEqual(stopped);
    expect(render).toHaveBeenCalledTimes(calls);
    graph.setCameraTarget({ x: 20, y: 0 });
    expect(vi.getTimerCount()).toBe(1);
  });
});
