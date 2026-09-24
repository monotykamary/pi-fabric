import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { buildClaudeArguments } from "../src/agents/claude-cli.js";
import { AgentManager } from "../src/agents/manager.js";
import { ActorManager } from "../src/actors/manager.js";
import { GlobalActorRegistry } from "../src/actors/global-registry.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { AgentsProvider } from "../src/providers/agents-provider.js";
import { FabricControlPlane } from "../src/topology/control-plane.js";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";
import { LifecycleBroker } from "../src/lifecycle/broker.js";
import type { FabricAgentConfig, FabricModelsConfig } from "../src/config.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import type { FabricLifecycleEvent, FabricLifecycleSubscription } from "../src/lifecycle/types.js";
import type { FabricMainAgentDeliveryRequest, FabricMainAgentTarget } from "../src/main-agent.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import type { FabricParticipantInfo, FabricParticipantSource, FabricPeerInfo } from "../src/topology/types.js";
import { parseWorkerOptions } from "../src/worker/options.js";

const roots: string[] = [];
const managers: AgentManager[] = [];
const actorManagers: ActorManager[] = [];
const controlPlanes: FabricControlPlane[] = [];

afterEach(async () => {
  await Promise.all(controlPlanes.splice(0).map((c) => c.close()));
  await Promise.all(actorManagers.splice(0).map((m) => m.close()));
  await Promise.all(managers.splice(0).map((m) => m.close()));
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

// --- Helper: build minimal worker argv with optional overrides ---
const argv = (overrides: Record<string, string> = {}) => [
  "node", "worker.js",
  ...Object.entries({
    id: "persist-probe", name: "probe", runner: "pi", "task-file": "task.txt",
    "status-file": "status.json", "lifecycle-file": "lifecycle.jsonl", "log-file": "events.jsonl",
    cwd: process.cwd(), "pi-binary": "pi", "claude-binary": "claude", "veda-binary": "veda",
    "veda-backend": "agy", "veda-persona": "navigator-chat", "timeout-ms": "5000", depth: "1",
    "full-code-mode": "true", extensions: "true", tools: "[]", "granted-risks": "[]", transport: "process",
    ...overrides,
  }).flatMap(([key, value]) => [`--${key}`, value]),
];

const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const visiblePiModels = [{ provider: "anthropic", id: "executor", name: "Executor" }];
const visibleModelRegistry = {
  getAvailable: () => visiblePiModels,
  find: (p: string, i: string) => visiblePiModels.find((m) => m.provider === p && m.id === i),
};

const invocationContext = (): FabricInvocationContext => ({
  cwd: process.cwd(), signal: undefined, parentToolCallId: "test", nestedToolCallId: "nested",
  extensionContext: { modelRegistry: visibleModelRegistry } as unknown as ExtensionContext,
  update() {}, activity() {},
});

const createProvider = () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-persist-"));
  roots.push(rootDir);
  const mesh = new MeshStore(path.join(rootDir, "mesh"), 64 * 1024, 100);
  const agents = new AgentManager(
    process.cwd(), DEFAULT_FABRIC_CONFIG.agents,
    {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      claudeBinary: path.resolve("tests/fixtures/fake-claude.mjs"),
      vedaBinary: path.resolve("tests/fixtures/fake-veda.mjs"),
      runRoot: path.join(rootDir, "runs"),
    },
  );
  managers.push(agents);
  const identity: MeshIdentity = { id: "session:test", name: "main", kind: "main", sessionId: "test" };
  const meshConfig = { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 };
  const mainDeliveries: FabricMainAgentDeliveryRequest[] = [];
  const mainAgent = {
    id: identity.id, local: true,
    matches: (id: string) => id === "main" || id === identity.id,
    info: () => ({
      id: identity.id, name: "Main" as const, kind: "main" as const, status: "idle" as const,
      runner: "pi" as const, transport: "host" as const, cwd: process.cwd(), sessionId: "test",
      startedAt: 1, updatedAt: 1, pendingMessages: false, local: true,
    }),
    deliverAgent: (req: FabricMainAgentDeliveryRequest) => {
      mainDeliveries.push(req);
      return { queued: true as const, messageId: "msg-1", routed: "main" as const };
    },
  };
  const actors = new ActorManager("test", identity, mesh, meshConfig, agents, () => {}, {
    actorRoot: path.join(rootDir, "actors"), persistent: true, mainAgent,
  });
  actorManagers.push(actors);
  const globalActors = new GlobalActorRegistry(rootDir, 64 * 1024);
  const participants: FabricParticipantSource = {
    list: () => [], get: () => undefined,
    self: () => ({
      format: 1, id: identity.id, kind: "root", rootId: identity.id,
      ownerHostId: identity.id, ownerIdentityId: identity.id, name: "main",
      status: "idle", runner: "pi", transport: "host", capabilities: [],
      cwd: process.cwd(), sessionId: "test", startedAt: 1, updatedAt: 1,
      pendingMessages: false, controlProtocol: "v1", local: true, stale: false,
    }),
    peers: () => [], async refresh() {}, scheduleRefresh() {},
  };
  const lifecycle = new LifecycleBroker(mesh, identity, participants, { enabled: true, pollMs: 20, maxReadEvents: 100 }, async () => {});
  const provider = new AgentsProvider(agents, actors, globalActors, mainAgent, participants, undefined, lifecycle, undefined, undefined, undefined, () => DEFAULT_FABRIC_CONFIG.models);
  return { rootDir, mesh, identity, agents, actors, globalActors, provider, mainDeliveries };
};

describe("persistSession: schema exposure", () => {
  it("exposes persistSession as boolean on agents.run and agents.spawn schemas", async () => {
    const { provider } = createProvider();
    const runDesc = await provider.describe("run", invocationContext());
    const spawnDesc = await provider.describe("spawn", invocationContext());
    const props = (d: typeof runDesc) => (d?.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props(runDesc).persistSession).toMatchObject({ type: "boolean" });
    expect(props(spawnDesc).persistSession).toMatchObject({ type: "boolean" });
  });
});

describe("persistSession: guest type declarations", () => {
  it("accepts persistSession on agents.run in guest code", () => {
    const result = typeCheckFabricCode(
      `const r = await agents.run({ task: "do something", persistSession: true }); return r.status;`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("accepts persistSession: false in guest code", () => {
    const result = typeCheckFabricCode(
      `const r = await agents.run({ task: "do something", persistSession: false }); return r.status;`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });
});

describe("persistSession: AgentManager runner guard", () => {
  it("rejects persistSession:true for the Pi runner before launch", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-persist-"));
    roots.push(rootDir);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: rootDir,
    });
    managers.push(manager);
    await expect(
      manager.run({ task: "test", runner: "pi", persistSession: true, transport: "process" }),
    ).rejects.toThrow("persistSession is only supported by the Claude runner");
  });

  it("rejects persistSession:true for the Veda runner before launch", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-persist-"));
    roots.push(rootDir);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: rootDir,
    });
    managers.push(manager);
    await expect(
      manager.run({ task: "test", runner: "veda", persistSession: true, transport: "process" }),
    ).rejects.toThrow("persistSession is only supported by the Claude runner");
  });

  it("allows persistSession:true for the Claude runner", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-persist-"));
    roots.push(rootDir);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      claudeBinary: path.resolve("tests/fixtures/fake-claude.mjs"),
      runRoot: rootDir,
    });
    managers.push(manager);
    const result = await manager.run({
      task: "test",
      runner: "claude",
      persistSession: true,
      transport: "process",
    });
    expect(result.status).toBe("completed");
  });

  it("defaults persistSession to false (no flag error when omitted)", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-persist-"));
    roots.push(rootDir);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: rootDir,
    });
    managers.push(manager);
    const result = await manager.run({ task: "test", transport: "process" });
    expect(result.status).toBe("completed");
  });
});

