import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorLogStore, ACTOR_MESSAGE_HISTORY_LIMIT } from "../src/actors/log-store.js";
import type { FabricActorMessage } from "../src/actors/types.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "actor-logs-"));
  roots.push(root);
  return { root, actor: { sessionFile: path.join(root, "actor", "session.jsonl"), lastRunId: "latest" }, store: new ActorLogStore({ maxEventBytes: 8192 }, { eventContextChars: 1000 }, { actorRunArchiveMs: 100 }) };
};

describe("ActorLogStore", () => {
  it("reads live message and retention limits instead of snapshotting configuration", () => {
    const { root, actor } = setup();
    const mesh = { maxEventBytes: 8192 };
    const config = { eventContextChars: 1000 };
    const retention = { actorRunArchiveMs: 1000 };
    const store = new ActorLogStore(mesh, config, retention);
    const history: FabricActorMessage[] = [];
    const message = (): FabricActorMessage => ({ id: "message", actorId: "a", actorName: "a", direction: "out", source: "test", createdAt: 1, text: "x".repeat(500) });
    store.recordMessage(history, message());
    expect(history.at(-1)?.text).toHaveLength(500);
    config.eventContextChars = 10;
    store.recordMessage(history, message());
    expect(history.at(-1)?.text).toBe("x".repeat(10) + "\n[actor message truncated]");
    config.eventContextChars = 1000;
    mesh.maxEventBytes = 4600;
    store.recordMessage(history, message());
    expect(Buffer.byteLength(JSON.stringify(history.at(-1)))).toBeLessThanOrEqual(504);
    const directory = path.join(root, "actor", "runs", "old");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "status.json"), JSON.stringify({ status: "completed", finishedAt: 1 }));
    store.pruneRuns(actor, 1000);
    expect(store.retainedRunIds(actor)).toEqual(["old"]);
    retention.actorRunArchiveMs = 100;
    store.pruneRuns(actor, 1000);
    expect(store.retainedRunIds(actor)).toEqual([]);
  });

  it("bounds caller messages identically to retained history and keeps the newest 100", () => {
    const { store } = setup();
    const history: FabricActorMessage[] = [];
    for (let i = 0; i < 102; i++) {
      const message: FabricActorMessage = { id: String(i), actorId: "a", actorName: "a", direction: "out", source: "test", createdAt: i, text: "🙂\"".repeat(10000), data: { huge: "x".repeat(10000) } };
      store.recordMessage(history, message);
      expect(message).toEqual(history.at(-1));
      expect(message).not.toBe(history.at(-1));
      expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(4096);
    }
    expect(history).toHaveLength(ACTOR_MESSAGE_HISTORY_LIMIT);
    expect(history[0]?.id).toBe("2");
    expect(history.at(-1)?.id).toBe("101");
  });

  it("prunes only expired terminal archives, protecting the latest and active runs", () => {
    const { root, actor, store } = setup();
    for (const [id, status, finishedAt] of [["old", "completed", 1], ["latest", "completed", 1], ["active", "running", 1], ["recent", "failed", 950], ["unknown", undefined, 1]] as const) {
      const dir = path.join(root, "actor", "runs", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ status, finishedAt }));
    }
    store.pruneRuns(actor, 1000);
    expect(store.retainedRunIds(actor)).toEqual(["active", "latest", "recent", "unknown"]);
  });

  it("copies the archive protocol and nested runs, tolerating missing sources and nested-copy failure", async () => {
    const { root, actor, store } = setup();
    await store.retainRun(actor, "missing", undefined);
    expect(store.retainedRunIds(actor)).toEqual([]);
    const source = path.join(root, "source");
    fs.mkdirSync(path.join(source, "nested"), { recursive: true });
    for (const file of ["events.jsonl", "status.json", "task.txt", "private.txt", "nested/child"]) fs.writeFileSync(path.join(source, file), file);
    await store.retainRun(actor, "latest", source);
    const dest = path.join(root, "actor", "runs", "latest");
    expect(fs.readdirSync(dest).sort()).toEqual(["events.jsonl", "nested", "status.json", "task.txt"]);
    expect(fs.readFileSync(path.join(dest, "nested", "child"), "utf8")).toBe("nested/child");
    vi.spyOn(fs, "cpSync").mockImplementation(() => { throw new Error("nested unavailable"); });
    await expect(store.retainRun(actor, "other", source)).resolves.toBeUndefined();
    expect(store.retainedRunIds(actor)).toEqual(["latest", "other"]);
  });
});
