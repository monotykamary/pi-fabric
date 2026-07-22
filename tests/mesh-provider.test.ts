import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import { MeshProvider } from "../src/providers/mesh-provider.js";
import type { FabricParticipantInfo, FabricParticipantSource } from "../src/topology/types.js";

const roots: string[] = [];
const context = {} as FabricInvocationContext;

const identity: MeshIdentity = {
  id: "session:test",
  name: "main",
  kind: "main",
  sessionId: "test",
};

const participant = (id: string): FabricParticipantInfo => ({
  format: 1,
  id,
  kind: "actor",
  rootId: identity.id,
  ownerHostId: identity.id,
  ownerIdentityId: identity.id,
  parentId: identity.id,
  name: id,
  status: "idle",
  runner: "pi",
  transport: "host",
  capabilities: ["steer", "followUp", "stop", "fabric"],
  startedAt: 1,
  updatedAt: 2,
  controlProtocol: "v1",
  local: true,
  stale: false,
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("MeshProvider membership", () => {
  it("reserves topology state and acknowledged control topics for the host", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-mesh-provider-"));
    roots.push(root);
    const source: FabricParticipantSource = {
      list: () => [],
      get: () => undefined,
      self: () => participant("actor:self"),
      peers: () => [],
      async refresh() {},
      scheduleRefresh() {},
    };
    const provider = new MeshProvider(
      new MeshStore(path.join(root, "mesh"), 64 * 1024, 100),
      identity,
      source,
    );

    await expect(
      provider.invoke("publish", { topic: "fabric.control.ack", data: {} }, context),
    ).rejects.toThrow("reserved for host coordination");
    await expect(
      provider.invoke("publish", { topic: "fabric.control.command.v2", data: {} }, context),
    ).rejects.toThrow("reserved for host coordination");
    await expect(
      provider.invoke("publish", { topic: "fabric.participant.lifecycle", data: {} }, context),
    ).rejects.toThrow("reserved for host coordination");
    await expect(
      provider.invoke("put", { key: "topology/hosts/forged", value: {} }, context),
    ).rejects.toThrow("reserved for host coordination");
    await expect(
      provider.invoke("delete", { key: "sessions/peer" }, context),
    ).rejects.toThrow("reserved for host coordination");
  });

  it("uses the unified participant source with scope and kind filters", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-mesh-provider-"));
    roots.push(root);
    const list = vi.fn(() => [participant("actor:a"), participant("actor:b")]);
    const source: FabricParticipantSource = {
      list,
      get: () => undefined,
      self: () => participant("actor:self"),
      peers: () => [],
      async refresh() {},
      scheduleRefresh() {},
    };
    const provider = new MeshProvider(
      new MeshStore(path.join(root, "mesh"), 64 * 1024, 100),
      identity,
      source,
    );

    await expect(
      provider.invoke(
        "members",
        { scope: "lineage", kinds: ["actor"], includeStale: true, limit: 1 },
        context,
      ),
    ).resolves.toMatchObject([{ id: "actor:a", kind: "actor" }]);
    expect(list).toHaveBeenCalledWith({
      scope: "lineage",
      kinds: ["actor"],
      includeStale: true,
    });
    await expect(provider.invoke("self", {}, context)).resolves.toEqual(identity);
  });
});