describe("persistSession: worker option parsing", () => {
  it("accepts --persist-session true with Claude runner", () => {
    const opts = parseWorkerOptions(argv({ runner: "claude", "persist-session": "true" }));
    expect(opts.persistSession).toBe(true);
  });

  it("accepts --persist-session false with Claude runner", () => {
    const opts = parseWorkerOptions(argv({ runner: "claude", "persist-session": "false" }));
    expect(opts.persistSession).toBeUndefined();
  });

  it("does not set persistSession when the flag is absent", () => {
    const opts = parseWorkerOptions(argv({ runner: "claude" }));
    expect(opts.persistSession).toBeUndefined();
  });

  it("rejects malformed --persist-session values", () => {
    expect(() => parseWorkerOptions(argv({ "persist-session": "yes" }))).toThrow("Invalid worker persist-session flag");
    expect(() => parseWorkerOptions(argv({ "persist-session": "1" }))).toThrow("Invalid worker persist-session flag");
    // Empty string is treated as absent by optional()'s falsy guard, so no validation error.
    const emptyParsed = parseWorkerOptions(argv({ "persist-session": "" }));
    expect(emptyParsed.persistSession).toBeUndefined();
  });

  it("rejects --persist-session true for non-Claude runners", () => {
    expect(() => parseWorkerOptions(argv({ runner: "pi", "persist-session": "true" }))).toThrow("Worker persist-session requires the Claude runner");
    expect(() => parseWorkerOptions(argv({ runner: "veda", "persist-session": "true" }))).toThrow("Worker persist-session requires the Claude runner");
  });

  it("allows --persist-session false for any runner", () => {
    const piOpts = parseWorkerOptions(argv({ runner: "pi", "persist-session": "false" }));
    const vedaOpts = parseWorkerOptions(argv({ runner: "veda", "persist-session": "false" }));
    expect(piOpts.persistSession).toBeUndefined();
    expect(vedaOpts.persistSession).toBeUndefined();
  });
});

