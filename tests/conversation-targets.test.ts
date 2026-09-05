import { describe, expect, it } from "vitest";
import {
  conversationTargets,
  defaultConversationTarget,
  resolveConversationTarget,
} from "../src/ui/conversation-targets.js";
import type { FabricDashboardSnapshot, FabricUiAgent, FabricUiActor } from "../src/ui/types.js";
import type { FabricParticipantInfo } from "../src/topology/types.js";

const mainInfo = () => ({
  id: "main-1",
  name: "Main" as const,
  kind: "main" as const,
  status: "idle" as const,
  runner: "pi" as const,
  transport: "host" as const,
  cwd: "/tmp/project",
  updatedAt: 1000,
  pendingMessages: false,
  local: true,
});

const agent = (overrides: Partial<FabricUiAgent> & { id: string }): FabricUiAgent => ({
  name: overrides.id,
  status: "running",
  runner: "pi",
  transport: "process",
  cwd: "/tmp/project",
  updatedAt: 500,
  ...overrides,
});

const actor = (overrides: Partial<FabricUiActor> & { id: string }): FabricUiActor =>
  ({
    scope: "project",
    name: overrides.id,
    status: "idle",
    runner: "pi",
    events: [],
    topics: [],
    delivery: "mailbox",
    responseMode: "text",
    triggerTurn: true,
    coalesce: false,
    queued: 0,
    messages: 0,
    createdAt: 100,
    updatedAt: 400,
    instructions: "",
    recentMessages: [],
    ...overrides,
  }) as FabricUiActor;

const participant = (
  overrides: Partial<FabricParticipantInfo> & { id: string },
): FabricParticipantInfo => ({
  format: 1,
  kind: "agent",
  rootId: "main-1",
  ownerHostId: "host-remote",
  ownerIdentityId: "identity-remote",
  name: overrides.id,
  status: "running",
  runner: "pi",
  transport: "host",
  capabilities: ["steer", "followUp", "stop"],
  startedAt: 100,
  updatedAt: 900,
  controlProtocol: "v1",
  local: false,
  stale: false,
  ...overrides,
});

const peer = (overrides: { id: string; name?: string }) => ({
  id: overrides.id,
  name: overrides.name ?? overrides.id,
  kind: "peer" as const,
  status: "idle" as const,
  runner: "pi" as const,
  transport: "host" as const,
  cwd: "/tmp/peer",
  sessionId: `session-${overrides.id}`,
  startedAt: 100,
  updatedAt: 800,
  pendingMessages: false,
  local: false as const,
});

const snapshot = (overrides: Partial<FabricDashboardSnapshot> = {}): FabricDashboardSnapshot =>
  ({
    now: 2000,
    runs: [],
    main: mainInfo(),
    peers: [],
    agents: [],
    actors: [],
    componentGraph: { components: [], edges: [], cycles: [] },
    globalActors: [],
    state: [],
    events: [],
    ...overrides,
  }) as FabricDashboardSnapshot;

const ids = (targets: ReturnType<typeof conversationTargets>): string[] =>
  targets.map((target) => target.id);

