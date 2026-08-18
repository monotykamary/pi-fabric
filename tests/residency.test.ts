import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActorManager } from "../src/actors/manager.js";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import type { FabricMainAgentDeliveryRequest, FabricMainAgentTarget } from "../src/main-agent.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { ResidencyClient } from "../src/residency/client.js";
import {
  RESIDENT_HOST_FORMAT,
  residentDeliveryPrefix,
  residentHostId,
  residentRoot,
  type ResidentHostConfig,
  type ResidentHostOwner,
} from "../src/residency/protocol.js";
import { FabricControlPlane } from "../src/topology/control-plane.js";
import { ParticipantDirectory } from "../src/topology/participant-directory.js";
import { actorParticipantRecord } from "../src/topology/records.js";
import type { FabricParticipantSource } from "../src/topology/types.js";

const repo = process.cwd();
const hostPath = path.resolve("dist/residency/host.js");
const fakeWorker = path.resolve("tests/fixtures/fake-worker.mjs");
const hasResidentHost = fs.existsSync(hostPath);
const roots: string[] = [];

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, timeoutMs = 7_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for durable residency state");
    await delay(25);
  }
};

const mainTarget = (
  identity: MeshIdentity,
  deliveries: FabricMainAgentDeliveryRequest[],
): FabricMainAgentTarget => ({
  id: identity.id,
  local: true,
  matches: (id) => id === "main" || id === identity.id,
  info: () => {
    throw new Error("not used by residency tests");
  },
  deliverAgent: (request) => {
    deliveries.push(request);
    return { queued: true, messageId: randomId(), routed: "main" };
  },
});

const randomId = (): string => Math.random().toString(16).slice(2);

interface RootHarness {
  root: string;
  mesh: MeshStore;
  meshConfig: typeof DEFAULT_FABRIC_CONFIG.mesh;
  identity: MeshIdentity;
  participants: ParticipantDirectory;
  mainAgent: FabricMainAgentTarget;
  deliveries: FabricMainAgentDeliveryRequest[];
  config: ResidentHostConfig;
}

