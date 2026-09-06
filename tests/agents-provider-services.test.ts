import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { AgentRunResult } from "../src/agents/types.js";
import type { FabricActorMessage } from "../src/actors/types.js";
import type { FabricControlCommand } from "../src/topology/control-plane.js";
import type { FabricParticipantInfo } from "../src/topology/types.js";
import { AgentMessageRouter } from "../src/providers/agents-message-router.js";
import { collectAgentToolPreviewNodes, waitWithProgress, waitWithActorProgress } from "../src/providers/agents-progress.js";
import { collectAgentToolPreviewNodes as publicPreview, type AgentToolPreviewTreeOptions } from "../src/providers/agents-provider.js";

const record = (id = "run"): AgentRunResult => ({
  id, name: id, task: "task", status: "completed", runner: "pi", transport: "process",
  cwd: "/project", startedAt: 1, updatedAt: 2, turns: 1, toolCalls: 2, text: "done",
  usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0 },
});

const message: FabricActorMessage = {
  id: "reply", actorId: "actor", actorName: "Actor", direction: "out", source: "actor", createdAt: 1,
};

afterEach(() => vi.useRealTimers());

describe("agents provider progress service boundaries", () => {
  it("preserves the public preview export identity", () => {
    expect(publicPreview).toBe(collectAgentToolPreviewNodes);
    expectTypeOf<AgentToolPreviewTreeOptions>().toEqualTypeOf<Parameters<typeof collectAgentToolPreviewNodes>[1]>();
  });

  it("attaches final metrics and preview even before the first poll", async () => {
    vi.useFakeTimers();
    const result = record();
    const sink = { update: vi.fn(), activity: vi.fn(), attachPreview: vi.fn() };
    await expect(waitWithProgress(
      { wait: async () => result, status: () => result }, { read: vi.fn() }, "run", sink, () => true,
    )).resolves.toBe(result);
    expect(sink.activity).toHaveBeenCalledWith({ type: "metrics", tokens: 7, toolCalls: 2, cost: 0 });
    expect(sink.attachPreview).toHaveBeenCalledWith(expect.objectContaining({ id: "run", status: "completed" }));
    expect(sink.update).toHaveBeenCalledWith("Agent run: completed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the poll and preserves rejection when cancellation removes the run", async () => {
    vi.useFakeTimers();
    const failure = new Error("cancelled");
    await expect(waitWithProgress({
      wait: () => Promise.reject(failure),
      status: () => { throw new Error("Unknown Fabric agent"); },
    }, { read: vi.fn() }, "run", { update: vi.fn() }, () => true)).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects polling errors and stops polling even if the worker is still pending", async () => {
    vi.useFakeTimers();
    const failure = new Error("status unavailable");
    const result = waitWithProgress({
      wait: () => new Promise<AgentRunResult>(() => {}),
      status: () => { throw failure; },
    }, { read: vi.fn() }, "run", { update: vi.fn() }, () => true);
    const assertion = expect(result).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the latest terminal actor worker and tolerates transcript cleanup", async () => {
    vi.useFakeTimers();
    const sink = { update: vi.fn(), attachPreview: vi.fn() };
    const read = vi.fn(() => { throw new Error("log removed"); });
    await waitWithActorProgress({ list: () => [
      { ...record("old"), actorId: "actor" },
      { ...record("new"), actorId: "actor", logFile: "/removed" },
    ] }, { read }, "actor", "Actor", Promise.resolve(message), sink, () => true);
    expect(sink.attachPreview).toHaveBeenCalledWith(expect.objectContaining({ id: "new", tools: [] }));
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

type Ports = ConstructorParameters<typeof AgentMessageRouter>;
const routing = () => {
  const agents = {
    status: vi.fn<Ports[0]["status"]>(() => { throw new Error("Unknown Fabric agent"); }),
    steer: vi.fn<Ports[0]["steer"]>(), followUp: vi.fn<Ports[0]["followUp"]>(), stop: vi.fn<Ports[0]["stop"]>(),
  };
  const actors = {
    identity: { id: "main", name: "Main", kind: "main" as const },
    status: vi.fn<Ports[1]["status"]>(() => { throw new Error("Unknown Fabric actor"); }),
    validateDirectMessage: vi.fn<Ports[1]["validateDirectMessage"]>(),
    tell: vi.fn<Ports[1]["tell"]>(), ask: vi.fn<Ports[1]["ask"]>(), stop: vi.fn<Ports[1]["stop"]>(),
    steerRemote: vi.fn<Ports[1]["steerRemote"]>(), resolveBinding: vi.fn<Ports[1]["resolveBinding"]>(),
  };
  const main = {
    id: "main", local: true, matches: (id: string) => id === "main",
    deliverAgent: vi.fn<Ports[2]["deliverAgent"]>(() => ({ queued: true, messageId: "main-msg", routed: "local" })),
  };
  const participants = { get: vi.fn<Ports[3]["get"]>(), scheduleRefresh: vi.fn() };
  const control = { request: vi.fn<NonNullable<Ports[4]>["request"]>() };
  const resolveBinding = vi.fn<Ports[5]>((binding) => binding);
  const router = new AgentMessageRouter(agents, actors, main, participants, control, resolveBinding);
  return { router, agents, actors, main, participants, control };
};
const participant = (): FabricParticipantInfo => ({
  format: 1, id: "main", name: "Main", kind: "root", rootId: "main", ownerHostId: "host",
  ownerIdentityId: "owner", status: "running", runner: "pi", transport: "host",
  capabilities: ["followUp"], startedAt: 1, updatedAt: 1, controlProtocol: "v1", local: false, stale: false,
});
const command = (operation: FabricControlCommand["operation"]): FabricControlCommand => ({
  version: 1, commandId: "cmd", targetId: "child", operation, replyTo: "caller", requestedAt: 1, message: " hello ",
});

describe("agents provider message routing service boundaries", () => {
  it("preserves passive Main delivery and caller identity without actor validation", async () => {
    const { router, main, actors } = routing();
    const from = { id: "source", name: "Source", kind: "main" as const };
    await router.routeMessage("main", "event", undefined, "followUp", undefined, { from, triggerTurn: false });
    expect(main.deliverAgent).toHaveBeenCalledWith({ from, message: "event", delivery: "followUp", triggerTurn: false });
    expect(actors.validateDirectMessage).not.toHaveBeenCalled();
  });

  it("rechecks remote capability withdrawal on every delivery", async () => {
    const { router, main, participants, control, actors } = routing();
    main.local = false;
    const remote = participant();
    participants.get.mockReturnValue(remote);
    await router.routeMessage("main", "first", null, "followUp");
    expect(control.request).toHaveBeenCalledWith("host", "main", "followUp", { message: "first", data: null }, "owner");
    remote.capabilities = [];
    await expect(router.routeMessage("main", "second", null, "followUp")).rejects.toThrow("does not support followUp");
    expect(control.request).toHaveBeenCalledTimes(1);
    expect(actors.steerRemote).not.toHaveBeenCalled();
  });

  it("does not hide local agent failures by falling through to actors", async () => {
    const { router, agents, actors } = routing();
    const failure = new Error("worker unavailable");
    agents.status.mockImplementation(() => { throw failure; });
    await expect(router.routeMessage("child", "hello", undefined, "steer")).rejects.toBe(failure);
    expect(actors.validateDirectMessage).not.toHaveBeenCalled();
  });

  it("translates only unknown actor targets into unknown participant errors", async () => {
    const { router, actors } = routing();
    await expect(router.routeMessage("missing", "hello", undefined, "steer")).rejects.toThrow("Unknown Fabric participant: missing");
    const failure = new Error("registry unavailable");
    actors.status.mockImplementation(() => { throw failure; });
    await expect(router.routeMessage("missing", "hello", undefined, "steer")).rejects.toBe(failure);
  });

  it("leaves cancel commands to the control plane and refreshes successful stops", async () => {
    const { router, agents, participants, actors } = routing();
    await expect(router.acceptControl(command("cancel"), actors.identity)).resolves.toEqual({
      accepted: false, error: "Cancel commands are handled by the control plane",
    });
    expect(agents.stop).not.toHaveBeenCalled();
    await expect(router.acceptControl(command("stop"), actors.identity)).resolves.toEqual({ accepted: true, messageId: "cmd" });
    expect(agents.stop).toHaveBeenCalledWith("child");
    expect(participants.scheduleRefresh).toHaveBeenCalledOnce();
  });
});
