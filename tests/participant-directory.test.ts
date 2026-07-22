import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { ParticipantDirectory } from "../src/topology/participant-directory.js";
import type { FabricParticipantRecord } from "../src/topology/types.js";

const roots: string[] = [];
const directories: ParticipantDirectory[] = [];

const rootRecord = (
  id: string,
  hostId: string,
  sessionId: string,
): FabricParticipantRecord => ({
  format: 1,
  id,
  kind: "root",
  rootId: id,
  ownerHostId: hostId,
  ownerIdentityId: hostId,
  name: "main",
  status: "idle",
  runner: "pi",
  transport: "host",
  capabilities: ["steer", "followUp", "fabric"],
  cwd: "/tmp/project",
  sessionId,
  startedAt: 1,
  updatedAt: 2,
  pendingMessages: false,
  controlProtocol: "v1",
});

const agentRecord = (
  id: string,
  rootId: string,
  hostId: string,
  parentId: string,
): FabricParticipantRecord => ({
  format: 1,
  id,
  kind: "agent",
  rootId,
  ownerHostId: hostId,
  ownerIdentityId: hostId,
  parentId,
  name: id,
  status: "running",
  runner: "pi",
  transport: "process",
  capabilities: ["steer", "followUp", "stop"],
  cwd: "/tmp/project",
  startedAt: 3,
  updatedAt: 4,
  controlProtocol: "v1",
});

