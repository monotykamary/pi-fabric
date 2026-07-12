import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActorManager } from "../src/actors/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { SubagentManager } from "../src/subagents/manager.js";

const roots: string[] = [];
const actorManagers: ActorManager[] = [];
const subagentManagers: SubagentManager[] = [];

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for actor state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const setup = (persistent = false) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-actor-test-"));
  roots.push(root);
  const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 100);
  const subagents = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
    workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
    runRoot: path.join(root, "runs"),
  });
  subagentManagers.push(subagents);
  const identity: MeshIdentity = {
    id: "session:test",
    name: "main",
    kind: "main",
    sessionId: "test",
  };
  const meshConfig = { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 };
  const deliveries: string[] = [];
  const actors = new ActorManager(
    "test",
    identity,
    mesh,
    meshConfig,
    subagents,
    ({ message }) => {
      if (message.text) deliveries.push(message.text);
    },
    { actorRoot: path.join(root, "actors"), persistent },
  );
  actorManagers.push(actors);
  return { actors, mesh, deliveries, root, subagents, identity, meshConfig };
};

afterEach(async () => {
  await Promise.all(actorManagers.splice(0).map((manager) => manager.close()));
  await Promise.all(subagentManagers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ActorManager", () => {
  it("keeps a persistent actor identity and processes direct mailbox messages", async () => {
    const { actors, subagents } = setup();
    const actor = await actors.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });

    const reply = await actors.ask(actor.id, "Inspect auth");
    expect(reply.text).toBe("fake worker complete");
    expect(reply.actorId).toBe(actor.id);
    await waitFor(() => actors.status(actor.id).status === "idle");
    expect(actors.status(actor.id)).toMatchObject({ status: "idle", messages: 2 });
    expect(subagents.list()).toEqual([]);
    expect(actors.messages(actor.id)).toMatchObject([
      { direction: "in", source: "direct" },
      { direction: "out", source: "direct", text: "fake worker complete" },
    ]);
  });

  it("delivers schema-validated actor directives through the fixed policy", async () => {
    const { actors, deliveries } = setup();
    const actor = await actors.create({
      name: "advisor",
      instructions: "Advise only when useful.",
      responseMode: "directive",
      delivery: "steer",
    });

    const reply = await actors.ask(actor.id, "Review this turn");
    expect(reply).toMatchObject({
      action: "message",
      text: "fake actor advice",
    });
    expect(deliveries).toEqual(["fake actor advice"]);
  });

  it("restores persistent ambient actors for the same Pi session", async () => {
    const setupState = setup(true);
    const actor = await setupState.actors.create({
      name: "supervisor",
      instructions: "Watch until the goal is complete.",
      events: ["agent_settled"],
      responseMode: "directive",
    });
    await setupState.actors.close();
    actorManagers.splice(actorManagers.indexOf(setupState.actors), 1);

    const restored = new ActorManager(
      "test",
      setupState.identity,
      setupState.mesh,
      setupState.meshConfig,
      setupState.subagents,
      () => {},
      { actorRoot: path.join(setupState.root, "actors"), persistent: true },
    );
    actorManagers.push(restored);

    expect(restored.status(actor.id)).toMatchObject({
      id: actor.id,
      name: "supervisor",
      status: "idle",
      events: ["agent_settled"],
    });
  });

  it("routes host events and durable topic events to subscriptions", async () => {
    const { actors, mesh } = setup();
    const actor = await actors.create({
      name: "watcher",
      instructions: "Watch parent and team events.",
      events: ["agent_settled"],
      topics: ["team.auth"],
      responseMode: "text",
    });

    expect(actors.dispatchHostEvent("agent_settled", { goal: "ship" })).toBe(1);
    await mesh.publish({
      topic: "team.auth",
      from: { id: "peer", name: "peer", kind: "actor" },
      text: "Need review",
    });

    await waitFor(
      () => actors.messages(actor.id).filter((message) => message.direction === "out").length === 2,
    );
    const sources = actors
      .messages(actor.id)
      .filter((message) => message.direction === "out")
      .map((message) => message.source);
    expect(sources).toEqual(["host:agent_settled", "mesh:team.auth"]);
  });
});