const rootHarness = async (name: string): Promise<RootHarness> => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fabric-${name}-`));
  roots.push(root);
  const meshRoot = path.join(root, "mesh");
  const meshConfig = { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 };
  const mesh = new MeshStore(meshRoot, meshConfig.maxEventBytes, meshConfig.maxReadEvents);
  const identity: MeshIdentity = {
    id: `session:${name}:${randomId()}`,
    name: "main",
    kind: "main",
    sessionId: name,
  };
  const participants = new ParticipantDirectory(mesh, {
    enabled: true,
    hostId: identity.id,
    rootId: identity.id,
    identity,
    heartbeatMs: 50,
    leaseMs: 300,
  });
  participants.registerSource(() => [{
    format: 1,
    id: identity.id,
    kind: "root",
    rootId: identity.id,
    ownerHostId: identity.id,
    ownerIdentityId: identity.id,
    name: "main",
    status: "idle",
    residency: "session",
    runner: "pi",
    transport: "host",
    capabilities: ["steer", "followUp", "fabric"],
    cwd: repo,
    sessionId: name,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    controlProtocol: "v1",
  }]);
  await participants.start();
  const residencyRoot = residentRoot(meshRoot, identity.id);
  const deliveries: FabricMainAgentDeliveryRequest[] = [];
  return {
    root,
    mesh,
    meshConfig,
    identity,
    participants,
    mainAgent: mainTarget(identity, deliveries),
    deliveries,
    config: {
      format: RESIDENT_HOST_FORMAT,
      rootId: identity.id,
      sessionId: name,
      cwd: repo,
      projectRoot: repo,
      meshRoot,
      actorRoot: path.join(meshRoot, "actors"),
      residencyRoot,
      fullCodeMode: true,
      agents: { ...DEFAULT_FABRIC_CONFIG.agents, timeoutMs: 10_000 },
      mesh: meshConfig,
      retention: DEFAULT_FABRIC_CONFIG.retention,
      workerPath: fakeWorker,
      fabricExtensionPath: path.resolve("dist/index.js"),
      piBinary: "pi",
      claudeBinary: "claude",
      vedaBinary: "veda",
    },
  };
};

const stopResident = async (config: ResidentHostConfig): Promise<void> => {
  const ownerPath = path.join(config.residencyRoot, "owner.json");
  const owner = (() => {
    try {
      return JSON.parse(fs.readFileSync(ownerPath, "utf8")) as ResidentHostOwner;
    } catch {
      return undefined;
    }
  })();
  if (owner?.pid) {
    try {
      process.kill(owner.pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
    await waitFor(() => !fs.existsSync(ownerPath)).catch(() => undefined);
  }
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const residencyDirectory = path.join(root, "mesh", "residency");
    try {
      for (const entry of fs.readdirSync(residencyDirectory)) {
        const config = JSON.parse(
          fs.readFileSync(path.join(residencyDirectory, entry, "config.json"), "utf8"),
        ) as ResidentHostConfig;
        await stopResident(config);
      }
    } catch {
      // No resident host was created.
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("durable cwd validation", () => {
  it("rejects recursive cwd before creating a resident host or request", async () => {
    const state = await rootHarness("resident-cwd-rejection");
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath,
    });

    try {
      await expect(
        client.spawnAgent({
          task: "must remain recursive",
          cwd: state.root,
          recursive: true,
          residency: "durable",
        }),
      ).rejects.toThrow(/only for non-recursive agents/);
      expect(fs.existsSync(path.join(state.config.residencyRoot, "owner.json"))).toBe(false);
      expect(fs.existsSync(path.join(state.config.residencyRoot, "requests"))).toBe(false);
    } finally {
      await client.close();
      await state.participants.close();
    }
  });
});

describe.skipIf(!hasResidentHost)("durable participant residency", () => {
  it("keeps a durable actor responsive after its originating Main closes", { timeout: 20_000 }, async () => {
    const state = await rootHarness("resident-actor");
    const agents = new AgentManager(repo, state.config.agents, {
      workerPath: fakeWorker,
      runRoot: path.join(state.root, "parent-runs"),
      mainAgentId: state.identity.id,
      meshRoot: state.config.meshRoot,
      projectRoot: repo,
      hostId: state.identity.id,
      identityId: state.identity.id,
    });
    const canManage = (id: string): boolean | undefined => {
      const participant = state.participants.get(id);
      return participant ? participant.ownerHostId === state.identity.id : undefined;
    };
    const actors = new ActorManager(
      state.config.sessionId,
      state.identity,
      state.mesh,
      state.meshConfig,
      agents,
      () => {},
      {
        actorRoot: state.config.actorRoot,
        persistent: true,
        canManageActor: canManage,
        claimResidency: "session",
        rootId: state.identity.id,
      },
    );
    state.participants.registerSource(() =>
      actors.listOwned().map((actor) =>
        actorParticipantRecord(
          actor,
          state.identity.id,
          state.identity.id,
          state.identity.id,
          state.identity.id,
        ),
      ),
    );
    actors.subscribe(() => state.participants.scheduleRefresh());
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath,
    });
    const actor = await actors.create({
      name: "resident actor",
      instructions: "Persist across Main shutdown.",
      residency: "durable",
      delivery: "mailbox",
    });
    await actors.cede(actor.id);
    await state.participants.refresh();
    await client.ensureActor(actor.id);

    const messageCount = (): number => {
      const registry = JSON.parse(
        fs.readFileSync(path.join(state.config.actorRoot, "actors.json"), "utf8"),
      ) as { actors: Array<{ id: string; messages?: unknown[] }> };
      return registry.actors.find((candidate) => candidate.id === actor.id)?.messages?.length ?? 0;
    };
    const originalControl = new FabricControlPlane(state.mesh, state.identity, {
      enabled: true,
      hostId: state.identity.id,
      pollMs: 20,
      acknowledgementTimeoutMs: 3_000,
    });
    originalControl.start(() => ({ accepted: false }));
    await originalControl.request(
      client.hostId,
      actor.id,
      "followUp",
      { message: "before Main shutdown" },
      client.hostId,
    );
    await waitFor(() => messageCount() >= 2);
    await originalControl.close();

    await actors.close();
    await agents.close();
    await state.participants.close();
    await client.close();

    const peerIdentity: MeshIdentity = {
      id: `session:peer:${randomId()}`,
      name: "peer",
      kind: "main",
      sessionId: "peer",
    };
    const peerControl = new FabricControlPlane(state.mesh, peerIdentity, {
      enabled: true,
      hostId: peerIdentity.id,
      pollMs: 20,
      acknowledgementTimeoutMs: 3_000,
    });
    peerControl.start(() => ({ accepted: false }));
    const before = messageCount();
    await peerControl.request(
      residentHostId(state.identity.id),
      actor.id,
      "followUp",
      { message: "after Main shutdown" },
      residentHostId(state.identity.id),
    );
    await waitFor(() => messageCount() >= before + 2);
    await peerControl.request(
      residentHostId(state.identity.id),
      actor.id,
      "stop",
      {},
      residentHostId(state.identity.id),
    );
    await peerControl.close();

    expect(messageCount()).toBeGreaterThanOrEqual(before + 2);
    const detachedParticipants: FabricParticipantSource = {
      list: () => [],
      get: () => undefined,
      self: () => {
        throw new Error("not used by detached residency client");
      },
      peers: () => [],
      async refresh() {},
      scheduleRefresh() {},
    };
    const reconnect = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: detachedParticipants,
      mainAgent: state.mainAgent,
      hostPath,
    });
    await expect(reconnect.removeActor(actor.id)).resolves.toEqual({ removed: true });
    const registry = JSON.parse(
      fs.readFileSync(path.join(state.config.actorRoot, "actors.json"), "utf8"),
    ) as { actors: Array<{ id: string }> };
    expect(registry.actors.some((candidate) => candidate.id === actor.id)).toBe(false);
    await reconnect.close();
  });

  it("queues passive actor delivery until Main resumes", { timeout: 20_000 }, async () => {
    const state = await rootHarness("resident-delivery");
    const agents = new AgentManager(repo, state.config.agents, {
      workerPath: fakeWorker,
      runRoot: path.join(state.root, "parent-delivery-runs"),
      mainAgentId: state.identity.id,
      meshRoot: state.config.meshRoot,
      projectRoot: repo,
      hostId: state.identity.id,
      identityId: state.identity.id,
    });
    const actors = new ActorManager(
      state.config.sessionId,
      state.identity,
      state.mesh,
      state.meshConfig,
      agents,
      () => {},
      {
        actorRoot: state.config.actorRoot,
        persistent: true,
        claimResidency: "session",
        rootId: state.identity.id,
      },
    );
    state.participants.registerSource(() =>
      actors.listOwned().map((actor) =>
        actorParticipantRecord(
          actor,
          state.identity.id,
          state.identity.id,
          state.identity.id,
          state.identity.id,
        ),
      ),
    );
    actors.subscribe(() => state.participants.scheduleRefresh());
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath,
    });
    const actor = await actors.create({
      name: "resident delivery",
      instructions: "Reply to every message.",
      residency: "durable",
      delivery: "followUp",
      triggerTurn: false,
    });
    await actors.cede(actor.id);
    await state.participants.refresh();
    await client.ensureActor(actor.id);
    const control = new FabricControlPlane(state.mesh, state.identity, {
      enabled: true,
      hostId: state.identity.id,
      pollMs: 20,
      acknowledgementTimeoutMs: 3_000,
    });
    control.start(() => ({ accepted: false }));
    await control.request(client.hostId, actor.id, "followUp", { message: "respond" }, client.hostId);
    const prefix = residentDeliveryPrefix(state.identity.id);
    await waitFor(() => state.mesh.listAll(prefix).length === 1);
    expect(state.deliveries).toEqual([]);

    client.start();
    await waitFor(() => state.deliveries.length === 1);
    expect(state.deliveries[0]).toMatchObject({
      from: { id: actor.id, kind: "actor" },
      delivery: "followUp",
      triggerTurn: false,
      message: "fake worker complete",
    });
    // Delivery lands before MeshStore.delete completes its locked write, so
    // poll the queue drain instead of asserting the removal synchronously.
    await waitFor(() => state.mesh.listAll(prefix).length === 0);
    expect(state.mesh.listAll(prefix)).toEqual([]);

    await client.removeActor(actor.id);
    await control.close();
    await client.close();
    await actors.close();
    await agents.close();
    await state.participants.close();
  });

  it("applies live model guidance snapshots to durable participants", { timeout: 20_000 }, async () => {
    const state = await rootHarness("resident-guidance");
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath,
    });
    const guidance = (content: string) => [{
      componentId: "deepseek-guidance",
      component: "deepseek-guidance",
      revision: 1,
      label: "deepseek",
      models: ["deepseek/*"],
      targets: ["participant" as const],
      placement: "append" as const,
      content,
    }];

    client.updateModelGuidance(guidance("First durable guidance"));
    const first = await client.spawnAgent({
      task: "First guided durable agent",
      transport: "process",
      residency: "durable",
      model: "deepseek/deepseek-chat",
    });
    const firstResult = await client.waitAgent(first.id);
    expect((firstResult as typeof firstResult & { systemPrompt?: string }).systemPrompt).toBe(
      "First durable guidance",
    );

    client.updateModelGuidance(guidance("Revised durable guidance"));
    const second = await client.spawnAgent({
      task: "Second guided durable agent",
      transport: "process",
      residency: "durable",
      model: "deepseek/deepseek-chat",
    });
    const secondResult = await client.waitAgent(second.id);
    expect((secondResult as typeof secondResult & { systemPrompt?: string }).systemPrompt).toBe(
      "Revised durable guidance",
    );

    await client.cleanupAgent(first.id);
    await client.cleanupAgent(second.id);
    await client.close();
    await state.participants.close();
  });

  it("completes and cleans a durable agent after its originating Main closes", { timeout: 20_000 }, async () => {
    const state = await rootHarness("resident-agent");
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath,
    });
    const handle = await client.spawnAgent({
      task: "STREAM_PREVIEW",
      transport: "process",
      residency: "durable",
    });
    expect(handle.residency).toBe("durable");

    await client.close();
    await state.participants.close();

    const detachedParticipants: FabricParticipantSource = {
      list: () => [],
      get: () => undefined,
      self: () => {
        throw new Error("not used by detached residency client");
      },
      peers: () => [],
      async refresh() {},
      scheduleRefresh() {},
    };
    const reconnect = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: detachedParticipants,
      mainAgent: state.mainAgent,
      hostPath,
    });
    const result = await reconnect.waitAgent(handle.id);
    expect(result).toMatchObject({
      id: handle.id,
      status: "completed",
      residency: "durable",
      text: "stream preview complete",
    });
    await expect(reconnect.cleanupAgent(handle.id)).resolves.toEqual({ cleaned: true });
    expect(reconnect.hasAgent(handle.id)).toBe(false);
    await reconnect.close();
  });

  it("forwards and reports a canonical durable agent cwd", { timeout: 20_000 }, async () => {
    const state = await rootHarness("resident-agent-cwd");
    state.config.cwd = state.root;
    state.config.projectRoot = state.root;
    const target = path.join(state.root, "child");
    fs.mkdirSync(target);
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath,
    });

    const handle = await client.spawnAgent({
      task: "STREAM_PREVIEW",
      cwd: "child",
      transport: "process",
      residency: "durable",
    });
    const canonical = fs.realpathSync(target);
    expect(handle.cwd).toBe(canonical);

    const result = await client.waitAgent(handle.id);
    expect(result.cwd).toBe(canonical);
    expect(client.statusAgent(handle.id)).toMatchObject({ cwd: canonical });
    expect(client.readAgentLog(handle.id).status?.cwd).toBe(canonical);
    await expect(client.cleanupAgent(handle.id)).resolves.toEqual({ cleaned: true });
    await client.close();
    await state.participants.close();
  });
});
