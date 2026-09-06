import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { FabricState } from "../src/fabric-state.js";
import type { FabricComponentDefinition, FabricProvider } from "../src/protocol.js";

const contextAt = (cwd: string, sessionId = "session-1"): ExtensionContext => ({
  cwd,
  isProjectTrusted: () => true,
  sessionManager: { getSessionId: () => sessionId },
  ui: { setStatus: vi.fn() },
} as unknown as ExtensionContext);

const project = (config: Record<string, unknown> = {}): string => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-bootstrap-"));
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "fabric.json"), JSON.stringify(config));
  return cwd;
};

const runtimeHarness = () => {
  const instances: FakeRuntime[] = [];
  let release: (() => void) | undefined;
  let blocked = false;
  let initializeFailures = 0;
  let registrationFailures = 0;
  class FakeRuntime {
    initialized = false;
    widgetDismissedAt = 0;
    initialize = vi.fn(async () => {
      if (blocked) await new Promise<void>((resolve) => { release = resolve; });
      this.initialized = true;
      if (initializeFailures > 0) {
        initializeFailures--;
        throw new Error("initialize failed");
      }
    });
    shutdown = vi.fn(async () => { this.initialized = false; });
    registerExternal = vi.fn(() => {
      if (registrationFailures > 0) {
        registrationFailures--;
        throw new Error("provider replay failed");
      }
    });
    constructor() { instances.push(this); }
  }
  return {
    instances,
    loader: vi.fn(async () => ({ FabricRuntimeState: FakeRuntime })) as never,
    block() { blocked = true; },
    release() { blocked = false; release?.(); },
    failInitialize() { initializeFailures++; },
    failRegistration() { registrationFailures++; },
  };
};

const createState = (loader: never): FabricState => new FabricState(
  {} as ExtensionAPI,
  new CapturedToolCatalog(),
  { runtimeLoader: loader },
);

