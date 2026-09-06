import fs, { type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorMeshMonitor } from "../src/actors/mesh-monitor.js";
import type { MeshEvent } from "../src/mesh/store.js";

const roots: string[] = [];
const monitors: ActorMeshMonitor[] = [];
afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(cursor?: string) {
  vi.useFakeTimers();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "actor-monitor-"));
  roots.push(root);
  const cursorPath = path.join(root, "cursor.json");
  if (cursor !== undefined) fs.writeFileSync(cursorPath, cursor);
  const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
  vi.spyOn(fs, "watch").mockReturnValue(watcher as unknown as FSWatcher);
  const event = { topic: "test" } as MeshEvent;
  const mesh = { root, latestOffset: vi.fn(() => 10), tail: vi.fn(() => ({ events: [event], nextOffset: 20 })) };
  const beforePoll = vi.fn(() => true);
  const onEvent = vi.fn();
  const monitor = new ActorMeshMonitor(mesh, { enabled: true, actorPollMs: 50, maxReadEvents: 7 }, { cursorPath, beforePoll, onEvent });
  monitors.push(monitor);
  return { root, cursorPath, watcher, mesh, beforePoll, onEvent, monitor };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("ActorMeshMonitor", () => {
  it("coalesces notifications, preserves a halted cursor, and resumes in order", async () => {
    const s = setup('{"format":1,"cursor":3}');
    s.beforePoll.mockReturnValue(false);
    s.monitor.start();
    await flush();
    expect(s.mesh.tail).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(s.cursorPath, "utf8")).cursor).toBe(3);
    s.beforePoll.mockReturnValue(true);
    s.monitor.schedule();
    s.monitor.schedule();
    await flush();
    expect(s.mesh.tail).toHaveBeenCalledExactlyOnceWith(3, 7);
    expect(s.onEvent).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(s.cursorPath, "utf8"))).toEqual({ format: 1, cursor: 20 });
  });

  it.skipIf(process.platform === "win32")("falls back after watcher errors and closes timers and queued work", async () => {
    const s = setup();
    s.monitor.start();
    await flush();
    s.watcher.emit("error", new Error("watch failed"));
    await flush();
    expect(s.watcher.close).toHaveBeenCalledOnce();
    const count = s.mesh.tail.mock.calls.length;
    await vi.advanceTimersByTimeAsync(50);
    expect(s.mesh.tail).toHaveBeenCalledTimes(count + 1);
    s.monitor.schedule();
    s.monitor.close();
    s.monitor.close();
    s.watcher.emit("error", new Error("late error"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.mesh.tail).toHaveBeenCalledTimes(count + 1);
    expect(vi.getTimerCount()).toBe(0);
    expect(s.watcher.close).toHaveBeenCalledOnce();
  });

  it("uses polling when watch creation fails and ignores malformed cursors", async () => {
    const s = setup('{"format":2,"cursor":3}');
    vi.mocked(fs.watch).mockImplementation(() => { throw new Error("unsupported"); });
    s.monitor.start();
    s.monitor.start();
    await flush();
    expect(s.mesh.tail).toHaveBeenCalledExactlyOnceWith(10, 7);
    await vi.advanceTimersByTimeAsync(50);
    expect(s.mesh.tail).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not commit a cursor after dispatch failure and tolerates cursor write failure", async () => {
    const s = setup('{"format":1,"cursor":3}');
    s.onEvent.mockImplementationOnce(() => { throw new Error("dispatch"); });
    s.monitor.start();
    await flush();
    expect(JSON.parse(fs.readFileSync(s.cursorPath, "utf8")).cursor).toBe(3);
    fs.rmSync(s.cursorPath);
    fs.mkdirSync(s.cursorPath);
    s.monitor.schedule();
    await flush();
    expect(s.mesh.tail).toHaveBeenLastCalledWith(20, 7);
    expect(s.onEvent).toHaveBeenCalledTimes(2);
  });
});
