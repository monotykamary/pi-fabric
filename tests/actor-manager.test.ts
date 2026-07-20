import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorManager } from "../src/actors/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import type { FabricMainAgentDeliveryRequest } from "../src/main-agent.js";
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
  it("does not poll an unchanged mesh at the configured active interval", async () => {
    const { mesh } = setup();
    const tail = vi.spyOn(mesh, "tail");

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(tail).toHaveBeenCalledTimes(1);
  });

  it("notifies and releases actor state subscribers", async () => {
    const { actors } = setup();
    const listener = vi.fn();
    const unsubscribe = actors.subscribe(listener);
    const actor = await actors.create({ name: "observer", instructions: "Observe." });
    expect(listener).toHaveBeenCalled();

    const beforeUpdate = listener.mock.calls.length;
    await actors.setModel(actor.id, "provider/model");
    expect(listener.mock.calls.length).toBeGreaterThan(beforeUpdate);

    unsubscribe();
    const beforeUnsubscribedUpdate = listener.mock.calls.length;
    await actors.setThinking(actor.id, "high");
    expect(listener).toHaveBeenCalledTimes(beforeUnsubscribedUpdate);
  });

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

  it("resumes a Claude Code session after a persistent actor is restored", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-claude-actor-"));
    roots.push(root);
    const invocationLog = path.join(root, "claude-args.jsonl");
    process.env.FAKE_CLAUDE_LOG = invocationLog;
    try {
      const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 100);
      const subagents = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
        workerPath: path.resolve("src/worker.ts"),
        claudeBinary: path.resolve("tests/fixtures/fake-claude.mjs"),
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
      const actorRoot = path.join(root, "actors");
      const first = new ActorManager(
        "test",
        identity,
        mesh,
        meshConfig,
        subagents,
        () => {},
        { actorRoot, persistent: true },
      );
      actorManagers.push(first);
      const actor = await first.create({
        name: "claude-reviewer",
        instructions: "Review each mailbox item.",
        runner: "claude",
        tools: ["read"],
      });

      const firstReply = await first.ask(actor.id, "first message");
      expect(firstReply.text).toContain("fake claude complete");
      await waitFor(() => first.status(actor.id).status === "idle");
      expect(first.status(actor.id)).toMatchObject({ runner: "claude", status: "idle" });
      await first.close();
      actorManagers.splice(actorManagers.indexOf(first), 1);

      const restored = new ActorManager(
        "test",
        identity,
        mesh,
        meshConfig,
        subagents,
        () => {},
        { actorRoot, persistent: true },
      );
      actorManagers.push(restored);
      expect(restored.status(actor.id)).toMatchObject({ runner: "claude", status: "idle" });
      const secondReply = await restored.ask(actor.id, "second message");
      expect(secondReply.text).toContain("fake claude complete");

      const invocations = fs
        .readFileSync(invocationLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { argv: string[] });
      expect(invocations).toHaveLength(2);
      expect(invocations[0]!.argv).not.toContain("--resume");
      const resumeAt = invocations[1]!.argv.indexOf("--resume");
      expect(invocations[1]!.argv[resumeAt + 1]).toBe(
        "11111111-1111-4111-8111-111111111111",
      );
      expect(invocations[0]!.argv).not.toContain("--no-session-persistence");
      expect(restored.readLog(actor.id).session.filter((line) => line.parsed)).not.toHaveLength(0);
    } finally {
      delete process.env.FAKE_CLAUDE_LOG;
    }
  });

  it("restores project-scoped actors across different Pi sessions", async () => {
    // Project scope stores actors at a shared root (no sessionId segment), so a
    // new Pi session that points at the same root picks up the roster without
    // redefining actors.
    const scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-actor-scope-"));
    roots.push(scopeDir);
    const sharedRoot = path.join(scopeDir, "actors");
    const firstMesh = new MeshStore(path.join(scopeDir, "mesh"), 64 * 1024, 100);
    const firstSubagents = new SubagentManager(
      process.cwd(),
      DEFAULT_FABRIC_CONFIG.subagents,
      { workerPath: path.resolve("tests/fixtures/fake-worker.mjs"), runRoot: path.join(scopeDir, "runs") },
    );
    subagentManagers.push(firstSubagents);
    const first = new ActorManager(
      "session-a",
      { id: "session:a", name: "main", kind: "main", sessionId: "session-a" },
      firstMesh,
      { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 },
      firstSubagents,
      () => {},
      { actorRoot: sharedRoot, persistent: true },
    );
    actorManagers.push(first);
    const actor = await first.create({
      name: "advisor",
      instructions: "Watch until the goal is complete.",
      responseMode: "directive",
    });
    await first.close();
    actorManagers.splice(actorManagers.indexOf(first), 1);

    // A brand-new Pi session, same shared actor root.
    const secondMesh = new MeshStore(path.join(scopeDir, "mesh"), 64 * 1024, 100);
    const secondSubagents = new SubagentManager(
      process.cwd(),
      DEFAULT_FABRIC_CONFIG.subagents,
      { workerPath: path.resolve("tests/fixtures/fake-worker.mjs"), runRoot: path.join(scopeDir, "runs") },
    );
    subagentManagers.push(secondSubagents);
    const restored = new ActorManager(
      "session-b",
      { id: "session:b", name: "main", kind: "main", sessionId: "session-b" },
      secondMesh,
      { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 },
      secondSubagents,
      () => {},
      { actorRoot: sharedRoot, persistent: true },
    );
    actorManagers.push(restored);

    expect(restored.status(actor.id)).toMatchObject({
      id: actor.id,
      name: "advisor",
      status: "idle",
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

  it("setTools normalizes and persists an actor tool allowlist", async () => {
    const setupState = setup(true);
    const actor = await setupState.actors.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
    });

    await setupState.actors.setTools(actor.id, [" read ", "grep", "read", ""]);
    expect(setupState.actors.status(actor.id).tools).toEqual(["read", "grep"]);
    expect(setupState.actors.definition(actor.id).tools).toEqual(["read", "grep"]);

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
    expect(restored.status(actor.id).tools).toEqual(["read", "grep"]);

    await restored.setTools(actor.id, []);
    expect(restored.status(actor.id).tools).toEqual([]);
  });

  it("setThinking updates and clears an actor's thinking and it takes effect on the next run", async () => {
    const { actors } = setup();
    const actor = await actors.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    expect(actors.status(actor.id).thinking).toBeUndefined();

    await actors.setThinking(actor.id, "high");
    expect(actors.status(actor.id).thinking).toBe("high");

    // The new thinking is forwarded to the subagent run launched for the next message.
    await actors.ask(actor.id, "Inspect auth");
    await waitFor(() => actors.status(actor.id).status === "idle");
    const run = actors.readLog(actor.id, { type: "run" });
    expect(run.run?.status?.thinking).toBe("high");

    // Clearing the override falls back to the Fabric default (medium).
    await actors.setThinking(actor.id, undefined);
    expect(actors.status(actor.id).thinking).toBeUndefined();
    await actors.ask(actor.id, "Inspect auth");
    await waitFor(() => actors.status(actor.id).status === "idle");
    const clearedRun = actors.readLog(actor.id, { type: "run" });
    expect(clearedRun.run?.status?.thinking).toBe("medium");

    // Whitespace-only values are treated as clearing the override.
    await actors.setThinking(actor.id, "  ");
    expect(actors.status(actor.id).thinking).toBeUndefined();
  });

  it("setThinking rejects an invalid thinking level", async () => {
    const { actors } = setup();
    const actor = await actors.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    await expect(actors.setThinking(actor.id, "turbo")).rejects.toThrow(
      "Invalid Fabric actor thinking level",
    );
    expect(actors.status(actor.id).thinking).toBeUndefined();
  });

  it("setThinking throws for an unknown actor", async () => {
    const { actors } = setup();
    await expect(actors.setThinking("nope", "high")).rejects.toThrow("Unknown Fabric actor");
  });

  it("persists a setThinking change across actor manager restarts", async () => {
    const setupState = setup(true);
    const actor = await setupState.actors.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    await setupState.actors.setThinking(actor.id, "xhigh");
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

    expect(restored.status(actor.id).thinking).toBe("xhigh");
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

  it("haltAll arms a stop-the-world that suppresses host events until the user resumes", async () => {
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

    // A halt arms stop-the-world: subsequent host events are suppressed...
    actors.haltAll();
    expect(actors.dispatchHostEvent("agent_settled", { turn: 2 })).toBe(0);

    // ...including other event types, with no time-based expiry.
    expect(actors.dispatchHostEvent("tool_error", { turn: 2 })).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 60));

    // The user resumes by sending a new message: the "input" host event lifts
    // the halt. The watcher does not subscribe to input, so this dispatches to
    // zero actors but reopens the gate.
    expect(actors.dispatchHostEvent("input", { turn: 3 })).toBe(0);

    // After resume, host-event dispatch is delivered again.
    expect(actors.dispatchHostEvent("agent_settled", { turn: 4 })).toBe(1);
    await waitFor(() => actors.status(actor.id).status === "idle");
  });

  it("delivers mesh messages deferred by stop-the-world immediately after resume", async () => {
    const { actors, mesh } = setup();
    const actor = await actors.create({
      name: "mesh-watcher",
      instructions: "Watch mesh messages.",
      responseMode: "text",
    });
    actors.haltAll();
    await mesh.publish({
      topic: "fabric.steer",
      kind: "steer",
      from: { id: "peer", name: "peer", kind: "agent" },
      to: actor.id,
      text: "deferred while halted",
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(actors.messages(actor.id)).toEqual([]);

    actors.dispatchHostEvent("input", { resumed: true });
    await waitFor(() => actors.messages(actor.id).some((message) => message.direction === "in"));
    await waitFor(() => actors.status(actor.id).status === "idle");
  });

  it("exposes the stop-the-world gate via halted, lifting it on the next message", async () => {
    const { actors } = setup();

    // The gate starts disarmed.
    expect(actors.halted).toBe(false);

    // haltAll() arms the gate even when no actor had active work to abort.
    expect(actors.haltAll()).toEqual({ halted: 0 });
    expect(actors.halted).toBe(true);

    // A repeated halt is a no-op (the gate is already armed) — the index.ts
    // ESC handler reads halted to avoid re-notifying on a double-Esc.
    expect(actors.haltAll()).toEqual({ halted: 0 });
    expect(actors.halted).toBe(true);

    // The next message ("input") lifts the gate; it can then re-arm.
    expect(actors.dispatchHostEvent("input", { turn: 1 })).toBe(0);
    expect(actors.halted).toBe(false);
    expect(actors.haltAll()).toEqual({ halted: 0 });
    expect(actors.halted).toBe(true);
  });

  it("setEvents replaces an actor's host-event subscriptions and dedupes", async () => {
    const { actors } = setup();
    const actor = await actors.create({
      name: "watcher",
      instructions: "Watch parent events.",
      events: ["agent_settled", "tool_error"],
      responseMode: "text",
    });
    expect(actors.status(actor.id).events).toEqual(["agent_settled", "tool_error"]);

    await actors.setEvents(actor.id, ["input", "turn_end"]);
    expect(actors.status(actor.id).events).toEqual(["input", "turn_end"]);

    // An empty set pauses host-event reactivity without stopping the actor.
    await actors.setEvents(actor.id, []);
    expect(actors.status(actor.id).events).toEqual([]);
    expect(actors.status(actor.id).status).toBe("idle");

    // Duplicates are deduped, preserving first-seen order.
    await actors.setEvents(actor.id, ["agent_settled", "agent_settled"]);
    expect(actors.status(actor.id).events).toEqual(["agent_settled"]);
  });

  it("setEvents rejects an unsupported event", async () => {
    const { actors } = setup();
    const actor = await actors.create({
      name: "watcher",
      instructions: "Watch parent events.",
      responseMode: "text",
    });
    await expect(actors.setEvents(actor.id, ["bogus" as never])).rejects.toThrow(
      "Unsupported Fabric actor event",
    );
    expect(actors.status(actor.id).events).toEqual([]);
  });

  it("setEvents throws for an unknown actor", async () => {
    const { actors } = setup();
    await expect(actors.setEvents("nope", [])).rejects.toThrow("Unknown Fabric actor");
  });

  it("clearMessages resets an actor's recorded history without stopping it", async () => {
    const { actors } = setup();
    const actor = await actors.create({
      name: "reviewer",
      instructions: "Review messages and reply concisely.",
      responseMode: "text",
    });
    await actors.ask(actor.id, "Inspect auth");
    await waitFor(() => actors.status(actor.id).status === "idle");
    expect(actors.messages(actor.id).length).toBeGreaterThan(0);

    await actors.clearMessages(actor.id);
    expect(actors.messages(actor.id)).toEqual([]);
    // The actor is still alive and responsive.
    expect(actors.status(actor.id).status).toBe("idle");
    const reply = await actors.ask(actor.id, "Inspect auth");
    expect(reply.text).toBe("fake worker complete");
  });

  it("clearMessages throws for an unknown actor", async () => {
    const { actors } = setup();
    await expect(actors.clearMessages("nope")).rejects.toThrow("Unknown Fabric actor");
  });

  it("restarts the drain for successive coalesced host events without stranding an item", async () => {
    const { actors, deliveries } = setup();
    const actor = await actors.create({
      name: "advisor",
      instructions: "Advise only when useful.",
      events: ["agent_settled"],
      responseMode: "directive",
      delivery: "steer",
      coalesce: true,
    });
    // Each turn: the actor is idle when the event fires, so a run starts and
    // the drain exits before the next event. A regression in drain restart
    // (the "stuck at queue:1" race) would leave one of these stranded.
    for (let turn = 0; turn < 5; turn++) {
      expect(actors.dispatchHostEvent("agent_settled", { turn })).toBe(1);
      await waitFor(() => actors.status(actor.id).status === "idle");
    }
    expect(deliveries.length).toBe(5);
    expect(actors.status(actor.id)).toMatchObject({ status: "idle", queued: 0 });
  });

  it("processes a host event enqueued while a run is in flight", async () => {
    const { actors, deliveries } = setup();
    const actor = await actors.create({
      name: "advisor",
      instructions: "Advise only when useful.",
      events: ["agent_settled"],
      responseMode: "directive",
      delivery: "steer",
      coalesce: true,
    });
    expect(actors.dispatchHostEvent("agent_settled", { turn: 1 })).toBe(1);
    await waitFor(() => actors.status(actor.id).status === "running");
    // A second event arrives while the first run is in flight; the running
    // drain must pick it up on its next loop instead of stranding it.
    expect(actors.dispatchHostEvent("agent_settled", { turn: 2 })).toBe(1);
    await waitFor(() => actors.status(actor.id).status === "idle");
    expect(deliveries.length).toBe(2);
    expect(actors.status(actor.id).queued).toBe(0);
  });

  it("exposes the portable definition without history", async () => {
    const { actors } = setup();
    const actor = await actors.create({
      name: "reviewer",
      instructions: "Review code.",
      events: ["turn_end"],
      topics: ["team.review"],
      delivery: "steer",
      model: "anthropic/sonnet",
    });
    const def = actors.definition(actor.id);
    expect(def).toEqual({
      name: "reviewer",
      instructions: "Review code.",
      events: ["turn_end"],
      topics: ["team.review"],
      delivery: "steer",
      responseMode: "text",
      triggerTurn: false,
      coalesce: true,
      runner: "pi",
      model: "anthropic/sonnet",
    });
    // history never crosses the global⇄project boundary
    expect(def).not.toHaveProperty("id");
    expect(def).not.toHaveProperty("sessionFile");
    expect(def).not.toHaveProperty("messages");
  });

  it("reads and updates the default instruction", async () => {
    const { actors } = setup();
    const actor = await actors.create({ name: "advisor", instructions: "Advise." });
    expect(actors.instructions(actor.id)).toBe("Advise.");
    await actors.setInstructions(actor.id, "Advise only when useful.");
    expect(actors.instructions(actor.id)).toBe("Advise only when useful.");
    await expect(actors.setInstructions(actor.id, "   ")).rejects.toThrow(/empty/);
  });
});

describe("ActorManager steering relay", () => {
  const fakeWorker = path.resolve("tests/fixtures/fake-worker.mjs");

  const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for steer relay");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  it("steerRemote throws when the mesh is disabled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-relay-"));
    roots.push(root);
    const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 100);
    const subagents = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
      workerPath: fakeWorker,
      runRoot: path.join(root, "runs"),
    });
    subagentManagers.push(subagents);
    const disabledConfig = { ...DEFAULT_FABRIC_CONFIG.mesh, enabled: false, actorPollMs: 20 };
    const actors = new ActorManager(
      "test",
      { id: "session:t", name: "main", kind: "main" },
      mesh,
      disabledConfig,
      subagents,
      () => {},
      { actorRoot: path.join(root, "actors") },
    );
    actorManagers.push(actors);
    await expect(actors.steerRemote("anyone", "hi", "steer")).rejects.toThrow(/disabled/);
  });

  it("relays a fabric.steer event across processes to a remote subagent", async () => {
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-relay-"));
    roots.push(shared);
    const meshPath = path.join(shared, "mesh");
    const meshA = new MeshStore(meshPath, 64 * 1024, 100);
    const meshB = new MeshStore(meshPath, 64 * 1024, 100);
    const subagentsA = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
      workerPath: fakeWorker,
      runRoot: path.join(shared, "runsA"),
    });
    const subagentsB = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
      workerPath: fakeWorker,
      runRoot: path.join(shared, "runsB"),
    });
    subagentManagers.push(subagentsA, subagentsB);
    const cfg = { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 };
    const actorsA = new ActorManager(
      "a",
      { id: "session:a", name: "main", kind: "main", sessionId: "a" },
      meshA,
      cfg,
      subagentsA,
      () => {},
      { actorRoot: path.join(shared, "actorsA") },
    );
    const actorsB = new ActorManager(
      "b",
      { id: "session:b", name: "main", kind: "main", sessionId: "b" },
      meshB,
      cfg,
      subagentsB,
      () => {},
      { actorRoot: path.join(shared, "actorsB") },
    );
    actorManagers.push(actorsA, actorsB);

    // A owns a running subagent; B steers it by publishing over the shared mesh.
    const handle = await subagentsA.spawn({ task: "HANG", transport: "process" });
    const remote = await actorsB.steerRemote(handle.id, "redirect from B", "steer");
    expect(remote).toEqual({ queued: true, messageId: expect.any(String), routed: "mesh" });
    const steerFile = path.join(subagentsA.runDirectory(handle.id)!, "steer.jsonl");
    await waitFor(
      () => fs.existsSync(steerFile) && fs.readFileSync(steerFile, "utf8").includes("redirect from B"),
      3_000,
    );
    const forwarded = fs
      .readFileSync(steerFile, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ type: "steer", message: "redirect from B" });
    await subagentsA.stop(handle.id);
  });

  it("relays a cross-process follow-up to the owning Main session", async () => {
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-main-relay-"));
    roots.push(shared);
    const meshPath = path.join(shared, "mesh");
    const rootMesh = new MeshStore(meshPath, 64 * 1024, 100);
    const peerMesh = new MeshStore(meshPath, 64 * 1024, 100);
    const rootSubagents = new SubagentManager(
      process.cwd(),
      DEFAULT_FABRIC_CONFIG.subagents,
      { workerPath: fakeWorker, runRoot: path.join(shared, "root-runs") },
    );
    const peerSubagents = new SubagentManager(
      process.cwd(),
      DEFAULT_FABRIC_CONFIG.subagents,
      { workerPath: fakeWorker, runRoot: path.join(shared, "peer-runs") },
    );
    subagentManagers.push(rootSubagents, peerSubagents);
    const deliveries: FabricMainAgentDeliveryRequest[] = [];
    const mainAgent = {
      id: "session:root",
      local: true,
      matches: (id: string) => id === "main" || id === "session:root",
      info: () => ({
        id: "session:root",
        name: "Main" as const,
        kind: "main" as const,
        status: "idle" as const,
        runner: "pi" as const,
        transport: "host" as const,
        cwd: process.cwd(),
        startedAt: 1,
        updatedAt: 1,
        pendingMessages: false,
        local: true,
      }),
      deliverAgent: (request: FabricMainAgentDeliveryRequest) => {
        deliveries.push(request);
        return { queued: true as const, messageId: "main-1", routed: "main" as const };
      },
    };
    const cfg = { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 };
    const rootActors = new ActorManager(
      "root",
      { id: "session:root", name: "Main", kind: "main", sessionId: "root" },
      rootMesh,
      cfg,
      rootSubagents,
      () => {},
      { actorRoot: path.join(shared, "root-actors"), mainAgent },
    );
    const peerActors = new ActorManager(
      "peer",
      { id: "agent:peer", name: "peer", kind: "agent", sessionId: "peer" },
      peerMesh,
      cfg,
      peerSubagents,
      () => {},
      { actorRoot: path.join(shared, "peer-actors") },
    );
    actorManagers.push(rootActors, peerActors);

    await peerActors.steerRemote(
      "session:root",
      "summarize after implementation",
      "followUp",
      { requestedBy: "peer" },
    );
    await waitFor(() => deliveries.length === 1, 3_000);
    expect(deliveries).toMatchObject([
      {
        from: { id: "agent:peer", kind: "agent" },
        message: "summarize after implementation",
        delivery: "followUp",
        data: { requestedBy: "peer" },
      },
    ]);
  });

  it("relays a fabric.steer event to a local actor as a mailbox message", async () => {
    const { actors, mesh } = setup();
    const actor = await actors.create({
      name: "target",
      instructions: "reply",
      responseMode: "text",
    });
    // Simulate a remote peer publishing a steer addressed to this actor.
    await mesh.publish({
      topic: "fabric.steer",
      kind: "steer",
      from: { id: "peer", name: "peer", kind: "actor" },
      to: actor.id,
      text: "from a peer",
    });
    await waitFor(
      () =>
        actors
          .messages(actor.id)
          .some(
            (message) =>
              message.direction === "in" &&
              (message.data as { message?: string } | undefined)?.message === "from a peer",
          ),
      3_000,
    );
    await waitFor(() => actors.status(actor.id).status === "idle");
    expect(actors.messages(actor.id).some((message) => message.direction === "out")).toBe(true);
  });
});