describe("FabricState lazy bootstrap", () => {
  it("loads normalized turn policy without importing or constructing the runtime", async () => {
    const cwd = project({
      fullCodeMode: false,
      capture: { enabled: true, hideFromModel: true },
      schema: { mode: "audit" },
      prewalk: { alwaysRearm: false },
      mesh: { enabled: false },
    });
    const harness = runtimeHarness();
    const state = createState(harness.loader);

    await state.bootstrap(contextAt(cwd));

    expect(state.initialized).toBe(false);
    expect(state.config.fullCodeMode).toBe(false);
    expect(state.config.capture).toMatchObject({ enabled: true, hideFromModel: true });
    expect(state.config.schema.mode).toBe("audit");
    expect(harness.loader).not.toHaveBeenCalled();
    expect(harness.instances).toHaveLength(0);
  });

  it.each(["typescript", "python"] as const)("pins %s until resources can reload, including config revert and initialize", async (kernel) => {
    vi.stubEnv("PI_FABRIC_KERNEL", undefined);
    const nextKernel = kernel === "python" ? "typescript" : "python";
    const cwd = project({ executor: { kernel }, mesh: { enabled: false } });
    const context = contextAt(cwd);
    const harness = runtimeHarness();
    const state = createState(harness.loader);
    const persist = (selected: string) => fs.writeFileSync(path.join(cwd, ".pi", "fabric.json"), JSON.stringify({ executor: { kernel: selected }, mesh: { enabled: false } }));
    try {
      await state.bootstrap(context);
      persist(nextKernel);
      state.reloadConfig(context);
      expect(state.config.executor.kernel).toBe(kernel);
      expect(state.kernelReloadRequired).toBe(true);
      persist(kernel);
      state.reloadConfig(context);
      expect(state.kernelReloadRequired).toBe(false);
      persist(nextKernel);
      await state.initialize(context);
      expect(state.config.executor.kernel).toBe(kernel);
      expect(state.kernelReloadRequired).toBe(true);
      const replacement = createState(harness.loader);
      await replacement.bootstrap(context);
      expect(replacement.config.executor.kernel).toBe(nextKernel);
      expect(replacement.kernelReloadRequired).toBe(false);
    } finally {
      await state.shutdown();
      fs.rmSync(cwd, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it("uses one activation for concurrent callers and never reloads after activation", async () => {
    const cwd = project({ prewalk: { alwaysRearm: false }, mesh: { enabled: false } });
    const harness = runtimeHarness();
    harness.block();
    const state = createState(harness.loader);
    const context = contextAt(cwd);
    await state.bootstrap(context);

    const first = state.ensure(context);
    const second = state.ensure(context);
    await vi.waitFor(() => expect(harness.instances).toHaveLength(1));
    harness.release();
    await Promise.all([first, second]);
    await state.ensure(context);

    expect(harness.loader).toHaveBeenCalledTimes(1);
    expect(harness.instances[0]?.initialize).toHaveBeenCalledTimes(1);
  });

  it("reserves every first-party provider and provider-component identity before activation", () => {
    const state = createState(runtimeHarness().loader);
    for (const name of [
      "pi",
      "extensions",
      "mcp",
      "mesh",
      "state",
      "schema",
      "compact",
      "agents",
      "memory",
    ]) {
      expect(() => state.registerExternal({ name } as FabricProvider)).toThrow(
        `Reserved Fabric provider name: ${name}`,
      );
    }
    expect(() => state.registerExternalComponent({
      name: "fabric.provider.memory",
    } as FabricComponentDefinition)).toThrow(
      "Reserved Fabric component name: fabric.provider.memory",
    );
  });

  it("replays providers registered before activation", async () => {
    const cwd = project({ prewalk: { alwaysRearm: false }, mesh: { enabled: false } });
    const harness = runtimeHarness();
    const state = createState(harness.loader);
    const provider = {
      name: "example",
      description: "example",
      list: vi.fn(),
      describe: vi.fn(),
      invoke: vi.fn(),
    } as unknown as FabricProvider;
    state.registerExternal(provider);
    const context = contextAt(cwd);

    await state.bootstrap(context);
    await state.ensure(context);

    expect(harness.instances[0]?.registerExternal).toHaveBeenCalledWith(
      provider,
      { overwrite: true },
    );
  });

  it("eagerly detects always-rearm and only nonempty valid actor registries", async () => {
    const prewalkCwd = project({ prewalk: { alwaysRearm: true }, mesh: { enabled: false } });
    const prewalkState = createState(runtimeHarness().loader);
    const prewalkContext = contextAt(prewalkCwd);
    await prewalkState.bootstrap(prewalkContext);
    expect(prewalkState.shouldEagerlyActivate(prewalkContext)).toBe(true);

    const actorCwd = project({ prewalk: { alwaysRearm: false }, mesh: { enabled: true } });
    const actorDirectory = path.join(actorCwd, ".pi", "fabric", "mesh", "actors");
    const registryPath = path.join(actorDirectory, "actors.json");
    fs.mkdirSync(actorDirectory, { recursive: true });
    const actorState = createState(runtimeHarness().loader);
    const actorContext = contextAt(actorCwd);
    await actorState.bootstrap(actorContext);
    vi.stubEnv("PI_FABRIC_ACTOR_ID", "");
    vi.stubEnv("PI_FABRIC_PARENT_RUN", "");
    vi.stubEnv("PI_FABRIC_MESH_ROOT", path.join(actorCwd, ".pi", "fabric", "mesh"));

    fs.writeFileSync(registryPath, JSON.stringify({ actors: [] }));
    expect(actorState.shouldEagerlyActivate(actorContext)).toBe(false);
    fs.writeFileSync(registryPath, JSON.stringify({ actors: [{}] }));
    expect(actorState.shouldEagerlyActivate(actorContext)).toBe(false);
    fs.writeFileSync(registryPath, JSON.stringify({
      actors: [{
        id: "a".repeat(32),
        name: "reviewer",
        instructions: "Review changes",
        createdAt: Date.now(),
      }],
    }));
    expect(actorState.shouldEagerlyActivate(actorContext)).toBe(true);

    fs.writeFileSync(registryPath, JSON.stringify({ actors: [] }));
    vi.stubEnv("PI_FABRIC_SESSION_ID", "root-session");
    const sessionActorDirectory = path.join(actorDirectory, "root-session");
    fs.mkdirSync(sessionActorDirectory, { recursive: true });
    fs.writeFileSync(path.join(sessionActorDirectory, "actors.json"), JSON.stringify({
      actors: [{
        id: "b".repeat(32),
        name: "session reviewer",
        instructions: "Review this root session",
        createdAt: Date.now(),
      }],
    }));
    expect(actorState.shouldEagerlyActivate(actorContext)).toBe(true);
    vi.unstubAllEnvs();
  });

  it("eagerly activates configured components before the first turn", async () => {
    const cwd = project({
      components: [{ id: "model-guidance", component: "model-guidance" }],
      prewalk: { alwaysRearm: false },
      mesh: { enabled: false },
    });
    const state = createState(runtimeHarness().loader);
    const context = contextAt(cwd);
    await state.bootstrap(context);
    expect(state.shouldEagerlyActivate(context)).toBe(true);
  });

  it("eagerly activates child runtimes with inherited capability commitments", async () => {
    const cwd = project({ prewalk: { alwaysRearm: false }, mesh: { enabled: false } });
    const state = createState(runtimeHarness().loader);
    const context = contextAt(cwd);
    await state.bootstrap(context);
    vi.stubEnv("PI_FABRIC_CAPABILITY_REQUIREMENTS", JSON.stringify(["memory.recall"]));
    vi.stubEnv("PI_FABRIC_CAPABILITY_DIGEST", "semantic-digest");
    expect(state.shouldEagerlyActivate(context)).toBe(true);
    vi.unstubAllEnvs();
  });

  it("does not probe persisted actors from nested actor or agent identities", async () => {
    const cwd = project({ prewalk: { alwaysRearm: false }, mesh: { enabled: true } });
    const actorDirectory = path.join(cwd, ".pi", "fabric", "mesh", "actors");
    fs.mkdirSync(actorDirectory, { recursive: true });
    fs.writeFileSync(path.join(actorDirectory, "actors.json"), JSON.stringify({
      actors: [{ id: "b".repeat(32), name: "nested", instructions: "work", createdAt: 1 }],
    }));
    const state = createState(runtimeHarness().loader);
    const context = contextAt(cwd);
    await state.bootstrap(context);
    vi.stubEnv("PI_FABRIC_MESH_ROOT", path.join(cwd, ".pi", "fabric", "mesh"));

    vi.stubEnv("PI_FABRIC_ACTOR_ID", "actor-child");
    expect(state.shouldEagerlyActivate(context)).toBe(false);
    vi.stubEnv("PI_FABRIC_ACTOR_ID", "");
    vi.stubEnv("PI_FABRIC_PARENT_RUN", "agent-child");
    expect(state.shouldEagerlyActivate(context)).toBe(false);
    vi.stubEnv("PI_FABRIC_PARENT_RUN", "");
    expect(state.shouldEagerlyActivate(context)).toBe(true);
    vi.unstubAllEnvs();
  });

  it("cleans failed activation and retries with a fresh runtime", async () => {
    const cwd = project({ prewalk: { alwaysRearm: false }, mesh: { enabled: false } });
    const harness = runtimeHarness();
    harness.failInitialize();
    const state = createState(harness.loader);
    const context = contextAt(cwd);
    await state.bootstrap(context);

    await expect(state.ensure(context)).rejects.toThrow("initialize failed");
    expect(harness.instances[0]?.shutdown).toHaveBeenCalledTimes(1);
    expect(state.initialized).toBe(false);

    await state.ensure(context);
    expect(harness.instances).toHaveLength(2);
    expect(state.initialized).toBe(true);
  });

  it("replays providers before hooks and rolls back hook side effects on failure", async () => {
    const cwd = project({ prewalk: { alwaysRearm: false }, mesh: { enabled: false } });
    const harness = runtimeHarness();
    harness.failRegistration();
    const state = createState(harness.loader);
    const context = contextAt(cwd);
    state.registerExternal({ name: "example" } as FabricProvider);
    const cleanup = vi.fn();
    await state.bootstrap(context);

    state.setActivationHook(vi.fn(), cleanup);
    await expect(state.ensure(context)).rejects.toThrow("provider replay failed");
    expect(harness.instances[0]?.shutdown).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);

    state.setActivationHook(() => {
      expect(harness.instances[1]?.registerExternal).toHaveBeenCalledTimes(1);
      throw new Error("hook failed");
    }, cleanup);
    await expect(state.ensure(context)).rejects.toThrow("hook failed");
    expect(harness.instances[1]?.shutdown).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(2);

    state.setActivationHook(() => undefined, cleanup);
    await state.ensure(context);
    expect(harness.instances).toHaveLength(3);
    expect(state.initialized).toBe(true);
  });

  it("invalidates and cleans an activation whose hook finishes during shutdown", async () => {
    const cwd = project({ prewalk: { alwaysRearm: false }, mesh: { enabled: false } });
    const harness = runtimeHarness();
    const state = createState(harness.loader);
    const context = contextAt(cwd);
    await state.bootstrap(context);
    let releaseHook: (() => void) | undefined;
    const hookStarted = vi.fn();
    const cleanup = vi.fn();
    state.setActivationHook(async () => {
      hookStarted();
      await new Promise<void>((resolve) => { releaseHook = resolve; });
    }, cleanup);

    const activation = state.ensure(context);
    await vi.waitFor(() => expect(hookStarted).toHaveBeenCalledTimes(1));
    const shutdown = state.shutdown();
    releaseHook?.();

    await expect(activation).rejects.toThrow("superseded");
    await shutdown;
    expect(harness.instances[0]?.shutdown).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(state.initialized).toBe(false);
  });

  it("closes stale activation during shutdown and reinitializes on session switch", async () => {
    const firstCwd = project({ prewalk: { alwaysRearm: false }, mesh: { enabled: false } });
    const secondCwd = project({ prewalk: { alwaysRearm: false }, mesh: { enabled: false } });
    const harness = runtimeHarness();
    const state = createState(harness.loader);
    const firstContext = contextAt(firstCwd, "first");
    await state.bootstrap(firstContext);
    await state.ensure(firstContext);
    const runtime = harness.instances[0]!;

    await state.bootstrap(contextAt(secondCwd, "second"));
    expect(runtime.initialize).toHaveBeenCalledTimes(2);

    await state.shutdown();
    expect(runtime.shutdown).toHaveBeenCalled();
    expect(state.initialized).toBe(false);
  });
});