describe("conversationTargets", () => {
  it("defaults to a current live child rather than stale history or a peer", () => {
    const targets = conversationTargets(snapshot({ agents: [
      agent({ id: "old", status: "completed", updatedAt: 1 }),
      agent({ id: "stale", status: "running", stale: true, updatedAt: 9999 }),
      agent({ id: "active-a", status: "running", updatedAt: 3 }),
      agent({ id: "active-b", status: "running", updatedAt: 4 }),
    ], peers: [{ ...peer({ id: "peer" }), status: "running", updatedAt: 10000 }] }));
    expect(defaultConversationTarget(targets)?.id).toBe("active-b");
    expect(defaultConversationTarget(targets, "old")?.id).toBe("active-b");
    expect(defaultConversationTarget(targets, "stale")?.id).toBe("active-b");
    expect(defaultConversationTarget(targets, "active-a")?.id).toBe("active-a");
    expect(resolveConversationTarget(targets, "old").id).toBe("old");
  });


  it("projects child footer data from the actual activation without borrowing Main usage", () => {
    const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.005 };
    const current = snapshot({
      agents: [agent({ id: "leaf", cwd: "/repo/worktree", branch: "feature", usage })],
      actors: [actor({ id: "advisor", model: "provider/next-model", lastRunId: "activation", status: "running", worker: agent({ id: "activation", model: "provider/actual-model", thinking: "high", usage, cwd: "/repo/actor" }) })],
    });
    const targets = conversationTargets(current);
    expect(targets.find((target) => target.id === "leaf")).toMatchObject({ cwd: "/repo/worktree", branch: "feature", usage });
    expect(targets.find((target) => target.id === "advisor")).toMatchObject({ cwd: "/repo/actor", model: "provider/actual-model", thinking: "high", usage });
    expect(targets[0]?.usage).toBeUndefined();
  });

  it("uses only the matching retained actor activation and leaves remote cwd unknown", () => {
    const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.005 };
    const current = snapshot({ actors: [
      actor({ id: "advisor", lastRunId: "last", recentMessages: [{ id: "reply", actorId: "advisor", actorName: "advisor", direction: "out", source: "direct", createdAt: 100, runId: "last", usage }] }),
      actor({ id: "remote", local: false }),
    ] });
    expect(conversationTargets(current).find((target) => target.id === "advisor")).toMatchObject({ cwd: "/tmp/project", usage });
    expect(conversationTargets(current).find((target) => target.id === "remote")?.cwd).toBeUndefined();
    current.actors[0]!.lastRunId = "next";
    expect(conversationTargets(current).find((target) => target.id === "advisor")?.usage).toBeUndefined();
  });

  it("lists main first, then nested descendants in preorder", () => {
    const grandchild = agent({
      id: "agent-grandchild",
      parentId: "agent-child",
      nestingDepth: 2,
    });
    const child = agent({ id: "agent-child", parentId: "main-1" });
    const root = agent({ id: "agent-root", startedAt: 50 });
    const targets = conversationTargets(snapshot({ agents: [grandchild, child, root] }));
    expect(ids(targets)).toEqual(["main-1", "agent-root", "agent-child", "agent-grandchild"]);
    const [, rootTarget, childTarget, grandchildTarget] = targets;
    expect(rootTarget?.parentId).toBe("main-1");
    expect(childTarget?.parentId).toBe("main-1");
    expect(grandchildTarget?.parentId).toBe("agent-child");
    expect(targets[0]).toMatchObject({ kind: "main", canSteer: false, canStop: false });
  });

  it("emits parent targets before child targets for every kind", () => {
    const peerChild = agent({ id: "agent-of-peer", parentId: "peer-1", rootId: "peer-1" });
    const actorChild = agent({ id: "agent-of-actor", parentId: "actor-1" });
    const targets = conversationTargets(
      snapshot({
        agents: [peerChild, actorChild],
        actors: [actor({ id: "actor-1", rootId: "main-1" })],
        peers: [peer({ id: "peer-1" })],
      }),
    );
    expect(ids(targets)).toEqual(["main-1", "actor-1", "agent-of-actor", "peer-1", "agent-of-peer"]);
  });

  it("is stable across repeated calls", () => {
    const snap = snapshot({ agents: [agent({ id: "a" }), agent({ id: "b", startedAt: 10 })] });
    expect(ids(conversationTargets(snap))).toEqual(ids(conversationTargets(snap)));
  });

  it("maps a missing local parent to Main and keeps foreign lineage unowned", () => {
    const orphan = agent({ id: "orphan", parentId: "missing-parent" });
    const foreign = agent({
      id: "foreign",
      parentId: "missing-remote-parent",
      rootId: "peer-root-9",
      local: false,
    });
    const targets = conversationTargets(snapshot({ agents: [orphan, foreign] }));
    const orphanTarget = targets.find((target) => target.id === "orphan");
    const foreignTarget = targets.find((target) => target.id === "foreign");
    expect(orphanTarget?.parentId).toBe("main-1");
    expect(foreignTarget?.parentId).toBeUndefined();
  });

  it("handles cycles and missing parents without dropping targets", () => {
    const cycleA = agent({ id: "cycle-a", parentId: "cycle-b" });
    const cycleB = agent({ id: "cycle-b", parentId: "cycle-a" });
    const targets = conversationTargets(snapshot({ agents: [cycleA, cycleB] }));
    expect(ids(targets).sort()).toEqual(["cycle-a", "cycle-b", "main-1"]);
  });

  it("deduplicates repeated records for the same id", () => {
    const duplicate = agent({ id: "dup" });
    const targets = conversationTargets(snapshot({ agents: [duplicate, { ...duplicate }] }));
    expect(ids(targets).filter((id) => id === "dup")).toHaveLength(1);
  });

  it("marks finished one-shot agents read-only", () => {
    const targets = conversationTargets(
      snapshot({ agents: [agent({ id: "done-1", status: "completed" })] }),
    );
    const target = targets.find((entry) => entry.id === "done-1");
    expect(target).toMatchObject({ canSteer: false, canFollowUp: false, canStop: false });
    expect(target?.readOnlyReason).toContain("read-only");
  });

  it("keeps a detached child live from its own status even when the outer run finished", () => {
    const outer = agent({ id: "outer", status: "completed" });
    const detachedChild = agent({
      id: "detached-child",
      parentId: "outer",
      nestingDepth: 1,
      status: "running",
      local: false,
      ownerHostId: "host-remote",
      capabilities: ["steer", "followUp", "stop"],
    });
    const targets = conversationTargets(snapshot({ agents: [outer, detachedChild] }));
    const outerTarget = targets.find((entry) => entry.id === "outer");
    const childTarget = targets.find((entry) => entry.id === "detached-child");
    expect(outerTarget?.canSteer).toBe(false);
    expect(childTarget).toMatchObject({
      status: "running",
      canSteer: true,
      canFollowUp: true,
      canStop: true,
    });
    expect(childTarget?.readOnlyReason).toBeUndefined();
  });

  it("marks a nested orphan without participant caps read-only with no local fallback", () => {
    const outer = agent({ id: "outer-2", status: "running" });
    const nestedOrphan = agent({
      id: "nested-orphan",
      parentId: "outer-2",
      nestingDepth: 1,
      status: "running",
    });
    const targets = conversationTargets(snapshot({ agents: [outer, nestedOrphan] }));
    const target = targets.find((entry) => entry.id === "nested-orphan");
    expect(target).toMatchObject({ canSteer: false, canFollowUp: false, canStop: false });
    expect(target?.readOnlyReason).toContain("nested");
  });

  it("falls back to local capabilities only for top-level live local agents", () => {
    const targets = conversationTargets(snapshot({ agents: [agent({ id: "local-live" })] }));
    expect(targets.find((entry) => entry.id === "local-live")).toMatchObject({
      canSteer: true,
      canFollowUp: true,
      canStop: true,
    });
  });

  it("lets an idle veda actor accept mailbox messages", () => {
    const targets = conversationTargets(
      snapshot({ actors: [actor({ id: "actor-veda", runner: "veda" })] }),
    );
    expect(targets.find((entry) => entry.id === "actor-veda")).toMatchObject({
      kind: "actor",
      status: "idle",
      canSteer: true,
      canFollowUp: true,
      canStop: true,
    });
    expect(targets.find((entry) => entry.id === "actor-veda")?.readOnlyReason).toBeUndefined();
  });

  it("keeps the local manager fallback for local agents despite ownerHostId decoration", () => {
    const targets = conversationTargets(
      snapshot({ agents: [agent({ id: "local-owned", local: true, ownerHostId: "host-remote" })] }),
    );
    expect(targets.find((entry) => entry.id === "local-owned")).toMatchObject({
      canSteer: true,
      canFollowUp: true,
      canStop: true,
    });
  });

  it("denies steer and follow-up for veda runner agents", () => {
    const targets = conversationTargets(
      snapshot({ agents: [agent({ id: "veda-1", runner: "veda" })] }),
    );
    const target = targets.find((entry) => entry.id === "veda-1");
    expect(target?.canSteer).toBe(false);
    expect(target?.canFollowUp).toBe(false);
    expect(target?.readOnlyReason).toBeTruthy();
  });

  it("respects capability metadata on remote agents", () => {
    const remote = agent({
      id: "remote-1",
      local: false,
      ownerHostId: "host-remote",
      capabilities: ["steer"],
    });
    const targets = conversationTargets(snapshot({ agents: [remote] }));
    expect(targets.find((entry) => entry.id === "remote-1")).toMatchObject({
      canSteer: true,
      canFollowUp: false,
      canStop: false,
    });
  });

  it("marks stale agents read-only", () => {
    const stale = agent({ id: "stale-1", stale: true, capabilities: ["steer"] });
    const targets = conversationTargets(snapshot({ agents: [stale] }));
    const target = targets.find((entry) => entry.id === "stale-1");
    expect(target?.canSteer).toBe(false);
    expect(target?.readOnlyReason).toContain("unavailable");
  });

  it("lets an idle actor accept messages again after a failed activation", () => {
    const recovering = actor({ id: "actor-recovering", lastError: "activation blew up" });
    const targets = conversationTargets(snapshot({ actors: [recovering] }));
    const target = targets.find((entry) => entry.id === "actor-recovering");
    expect(target?.status).toBe("idle");
    expect(target).toMatchObject({ canSteer: true, canFollowUp: true, canStop: true });
    expect(target?.readOnlyReason).toBeUndefined();
  });

  it("keeps stopped actors read-only", () => {
    const targets = conversationTargets(
      snapshot({ actors: [actor({ id: "actor-stopped", status: "stopped" })] }),
    );
    const target = targets.find((entry) => entry.id === "actor-stopped");
    expect(target?.canSteer).toBe(false);
    expect(target?.readOnlyReason).toContain("stopped");
  });

  it("honors advertised actor caps including stop even when the actor is local", () => {
    const localActor = actor({ id: "actor-live", local: true });
    const actorParticipant = participant({
      id: "actor-live",
      kind: "actor",
      ownerHostId: "host-local",
      capabilities: ["steer", "followUp"],
    });
    const targets = conversationTargets(
      snapshot({ actors: [localActor], participants: [actorParticipant] }),
    );
    expect(targets.find((entry) => entry.id === "actor-live")).toMatchObject({
      canSteer: true,
      canFollowUp: true,
      canStop: false,
    });
  });

  it("attaches local actors to Main and prefers participant.parentId over rootId", () => {
    const advisor = actor({ id: "advisor", runner: "veda" });
    const remote = actor({ id: "actor-remote", rootId: "main-1", local: false });
    const linked = actor({ id: "actor-linked", rootId: "main-1" });
    const targets = conversationTargets(
      snapshot({
        actors: [advisor, remote, linked],
        peers: [peer({ id: "peer-1" })],
        participants: [
          participant({ id: "actor-linked", kind: "actor", parentId: "peer-1" }),
        ],
      }),
    );
    expect(targets.find((entry) => entry.id === "advisor")?.parentId).toBe("main-1");
    expect(targets.find((entry) => entry.id === "actor-remote")?.parentId).toBeUndefined();
    expect(targets.find((entry) => entry.id === "actor-linked")?.parentId).toBe("peer-1");
  });

  it("falls back to messageable peers when no participant metadata exists", () => {
    const targets = conversationTargets(snapshot({ peers: [peer({ id: "peer-solo" })] }));
    expect(targets.find((entry) => entry.id === "peer-solo")).toMatchObject({
      kind: "peer",
      canSteer: true,
      canFollowUp: true,
      canStop: false,
    });
  });

  it("honors participant stale and caps for peers when metadata exists", () => {
    const capped = participant({ id: "peer-capped", kind: "root", capabilities: ["steer"] });
    const stale = participant({ id: "peer-stale", kind: "root", stale: true });
    const targets = conversationTargets(
      snapshot({
        peers: [peer({ id: "peer-capped" }), peer({ id: "peer-stale" })],
        participants: [capped, stale],
      }),
    );
    expect(targets.find((entry) => entry.id === "peer-capped")).toMatchObject({
      canSteer: true,
      canFollowUp: false,
      canStop: false,
    });
    const staleTarget = targets.find((entry) => entry.id === "peer-stale");
    expect(staleTarget?.canSteer).toBe(false);
    expect(staleTarget?.readOnlyReason).toContain("unavailable");
  });

  it("rejects terminal one-shot participants instead of bypassing eligibility", () => {
    const finished = participant({ id: "participant-done", status: "completed" });
    const targets = conversationTargets(snapshot({ participants: [finished] }));
    const target = targets.find((entry) => entry.id === "participant-done");
    expect(target).toMatchObject({ canSteer: false, canFollowUp: false, canStop: false });
    expect(target?.readOnlyReason).toContain("read-only");
  });

  it("rejects veda steer/follow-up on leftover participant rows", () => {
    const veda = participant({ id: "participant-veda", runner: "veda" });
    const live = participant({ id: "participant-live", name: "Remote helper" });
    const targets = conversationTargets(snapshot({ participants: [veda, live] }));
    const vedaTarget = targets.find((entry) => entry.id === "participant-veda");
    expect(vedaTarget).toMatchObject({ canSteer: false, canFollowUp: false });
    expect(targets.find((entry) => entry.id === "participant-live")).toMatchObject({
      canSteer: true,
      canFollowUp: true,
      canStop: true,
    });
  });

  it("keeps arrays bounded to the snapshot entities and never emits global templates", () => {
    const globalTemplate = { id: "template-1", name: "Template" };
    const snap = snapshot({
      agents: [agent({ id: "a-1" })],
      globalActors: [globalTemplate] as FabricDashboardSnapshot["globalActors"],
    });
    const targets = conversationTargets(snap);
    expect(ids(targets)).toEqual(["main-1", "a-1"]);
  });

  it("keeps the main target navigation-only", () => {
    const targets = conversationTargets(snapshot());
    expect(targets[0]).toMatchObject({
      id: "main-1",
      name: "Main",
      kind: "main",
      canSteer: false,
      canFollowUp: false,
      canStop: false,
    });
    expect(targets[0]?.readOnlyReason).toBeTruthy();
  });
});

