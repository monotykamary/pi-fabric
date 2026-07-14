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

  it("stays ambient and retains the failed run when a directive run fails", async () => {
    const { actors, subagents } = setup();
    const actor = await actors.create({
      name: "supervisor",
      instructions: "Watch and steer only when needed.",
      responseMode: "directive",
      delivery: "steer",
    });

    const reply = await actors.ask(actor.id, "FAIL_DIRECTIVE");
    expect(reply).toMatchObject({ action: "silent" });
    expect((reply.data as { runError: string }).runError).toContain(
      "Structured agent output was invalid",
    );

    await waitFor(() => actors.status(actor.id).status === "idle");
    const status = actors.status(actor.id);
    expect(status).toMatchObject({ status: "idle" });
    expect(status.lastError).toBeUndefined();

    // The failed run is retained for debugging (agents.status(lastRunId)), not cleaned up.
    const retained = subagents.list();
    expect(retained).toHaveLength(1);
    const run = subagents.status(retained[0]!.id);
    expect(run).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Structured agent output was invalid"),
    });

    // Removing the actor releases the retained run.
    await actors.remove(actor.id);
    expect(subagents.list()).toEqual([]);
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

  it("retains completed-run logs and exposes them via readLog", async () => {
    const { actors, subagents } = setup();
    const actor = await actors.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    await actors.ask(actor.id, "Inspect auth");
    await waitFor(() => actors.status(actor.id).status === "idle");

    const status = actors.status(actor.id);
    expect(status.sessionFile).toContain("session.jsonl");
    expect(status.logDir).toContain("runs");

    const log = actors.readLog(actor.id, { type: "all" });
    expect(log.actorName).toBe("reviewer");
    expect(log.sessionFile).toContain("session.jsonl");
    const sessionRoles = log.session.map(
      (line) => (line.parsed as { role?: string } | undefined)?.role,
    );
    expect(sessionRoles).toContain("user");
    expect(sessionRoles).toContain("assistant");
    expect(log.run).toBeDefined();
    const eventTypes = log.run!.events.map(
      (line) => (line.parsed as { type?: string } | undefined)?.type,
    );
    expect(eventTypes).toContain("agent_start");
    expect(eventTypes).toContain("message_end");
    expect(log.run!.status?.status).toBe("completed");
    expect(log.retainedRuns).toHaveLength(1);
    // Completed runs are released from the in-memory registry, but the log
    // copy in the actor directory survives.
    expect(subagents.list()).toEqual([]);
  });

  it("retains failed-run logs too so readLog can inspect them", async () => {
    const { actors } = setup();
    const actor = await actors.create({
      name: "advisor",
      instructions: "Advise only when useful.",
      responseMode: "directive",
      delivery: "steer",
    });
    await actors.ask(actor.id, "FAIL_DIRECTIVE");
    await waitFor(() => actors.status(actor.id).status === "idle");
    const log = actors.readLog(actor.id, { type: "run" });
    expect(log.session).toEqual([]);
    expect(log.run).toBeDefined();
    expect(log.run!.status?.status).toBe("failed");
    const eventTypes = log.run!.events.map(
      (line) => (line.parsed as { type?: string } | undefined)?.type,
    );
    expect(eventTypes).toContain("agent_start");
  });

  it("setModel updates and clears an actor's model and it takes effect on the next run", async () => {
    const { actors } = setup();
    const actor = await actors.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    expect(actors.status(actor.id).model).toBeUndefined();

    await actors.setModel(actor.id, "anthropic/claude-sonnet-4-5");
    expect(actors.status(actor.id).model).toBe("anthropic/claude-sonnet-4-5");

    // The new model is forwarded to the subagent run launched for the next message.
    await actors.ask(actor.id, "Inspect auth");
    await waitFor(() => actors.status(actor.id).status === "idle");
    const run = actors.readLog(actor.id, { type: "run" });
    expect(run.run?.status?.model).toBe("anthropic/claude-sonnet-4-5");

    // Clearing the override falls back to the Fabric default (no stored model).
    await actors.setModel(actor.id, undefined);
    expect(actors.status(actor.id).model).toBeUndefined();
    await actors.ask(actor.id, "Inspect auth");
    await waitFor(() => actors.status(actor.id).status === "idle");
    const clearedRun = actors.readLog(actor.id, { type: "run" });
    expect(clearedRun.run?.status?.model).toBeUndefined();

    // Whitespace-only values are treated as clearing the override.
    await actors.setModel(actor.id, "  ");
    expect(actors.status(actor.id).model).toBeUndefined();
  });

  it("setModel throws for an unknown actor", async () => {
    const { actors } = setup();
    await expect(actors.setModel("nope", "anthropic/claude-sonnet-4-5")).rejects.toThrow(
      "Unknown Fabric actor",
    );
  });

  it("persists a setModel change across actor manager restarts", async () => {
    const setupState = setup(true);
    const actor = await setupState.actors.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    await setupState.actors.setModel(actor.id, "anthropic/claude-sonnet-4-5");
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

    expect(restored.status(actor.id).model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("haltAll aborts an in-flight run and cancels queued work without tearing actors down", async () => {
    const { actors } = setup();
    const actor = await actors.create({
      name: "supervisor",
      instructions: "Watch and steer only when needed.",
      responseMode: "text",
    });

    // Start a long-running ask (the fake worker hangs until killed). Wait until
    // the run is in flight before queueing a second message, since enqueueing
    // resets the actor status to "queued".
    const askPromise = actors.ask(actor.id, "HANG");
    await waitFor(() => actors.status(actor.id).status === "running");
    actors.tell(actor.id, "queued behind the hanging run");
    expect(actors.status(actor.id).queued).toBe(1);

    expect(actors.haltAll()).toEqual({ halted: 1 });

    // The abort can land before or after the subagent process spawns, so the
    // rejection reason is either the semaphore's "Operation aborted" or the
    // transport's "Subagent stopped" — both are valid interrupt outcomes.
    await expect(askPromise).rejects.toThrow(/Subagent stopped|Operation aborted/);
    await waitFor(() => actors.status(actor.id).status === "idle");
    expect(actors.status(actor.id).queued).toBe(0);

    // The actor is interrupted, not destroyed: it keeps its identity and can
    // process new messages immediately.
    const reply = await actors.ask(actor.id, "Inspect auth");
    expect(reply.text).toBe("fake worker complete");
    await waitFor(() => actors.status(actor.id).status === "idle");
    expect(actors.status(actor.id)).toMatchObject({ status: "idle", name: "supervisor" });
  });

  it("haltAll skips idle and stopped actors and leaves them usable", async () => {
    const { actors } = setup();
    const idle = await actors.create({
      name: "idle-advisor",
      instructions: "Advise only when useful.",
      responseMode: "text",
    });
    const stopped = await actors.create({
      name: "stopped-advisor",
      instructions: "Advise only when useful.",
      responseMode: "text",
    });
    await actors.stop(stopped.id);

    // An idle actor with no queued work is not counted as halted.
    expect(actors.haltAll()).toEqual({ halted: 0 });
    expect(actors.status(idle.id)).toMatchObject({ status: "idle" });
    expect(actors.status(stopped.id)).toMatchObject({ status: "stopped" });

    // The idle actor is still responsive after a no-op halt.
    const reply = await actors.ask(idle.id, "Inspect auth");
    expect(reply.text).toBe("fake worker complete");
  });

  it("haltAll arms a cooldown that suppresses host-event dispatch then resumes", async () => {
    const { actors } = setup();
    const actor = await actors.create({
      name: "watcher",
      instructions: "Watch parent events.",
      events: ["agent_settled"],
      responseMode: "text",
    });

    // Before any halt, host events are delivered normally.
    expect(actors.dispatchHostEvent("agent_settled", { turn: 1 })).toBe(1);
    await waitFor(() => actors.status(actor.id).status === "idle");

    // A halt (even with no active work) arms the cooldown.
    actors.haltAll();
    expect(actors.dispatchHostEvent("agent_settled", { turn: 2 })).toBe(0);

    // After the cooldown window, host-event dispatch resumes.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(actors.dispatchHostEvent("agent_settled", { turn: 3 })).toBe(1);
    await waitFor(() => actors.status(actor.id).status === "idle");
  });
});
