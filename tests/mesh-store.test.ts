import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";

const roots: string[] = [];
const identity: MeshIdentity = {
  id: "session:test",
  name: "main",
  kind: "main",
  sessionId: "test",
};

const createStore = (): MeshStore => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-mesh-"));
  roots.push(root);
  return new MeshStore(root, 64 * 1024, 100);
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("MeshStore", () => {
  it("publishes durable ordered events and reads from a cursor", async () => {
    const store = createStore();
    const initialOffset = store.latestOffset();
    const first = await store.publish({ topic: "team.auth", from: identity, text: "one" });
    const second = await store.publish({
      topic: "team.auth",
      from: identity,
      to: "reviewer",
      text: "two",
      data: { task: 2 },
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(store.read({ after: first.sequence })).toMatchObject([
      { sequence: 2, to: "reviewer", text: "two", data: { task: 2 } },
    ]);
    expect(store.read({ topic: "team.auth", to: "reviewer" })).toHaveLength(1);
    const firstTail = store.tail(initialOffset, 1);
    expect(firstTail.events).toMatchObject([{ sequence: 1, text: "one" }]);
    const secondTail = store.tail(firstTail.nextOffset, 10);
    expect(secondTail.events).toMatchObject([{ sequence: 2, text: "two" }]);
    expect(secondTail.nextOffset).toBe(store.latestOffset());
  });

  it("repairs an interrupted append without reusing sequence numbers", async () => {
    const store = createStore();
    await store.publish({ topic: "team.auth", from: identity, text: "one" });
    fs.writeFileSync(path.join(store.root, "sequence"), "0");
    fs.appendFileSync(path.join(store.root, "events.jsonl"), '{"sequence":999');

    const second = await store.publish({ topic: "team.auth", from: identity, text: "two" });
    expect(second.sequence).toBe(2);
    expect(store.read()).toMatchObject([
      { sequence: 1, text: "one" },
      { sequence: 2, text: "two" },
    ]);
  });

  it("supports compare-and-swap shared state", async () => {
    const store = createStore();
    const created = await store.put({
      key: "tasks/task-1",
      value: { status: "ready" },
      identity,
      ifVersion: 0,
    });
    expect(created.version).toBe(1);

    await expect(
      store.put({
        key: "tasks/task-1",
        value: { status: "claimed" },
        identity,
        ifVersion: 0,
      }),
    ).rejects.toThrow("compare-and-swap failed");

    const claimed = await store.put({
      key: "tasks/task-1",
      value: { status: "claimed", owner: "worker" },
      identity,
      ifVersion: created.version,
    });
    expect(claimed.version).toBe(2);
    expect(store.get("tasks/task-1")?.value).toEqual({ status: "claimed", owner: "worker" });
    expect(store.list("tasks/")).toHaveLength(1);
    expect(() => store.get("tasks/__proto__")).toThrow("Invalid Fabric mesh key");
  });
});