describe("persistSession: provider invoke integration", () => {
  it("agents.run preserves persistSession:true through invoke into the launch request", async () => {
    const { provider, agents } = createProvider();
    // Spy on manager.spawn to inspect the normalized request
    const origSpawn = agents.spawn.bind(agents);
    let capturedRequest: any;
    agents.spawn = function (request, signal) {
      capturedRequest = request;
      return origSpawn(request, signal);
    };
    const ctx = invocationContext();
    const result = (await provider.invoke("run", {
      task: "test",
      runner: "claude",
      persistSession: true,
    }, ctx)) as { status: string };
    expect(capturedRequest.persistSession).toBe(true);
    expect(result.status).toBe("completed");
  });

  it("agents.spawn preserves persistSession:true through invoke into the launch request", async () => {
    const { provider, agents } = createProvider();
    const origSpawn = agents.spawn.bind(agents);
    let capturedRequest: any;
    agents.spawn = function (request, signal) {
      capturedRequest = request;
      return origSpawn(request, signal);
    };
    const ctx = invocationContext();
    const handle = (await provider.invoke("spawn", {
      task: "test",
      runner: "claude",
      persistSession: true,
    }, ctx)) as { id: string };
    expect(capturedRequest.persistSession).toBe(true);
    expect(handle.id).toBeDefined();
  });

  it("agents.run does not set persistSession when omitted", async () => {
    const { provider, agents } = createProvider();
    const origSpawn = agents.spawn.bind(agents);
    let capturedRequest: any;
    agents.spawn = function (request, signal) {
      capturedRequest = request;
      return origSpawn(request, signal);
    };
    const ctx = invocationContext();
    await provider.invoke("run", {
      task: "test",
      runner: "claude",
    }, ctx);
    expect(capturedRequest.persistSession).toBeUndefined();
  });

  it("agents.run rejects persistSession:true for non-claude runners via invoke", async () => {
    const { provider } = createProvider();
    const ctx = invocationContext();
    await expect(
      provider.invoke("run", {
        task: "test",
        runner: "pi",
        persistSession: true,
      }, ctx),
    ).rejects.toThrow("persistSession is only supported by the Claude runner");
  });
});

describe("persistSession: Claude CLI default-off / opt-in", () => {
  it("disables transcript persistence by default", () => {
    const args = buildClaudeArguments({ tools: ["read"], extensions: false, persistentSession: false });
    expect(args).toContain("--no-session-persistence");
  });

  it("omits the disable flag when explicitly opted in", () => {
    const args = buildClaudeArguments({ tools: ["read"], extensions: false, persistentSession: true });
    expect(args).not.toContain("--no-session-persistence");
  });
});