describe("resolveConversationTarget", () => {
  const targets = conversationTargets(
    snapshot({
      agents: [
        agent({ id: "agent-alpha", name: "Scout" }),
        agent({ id: "agent-beta", name: "scout" }),
      ],
    }),
  );

  it("resolves exact id first, ahead of any name match", () => {
    const target = resolveConversationTarget(targets, "main-1");
    expect(target.id).toBe("main-1");
    const byFullId = resolveConversationTarget(targets, "agent-alpha");
    expect(byFullId.name).toBe("Scout");
  });

  it("resolves unique case-insensitive names", () => {
    const unique = conversationTargets(
      snapshot({ agents: [agent({ id: "solo", name: "Scout" })] }),
    );
    expect(resolveConversationTarget(unique, "scout").id).toBe("solo");
  });

  it("throws for ambiguous exact names instead of first-matching", () => {
    expect(() => resolveConversationTarget(targets, "Scout")).toThrow(/Ambiguous/);
  });

  it("resolves unique id prefixes", () => {
    expect(resolveConversationTarget(targets, "agent-alp").id).toBe("agent-alpha");
  });

  it("throws for ambiguous id prefixes", () => {
    expect(() => resolveConversationTarget(targets, "agent-")).toThrow(/Ambiguous/);
  });

  it("throws for unknown queries", () => {
    expect(() => resolveConversationTarget(targets, "nope")).toThrow(/Unknown conversation target/);
    expect(() => resolveConversationTarget(targets, "   ")).toThrow();
  });
});