describe("ActorManager extensions flag (read-only Pi actors)", () => {
    it("runs a read-only Pi actor (extensions:false) without fabric_exec or recursion", async () => {
      const { actors, subagents } = setup();
      const runSpy = vi.spyOn(subagents, "run");
      const actor = await actors.create({
        name: "readonly-nav",
        instructions: "Read-only navigator.",
        runner: "pi",
        extensions: false,
        tools: ["read"],
        responseMode: "text",
      });
      expect(actor.extensions).toBe(false);
      await actors.ask(actor.id, "probe");
      const request = runSpy.mock.calls[0]?.[0] as Partial<{ extensions: boolean; recursive: boolean }> | undefined;
      expect(request?.extensions).toBe(false);
      expect(request?.recursive).toBe(false);
    });

    it("defaults to Fabric-enabled (extensions true, recursive true) for a Pi actor", async () => {
      const { actors, subagents } = setup();
      const runSpy = vi.spyOn(subagents, "run");
      const actor = await actors.create({
        name: "default-nav",
        instructions: "Default navigator.",
        runner: "pi",
        responseMode: "text",
      });
      expect(actor.extensions).toBeUndefined();
      await actors.ask(actor.id, "probe");
      const request = runSpy.mock.calls[0]?.[0] as Partial<{ extensions: boolean; recursive: boolean }> | undefined;
      expect(request?.extensions).toBe(true);
      expect(request?.recursive).toBe(true);
    });

    it("persists extensions:false across close and restore", async () => {
      const setupState = setup(true);
      const created = await setupState.actors.create({
        name: "persistent-readonly",
        instructions: "Survive restart read-only.",
        runner: "pi",
        extensions: false,
        tools: ["read"],
        responseMode: "text",
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
      const runSpy = vi.spyOn(setupState.subagents, "run");
      expect(restored.list().find((a) => a.name === "persistent-readonly")?.extensions).toBe(false);
      await restored.ask(created.id, "probe");
      const request = runSpy.mock.calls[0]?.[0] as Partial<{ extensions: boolean; recursive: boolean }> | undefined;
      expect(request?.extensions).toBe(false);
      expect(request?.recursive).toBe(false);
    });
});