const createDirectory = (
  meshRoot: string,
  identity: MeshIdentity,
  rootId: string,
  source: () => FabricParticipantRecord[],
): ParticipantDirectory => {
  const hostId = identity.kind === "main" ? identity.id : "runtime:" + identity.sessionId;
  const directory = new ParticipantDirectory(
    new MeshStore(meshRoot, 64 * 1024, 1_000),
    { enabled: true, hostId, rootId, identity, heartbeatMs: 100, leaseMs: 300 },
  );
  directory.registerSource(source);
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => directory.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ParticipantDirectory", () => {
  it("builds one project topology while preserving local ownership and lineage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-topology-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const alphaIdentity: MeshIdentity = {
      id: "session:alpha",
      name: "main",
      kind: "main",
      sessionId: "alpha",
    };
    const betaIdentity: MeshIdentity = {
      id: "session:beta",
      name: "main",
      kind: "main",
      sessionId: "beta",
    };
    const recursiveIdentity: MeshIdentity = {
      id: "agent:recursive",
      name: "recursive",
      kind: "agent",
      sessionId: "recursive-session",
    };
    const alpha = createDirectory(meshRoot, alphaIdentity, alphaIdentity.id, () => [
      rootRecord(alphaIdentity.id, alphaIdentity.id, "alpha"),
      agentRecord("agent:alpha-child", alphaIdentity.id, alphaIdentity.id, alphaIdentity.id),
    ]);
    const beta = createDirectory(meshRoot, betaIdentity, betaIdentity.id, () => [
      rootRecord(betaIdentity.id, betaIdentity.id, "beta"),
    ]);
    const recursive = createDirectory(meshRoot, recursiveIdentity, alphaIdentity.id, () => [
      agentRecord(
        "agent:grandchild",
        alphaIdentity.id,
        "runtime:recursive-session",
        recursiveIdentity.id,
      ),
    ]);

    await alpha.start();
    await beta.start();
    await recursive.start();

    expect(alpha.list({ scope: "project" }).map(({ id }) => id)).toEqual([
      "session:alpha",
      "session:beta",
      "agent:alpha-child",
      "agent:grandchild",
    ]);
    expect(alpha.list({ scope: "local" }).map(({ id }) => id)).toEqual([
      "session:alpha",
      "agent:alpha-child",
    ]);
    expect(alpha.list({ scope: "lineage" }).map(({ id }) => id)).toEqual([
      "session:alpha",
      "agent:alpha-child",
      "agent:grandchild",
    ]);
    expect(alpha.peers()).toMatchObject([
      { id: "session:beta", name: "Peer beta", kind: "peer", local: false },
    ]);
    expect(recursive.self()).toMatchObject({
      id: "agent:recursive",
      kind: "agent",
      rootId: "session:alpha",
    });
  });

  it("withdraws control capabilities before releasing its live host lease", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-topology-"));
    roots.push(root);
    const identity: MeshIdentity = {
      id: "session:quiesce",
      name: "main",
      kind: "main",
      sessionId: "quiesce",
    };
    const directory = createDirectory(path.join(root, "mesh"), identity, identity.id, () => [
      rootRecord(identity.id, identity.id, "quiesce"),
      agentRecord("agent:quiesce", identity.id, identity.id, identity.id),
    ]);

    await directory.start();
    await directory.quiesce();

    expect(directory.get("agent:quiesce")).toMatchObject({
      capabilities: [],
      local: true,
      stale: false,
    });
    expect(directory.mesh.get("sessions/quiesce")).toBeUndefined();
  });

  it("does not claim an actor still owned by a live legacy root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-topology-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const mesh = new MeshStore(meshRoot, 64 * 1024, 1_000);
    const oldIdentity: MeshIdentity = {
      id: "session:old",
      name: "main",
      kind: "main",
      sessionId: "old-session",
    };
    const session = await mesh.put({
      key: "sessions/old-session",
      value: {
        id: oldIdentity.id,
        name: "Peer old-sess",
        kind: "peer",
        status: "idle",
        runner: "pi",
        transport: "host",
        cwd: "/tmp/project",
        sessionId: "old-session",
        startedAt: 1,
        updatedAt: Date.now(),
        pendingMessages: false,
        local: false,
      },
      identity: oldIdentity,
    });
    await mesh.put({
      key: "actors/old-session/actor:legacy",
      value: {
        id: "actor:legacy",
        name: "legacy actor",
        status: "idle",
        runner: "pi",
        createdAt: 1,
      },
      identity: oldIdentity,
    });
    const identity: MeshIdentity = {
      id: "session:new",
      name: "main",
      kind: "main",
      sessionId: "new-session",
    };
    const directory = createDirectory(meshRoot, identity, identity.id, () => [
      rootRecord(identity.id, identity.id, "new-session"),
      {
        ...agentRecord("actor:legacy", identity.id, identity.id, identity.id),
        kind: "actor",
        transport: "host",
      },
    ]);

    await directory.start();
    expect(directory.get("actor:legacy")).toMatchObject({
      ownerHostId: oldIdentity.id,
      controlProtocol: "legacy",
      local: false,
    });

    await mesh.delete({ key: session.key, ifVersion: session.version });
    await directory.refresh();
    expect(directory.get("actor:legacy")).toMatchObject({
      ownerHostId: identity.id,
      controlProtocol: "v1",
      local: true,
    });
  });

  it("never shares agent prompts, results, or errors in participant state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-topology-"));
    roots.push(root);
    const identity: MeshIdentity = {
      id: "session:private",
      name: "main",
      kind: "main",
      sessionId: "private",
    };
    const directory = createDirectory(path.join(root, "mesh"), identity, identity.id, () => [
      rootRecord(identity.id, identity.id, "private"),
      {
        ...agentRecord("agent:private", identity.id, identity.id, identity.id),
        task: "secret prompt",
        text: "secret result",
        error: "secret failure",
      } as FabricParticipantRecord,
      agentRecord("agent:wrong-lineage", "session:foreign", identity.id, identity.id),
    ]);

    await directory.start();
    expect(directory.mesh.get("sessions/private")?.value).toMatchObject({
      id: identity.id,
      kind: "peer",
    });
    const participant = directory.get("agent:private") as unknown as Record<string, unknown>;
    expect(participant).not.toHaveProperty("task");
    expect(participant).not.toHaveProperty("text");
    expect(participant).not.toHaveProperty("error");
    expect(directory.get("agent:wrong-lineage")).toBeUndefined();
    expect(
      JSON.stringify(directory.mesh.listAll("topology/participants/")),
    ).not.toContain("secret");

    await directory.mesh.put({
      key: "topology/participants/not-a-canonical-hash",
      value: {
        ...agentRecord("agent:forged", identity.id, identity.id, identity.id),
        ownerIdentityId: identity.id,
      },
      identity,
    });
    expect(directory.get("agent:forged")).toBeUndefined();
    await directory.mesh.put({
      key: "sessions/claimed",
      value: {
        id: "session:victim",
        sessionId: "claimed",
        cwd: "/tmp/project",
        status: "idle",
        startedAt: 1,
      },
      identity,
    });
    expect(directory.get("session:victim")).toBeUndefined();
  });

  it("keeps one live execution owner for a colliding participant id", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-topology-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const alphaIdentity: MeshIdentity = {
      id: "session:alpha",
      name: "main",
      kind: "main",
      sessionId: "alpha",
    };
    const betaIdentity: MeshIdentity = {
      id: "session:beta",
      name: "main",
      kind: "main",
      sessionId: "beta",
    };
    const shared = (identity: MeshIdentity): FabricParticipantRecord => ({
      ...agentRecord("actor:shared", identity.id, identity.id, identity.id),
      kind: "actor",
      transport: "host",
    });
    const alpha = createDirectory(meshRoot, alphaIdentity, alphaIdentity.id, () => [
      rootRecord(alphaIdentity.id, alphaIdentity.id, "alpha"),
      shared(alphaIdentity),
    ]);
    const beta = createDirectory(meshRoot, betaIdentity, betaIdentity.id, () => [
      rootRecord(betaIdentity.id, betaIdentity.id, "beta"),
      shared(betaIdentity),
    ]);

    await alpha.start();
    await beta.start();
    expect(beta.get("actor:shared")).toMatchObject({ ownerHostId: "session:alpha" });

    await alpha.close();
    await beta.refresh();
    expect(beta.get("actor:shared")).toMatchObject({ ownerHostId: "session:beta" });
  });

  it("hides every participant owned by an expired host lease", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-topology-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const identity: MeshIdentity = {
      id: "session:alpha",
      name: "main",
      kind: "main",
      sessionId: "alpha",
    };
    const directory = createDirectory(meshRoot, identity, identity.id, () => [
      rootRecord(identity.id, identity.id, "alpha"),
      agentRecord("agent:child", identity.id, identity.id, identity.id),
    ]);
    await directory.start();

    expect(directory.list({ scope: "project" })).toHaveLength(2);
    expect(directory.list({ scope: "project" }, Date.now() + 1_000)).toEqual([]);
    const stale = directory.list(
      { scope: "project", includeStale: true },
      Date.now() + 1_000,
    );
    expect(stale).toHaveLength(2);
    expect(stale.every((participant) => participant.stale)).toBe(true);
  });

  it("keeps the same topology API in local-only mode", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-topology-"));
    roots.push(root);
    const identity: MeshIdentity = {
      id: "session:local",
      name: "main",
      kind: "main",
      sessionId: "local",
    };
    const directory = new ParticipantDirectory(
      new MeshStore(path.join(root, "mesh"), 64 * 1024, 100),
      { enabled: false, hostId: identity.id, rootId: identity.id, identity },
    );
    directories.push(directory);
    directory.registerSource(() => [
      rootRecord(identity.id, identity.id, "local"),
      agentRecord("agent:local", identity.id, identity.id, identity.id),
    ]);
    await directory.start();

    expect(directory.list({ scope: "project" }).map(({ id }) => id)).toEqual([
      "session:local",
      "agent:local",
    ]);
  });
});
