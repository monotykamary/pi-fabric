import fs from "node:fs";
import childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService, createAgentServiceClient, createAgentServiceHandler, createAgentsProvider, type AgentExecutionPort, type AgentExecutionRequest, type AgentExecutionResponse, type AgentServiceEvent } from "../src/agents.js";
import type { FabricInvocationContext } from "../src/protocol.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
const usage = {input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0};
const context = {signal: undefined} as FabricInvocationContext;
const services: AgentService[] = [];
const service = (port: AgentExecutionPort, options: Partial<ConstructorParameters<typeof AgentService>[0]> = {}) => {
  const instance = new AgentService({rootId: "root", port, ...options});
  services.push(instance);
  return instance;
};
const hanging = () => {
  const requests = new Map<string, AgentExecutionRequest>();
  const results = new Map<string, ReturnType<typeof deferred<AgentExecutionResponse>>>();
  const execute = vi.fn(async (request: AgentExecutionRequest) => {
    requests.set(request.id, request);
    const result = deferred<AgentExecutionResponse>();
    results.set(request.id, result);
    const stop = () => result.resolve({status: "stopped"});
    request.signal.addEventListener("abort", stop, {once: true});
    if (request.signal.aborted) stop();
    return result.promise;
  });
  const cleanup = vi.fn(async () => {});
  return {port: {execute, cleanup}, requests, results};
};
afterEach(async () => {vi.restoreAllMocks(); await Promise.allSettled(services.splice(0).map((entry) => entry.close()));});

describe("hosted Fabric agent service", () => {
  it("shares native normalization/schema results, stable prepare identity, usage and private checkpoints", async () => {
    const events: AgentServiceEvent[] = [];
    const prepare = vi.fn(async (request) => ({authorizedId: request.id}));
    const instance = service({prepare, execute: async (request) => {
      expect(request.binding).toEqual({authorizedId: request.id});
      expect(request.generation).toBe(prepare.mock.calls[0]![0].generation);
      await request.emit({type: "progress", turns: 1, toolCalls: 2, usage});
      await request.emit({type: "checkpoint", checkpoint: {secret: "opaque"}});
      return {status: "completed", text: 'Answer:\n```json\n{"ok":true}\n```'};
    }}, {onEvent: (event) => {events.push(event);}});
    const client = createAgentServiceClient(createAgentServiceHandler(instance, "root"));
    const provider = createAgentsProvider(client);
    const result = await provider.invoke("run", {prompt: "  task  ", thinking: "LOW", schema: {type: "object", properties: {ok: {type: "boolean"}}, required: ["ok"]}}, context);
    expect(result).toMatchObject({status: "completed", task: "  task  ", thinking: "low", turns: 1, toolCalls: 2, usage, value: {ok: true}, depth: 1, parentId: "root"});
    expect(JSON.stringify(result)).not.toContain("opaque");
    const [record] = await client.list();
    expect(record).not.toHaveProperty("checkpoint");
    expect(await client.status(record!.id)).not.toHaveProperty("checkpoint");
    expect(await client.wait(record!.id)).not.toHaveProperty("checkpoint");
    expect(instance.snapshot().records[0]!.record.checkpoint).toEqual({secret: "opaque"});
    expect(events.map((event) => event.type)).toEqual(["admitted", "running", "progress", "checkpoint", "settled"]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(events.at(-1)!.record.checkpoint).toEqual({secret: "opaque"});
  });

  it("consumes admitted failed starts, not denied asynchronous preparation", async () => {
    const cleanup = vi.fn(async () => {});
    const prepare = vi.fn().mockRejectedValueOnce(new Error("placement denied")).mockResolvedValue(undefined);
    const execute = vi.fn(async () => {throw new Error("start failed");});
    const instance = service({prepare, execute, cleanup});
    await expect(instance.run("root", {task: "denied"})).rejects.toThrow("placement denied");
    expect(instance.snapshot().starts).toBe(0);
    expect(await instance.run("root", {task: "admitted"})).toMatchObject({status: "failed", error: "start failed"});
    expect(instance.snapshot().starts).toBe(1);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("validates structured output using the native worker failure contract", async () => {
    const instance = service({execute: async () => ({status: "completed", text: '{"ok":"wrong"}'})});
    const result = await instance.run("root", {task: "structured", schema: {type: "object", properties: {ok: {type: "boolean"}}, required: ["ok"]}});
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/^Structured agent output was invalid:/);
    expect(result.error).toContain('output: {"ok":"wrong"}');
    expect(result.finishedAt).toBeTypeOf("number");
  });

  it("admits exactly eight attempts atomically after nine concurrent preparations", async () => {
    const gate = deferred<void>();
    const prepare = vi.fn(async () => gate.promise);
    const instance = service({prepare, execute: async () => ({status: "completed"})}, {maxConcurrent: 9});
    const operations = Array.from({length: 9}, (_, index) => instance.run("root", {task: String(index)}));
    const all = Promise.allSettled(operations);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(9));
    expect(instance.snapshot().starts).toBe(0);
    gate.resolve();
    const results = await all;
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(8);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(instance.snapshot().starts).toBe(8);
  });

  it("uses per-parent concurrency without recursive semaphore deadlock and checks depth", async () => {
    let instance: AgentService;
    instance = service({execute: async (request) => {
      if (request.depth === 3) {
        await expect(instance.run(request.id, {task: "too deep"})).rejects.toThrow("depth limit");
        return {status: "completed", text: "leaf"};
      }
      const child = await instance.run(request.id, {task: "nested"});
      return {status: "completed", text: child.text};
    }}, {maxConcurrent: 1});
    expect(await instance.run("root", {task: "parent"})).toMatchObject({status: "completed", text: "leaf"});
    expect(instance.snapshot().starts).toBe(3);
    const child = instance.snapshot().records.find(({record}) => record.depth === 2)!.record;
    await expect(instance.status("root", child.id)).rejects.toThrow("direct child");
    await expect(instance.stop("foreign", child.id)).rejects.toThrow("Unknown agent caller");
  });

  it("rechecks authority after prepare and refuses stale admissions without charging", async () => {
    let authorized = true;
    const execute = vi.fn();
    const instance = service({prepare: async () => {authorized = false;}, execute}, {assertAuthority: () => {if (!authorized) throw new Error("lease revoked");}});
    await expect(instance.spawn("root", {task: "stale"})).rejects.toThrow("lease revoked");
    expect(instance.snapshot().starts).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("aborts only a waiter and leaves the admitted child running", async () => {
    const host = hanging();
    const instance = service(host.port);
    const handle = await instance.spawn("root", {task: "background"});
    await vi.waitFor(() => expect(host.requests.has(handle.id)).toBe(true));
    const controller = new AbortController();
    const waiter = instance.wait("root", handle.id, controller.signal);
    controller.abort();
    await expect(waiter).rejects.toThrow("aborted");
    expect(host.requests.get(handle.id)!.signal.aborted).toBe(false);
    host.results.get(handle.id)!.resolve({status: "completed", text: "still alive"});
    expect(await instance.wait("root", handle.id)).toMatchObject({status: "completed", text: "still alive"});
  });

  it("stops descendants and waits for control acknowledgment before cleanup and waiter completion", async () => {
    const host = hanging();
    const stopAck = deferred<void>();
    const stop = vi.fn(async () => stopAck.promise);
    const instance = service({...host.port, stop});
    const parent = await instance.spawn("root", {task: "parent"});
    await vi.waitFor(() => expect(host.requests.has(parent.id)).toBe(true));
    const child = await instance.spawn(parent.id, {task: "child"});
    await vi.waitFor(() => expect(host.requests.has(child.id)).toBe(true));
    const stopped = instance.stop("root", parent.id);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
    expect(host.port.cleanup).not.toHaveBeenCalled();
    stopAck.resolve();
    expect(await stopped).toMatchObject({status: "stopped"});
    expect(await instance.wait(parent.id, child.id)).toMatchObject({status: "stopped"});
    expect(host.port.cleanup).toHaveBeenCalledTimes(2);
    await instance.close();
    expect(host.port.cleanup).toHaveBeenCalledTimes(2);
  });

  it("restores paused children without ambient calls or automatic relaunch and resumes direct lineage", async () => {
    let original: AgentService;
    original = service({execute: async (request) => {
      if (request.depth === 1) await original.run(request.id, {task: "child"});
      return {status: "paused", checkpoint: {secret: request.depth}, text: "paused"};
    }});
    const parent = await original.run("root", {task: "parent"});
    expect(parent.status).toBe("paused");
    expect(parent).not.toHaveProperty("finishedAt");
    expect(parent).not.toHaveProperty("checkpoint");
    const saved = original.snapshot();
    let restored: AgentService;
    const execute = vi.fn();
    const prepare = vi.fn(async (request) => ({placement: request.id}));
    const resume = vi.fn(async (request: AgentExecutionRequest): Promise<AgentExecutionResponse> => {
      expect(request.checkpoint).toEqual({secret: request.depth});
      if (request.depth === 1) {
        const [child] = await restored.list(request.id);
        expect(child).not.toHaveProperty("checkpoint");
        expect(await restored.wait(request.id, child!.id)).toMatchObject({status: "paused"});
        expect(await restored.resume(request.id, child!.id)).toMatchObject({status: "completed"});
      }
      return {status: "completed", text: "resumed"};
    });
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(() => {throw new Error("ambient read");});
    const mkdir = vi.spyOn(fs, "mkdirSync").mockImplementation(() => {throw new Error("ambient mkdir");});
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => {throw new Error("ambient spawn");});
    restored = service({execute, prepare, resume}, {snapshot: saved, maxConcurrent: 1});
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    const polluted = restored.snapshot();
    Object.assign(polluted.records[0]!.record, {binding: {secret: "binding"}, request: {secret: "raw-request"}, nestedAgents: [{checkpoint: {secret: "nested-checkpoint"}}]});
    const scrubbed = service({execute}, {snapshot: polluted});
    expect(JSON.stringify(await scrubbed.list("root"))).not.toMatch(/binding|raw-request|nested-checkpoint|checkpoint/);
    expect(await restored.resume("root", parent.id)).toMatchObject({status: "completed", id: parent.id, generation: 2});
    expect(restored.snapshot().starts).toBe(4);
    expect(read).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
  });

  it("restores interrupted running records as paused, validates snapshots and rejects unsupported resume", async () => {
    const host = hanging();
    const original = service(host.port);
    const handle = await original.spawn("root", {task: "running"});
    await vi.waitFor(() => expect(host.requests.has(handle.id)).toBe(true));
    const saved = original.snapshot();
    const execute = vi.fn();
    const restored = service({execute}, {snapshot: saved});
    expect(await restored.wait("root", handle.id)).toMatchObject({status: "paused"});
    await expect(restored.resume("root", handle.id)).rejects.toThrow("unsupported");
    expect(execute).not.toHaveBeenCalled();
    expect(() => new AgentService({rootId: "wrong", port: {execute}, snapshot: saved})).toThrow("snapshot");
    saved.records[0]!.record.parentId = "foreign";
    expect(() => new AgentService({rootId: "root", port: {execute}, snapshot: saved})).toThrow("lineage");
  });

  it("reserves one continuation, denies concurrent resumes, and preserves a denied paused attempt", async () => {
    const gate = deferred<void>();
    let deny = true;
    const instance = service({execute: async () => ({status: "paused", checkpoint: "saved"}), prepare: async () => {
      if (instance.snapshot().starts > 0) {await gate.promise; if (deny) throw new Error("denied resume");}
    }, resume: async () => ({status: "completed"})});
    const paused = await instance.run("root", {task: "pause"});
    const first = instance.resume("root", paused.id);
    await vi.waitFor(() => expect(instance.snapshot().starts).toBe(1));
    await expect(instance.resume("root", paused.id)).rejects.toThrow("idle paused");
    gate.resolve();
    await expect(first).rejects.toThrow("denied resume");
    expect(await instance.status("root", paused.id)).toMatchObject({status: "paused", generation: 1});
    expect(instance.snapshot().starts).toBe(1);
    deny = false;
    expect(await instance.resume("root", paused.id)).toMatchObject({status: "completed", generation: 2});
  });

  it("closes pending preparations and rejects unsupported requests even without discovery", async () => {
    const gate = deferred<void>();
    const prepare = vi.fn(async () => gate.promise);
    const execute = vi.fn();
    const instance = service({prepare, execute});
    const provider = createAgentsProvider(createAgentServiceClient(createAgentServiceHandler(instance, "root")));
    for (const args of [{runner: "claude"}, {runner: "veda"}, {kernel: "python"}, {extensions: false}, {worktree: true}, {transport: "process"}, {actorId: "x"}, {parentId: "x"}, {principal: "x"}, {sessionFile: "x"}]) {
      await expect(Promise.resolve().then(() => provider.invoke("spawn", {task: "forbidden", ...args}, context))).rejects.toThrow("Invalid hosted");
    }
    await expect(Promise.resolve().then(() => provider.invoke("spawn", {task: "forbidden", residency: "durable"}, context))).rejects.toThrow("topology is unavailable");
    for (const action of ["resume", "steer", "compact", "create", "models", "handoff", "members"]) {
      await expect(Promise.resolve().then(() => provider.invoke(action, {id: "x"}, context))).rejects.toThrow("Unsupported");
    }
    expect((await provider.list({}, context)).map((descriptor) => descriptor.name).sort()).toEqual(["list", "run", "spawn", "status", "stop", "wait"]);
    expect(prepare).not.toHaveBeenCalled();
    const pending = instance.spawn("root", {task: "pending"});
    const rejected = expect(pending).rejects.toThrow("aborted");
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    const close = instance.close();
    gate.resolve();
    await rejected; await close;
    expect(instance.snapshot().starts).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves approval pauses on close, including an interrupted child's emitted checkpoint", async () => {
    const host = hanging();
    const instance = service(host.port);
    const handle = await instance.spawn("root", {task: "approval"});
    await vi.waitFor(() => expect(host.requests.has(handle.id)).toBe(true));
    await host.requests.get(handle.id)!.emit({type: "checkpoint", checkpoint: {approval: "private"}});
    await instance.close();
    expect(await instance.wait("root", handle.id)).toMatchObject({status: "paused"});
    expect(await instance.wait("root", handle.id)).not.toHaveProperty("checkpoint");
    const saved = instance.snapshot();
    expect(saved.records[0]!.record).toMatchObject({status: "paused", checkpoint: {approval: "private"}});
    expect(saved.records[0]!.record).not.toHaveProperty("finishedAt");
    const restored = service({execute: async () => ({status: "completed"})}, {snapshot: saved});
    expect(await restored.stop("root", handle.id)).toMatchObject({status: "stopped"});
    const paused = service({execute: async () => ({status: "paused", checkpoint: "saved"})});
    const record = await paused.run("root", {task: "paused"});
    await paused.close();
    expect(paused.snapshot().records[0]!.record).toMatchObject({id: record.id, status: "paused", checkpoint: "saved"});
  });

  it("continues completed and failed children and resets only trusted new-root admission epochs", async () => {
    const resume = vi.fn(async (): Promise<AgentExecutionResponse> => ({status: "completed", text: "follow-up", checkpoint: "latest"}));
    const original = service({execute: async () => ({status: "failed", error: "recoverable", checkpoint: "saved"}), resume});
    const record = await original.run("root", {task: "durable"});
    expect(await original.resume("root", record.id, "recover")).toMatchObject({status: "completed", generation: 2});
    const saved = original.snapshot();
    const restored = service({execute: async () => ({status: "completed"}), resume}, {rootId: "new-root", snapshot: saved, restorePolicy: "new-root"});
    expect(restored.snapshot().starts).toBe(0);
    expect(restored.snapshot().records[0]!.record).toMatchObject({rootId: "new-root", parentId: "new-root", generation: 2, checkpoint: "latest"});
    for (let index = 0; index < 8; index++) {
      expect(await restored.resume("new-root", record.id)).toMatchObject({status: "completed", generation: index + 3});
    }
    await expect(restored.resume("new-root", record.id)).rejects.toThrow("start limit");
    const sameEpoch = service({execute: async () => ({status: "completed"}), resume}, {rootId: "new-root", snapshot: restored.snapshot()});
    expect(sameEpoch.snapshot().starts).toBe(8);
    expect(sameEpoch.snapshot().records[0]!.record.generation).toBe(10);
    await expect(sameEpoch.resume("new-root", record.id)).rejects.toThrow("start limit");
    expect(await original.status("root", record.id)).toMatchObject({rootId: "root", generation: 2});
  });

  it("acknowledges steer and compact only after the port finishes and drains in-flight controls", async () => {
    const host = hanging();
    const ack = deferred<void>();
    const compact = vi.fn(async () => ack.promise);
    const steer = vi.fn(async () => {});
    const instance = service({...host.port, compact, steer});
    const handle = await instance.spawn("root", {task: "controlled"});
    await vi.waitFor(() => expect(host.requests.has(handle.id)).toBe(true));
    expect(await instance.steer("root", handle.id, "update")).toMatchObject({status: "running"});
    expect(steer).toHaveBeenCalledWith(expect.objectContaining({id: handle.id, message: "update"}));
    const control = instance.compact("root", handle.id, "preserve decisions");
    const rejected = expect(control).rejects.toThrow("Stale agent control acknowledgment");
    await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce());
    const stopped = instance.stop("root", handle.id);
    await vi.waitFor(() => expect(host.requests.get(handle.id)!.signal.aborted).toBe(true));
    expect(host.port.cleanup).not.toHaveBeenCalled();
    ack.resolve();
    await rejected;
    expect(await stopped).toMatchObject({status: "stopped"});
    expect(host.port.cleanup).toHaveBeenCalledOnce();
  });

  it("fences execution after asynchronous running publication and drains cleanup even when stop acknowledgment fails", async () => {
    let authorized = true;
    const execute = vi.fn();
    const cleanup = vi.fn(async () => {});
    const fenced = service({execute, cleanup}, {
      assertAuthority: () => {if (!authorized) throw new Error("revoked");},
      onEvent: async (event) => {if (event.type === "running") authorized = false;},
    });
    const handle = await fenced.spawn("root", {task: "fenced start"});
    await fenced.drain();
    expect(execute).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(fenced.snapshot().records[0]!.record).toMatchObject({id: handle.id, status: "failed"});
    const host = hanging();
    const instance = service({...host.port, stop: async () => {throw new Error("stop ack failed");}});
    const child = await instance.spawn("root", {task: "stop failure"});
    await vi.waitFor(() => expect(host.requests.has(child.id)).toBe(true));
    await expect(instance.stop("root", child.id)).rejects.toThrow("Agent stop failed");
    expect(host.port.cleanup).toHaveBeenCalledOnce();
    expect(await instance.wait("root", child.id)).toMatchObject({status: "stopped"});
  });

  it("drains background descendants admitted by live parents during natural completion", async () => {
    const gate = deferred<void>();
    const leaf = deferred<void>();
    let instance: AgentService;
    instance = service({execute: async (request) => {
      if (request.depth === 1) {
        await gate.promise;
        await instance.spawn(request.id, {task: "background child"});
        return {status: "completed", text: "parent done"};
      }
      await leaf.promise;
      return {status: "completed", text: "child done"};
    }}, {maxConcurrent: 1});
    await instance.spawn("root", {task: "parent"});
    let drained = false;
    const drain = instance.drain().then(() => {drained = true;});
    gate.resolve();
    await vi.waitFor(() => expect(instance.snapshot().records).toHaveLength(2));
    expect(drained).toBe(false);
    expect(instance.snapshot().records[0]!.record.status).toBe("completed");
    leaf.resolve();
    await drain;
    expect(instance.snapshot().records.map(({record}) => record.status)).toEqual(["completed", "completed"]);
    await instance.close();
    expect(instance.snapshot().records.map(({record}) => record.status)).toEqual(["completed", "completed"]);
  });

  it("follows up a running child and routes session/peer delivery through host topology", async () => {
    const host = hanging();
    const followUp = vi.fn(async () => {});
    const deliver = vi.fn(async (request) => ({
      id: request.id,
      name: request.id === "root" ? "main" : "peer-bot",
      kind: "root" as const,
      status: "running",
      capabilities: ["steer", "followUp"] as Array<"steer" | "followUp">,
    }));
    const topology = {
      self: (callerId: string) => ({id: callerId, name: "main", kind: "root" as const, status: "running", capabilities: ["steer", "followUp"] as Array<"steer" | "followUp">}),
      sessions: () => [{id: "root", name: "main", kind: "root" as const, status: "running", capabilities: ["steer", "followUp"] as Array<"steer" | "followUp">}, {id: "peer", name: "peer-bot", kind: "root" as const, status: "idle", capabilities: ["steer", "followUp"] as Array<"steer" | "followUp">}],
      peers: () => [{id: "peer", name: "peer-bot", kind: "root" as const, status: "idle", capabilities: ["steer", "followUp"] as Array<"steer" | "followUp">}],
      deliver,
      create: vi.fn(async (request: {name: string}) => ({
        id: "new-peer",
        name: request.name,
        kind: "root" as const,
        status: "idle",
        capabilities: ["steer", "followUp"] as Array<"steer" | "followUp">,
      })),
      remove: vi.fn(async (request: {id: string; name?: string}) => ({
        id: request.id,
        name: request.name ?? "peer-bot",
        kind: "root" as const,
        status: "stopped",
        capabilities: ["steer", "followUp"] as Array<"steer" | "followUp">,
      })),
      dispatch: vi.fn(async (request: {request: {name?: string}}) => ({
        id: "durable-work",
        name: request.request.name ?? "work",
        kind: "agent" as const,
        status: "running",
        capabilities: ["steer", "followUp"] as Array<"steer" | "followUp">,
      })),
    };
    const instance = service({...host.port, followUp}, {topology});
    const handle = await instance.spawn("root", {task: "child"});
    await vi.waitFor(() => expect(host.requests.has(handle.id)).toBe(true));
    expect(await instance.followUp("root", handle.id, "keep going")).toMatchObject({id: handle.id, status: "running"});
    expect(followUp).toHaveBeenCalledWith(expect.objectContaining({id: handle.id, message: "keep going"}));
    const client = createAgentServiceClient(createAgentServiceHandler(instance, "root"), instance.capabilities);
    const provider = createAgentsProvider(client);
    expect((await provider.list({}, context)).map((descriptor) => descriptor.name).sort()).toEqual([
      "create", "followUp", "list", "members", "peers", "remove", "run", "self", "sessions", "spawn", "status", "steer", "stop", "wait",
    ]);
    expect(await instance.followUp("root", "peer", "please take this")).toMatchObject({id: "peer", name: "peer-bot"});
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({callerId: "root", id: "peer", operation: "followUp", message: "please take this"}));
    expect(await instance.steer("root", "main", "nudge self")).toMatchObject({id: "root", name: "main"});
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({id: "root", operation: "steer", message: "nudge self"}));
    expect(await instance.sessions("root")).toHaveLength(2);
    expect(await instance.peers("root")).toEqual([expect.objectContaining({id: "peer"})]);
    expect(await instance.self("root")).toMatchObject({id: "root", kind: "root"});
    expect(await instance.members("root")).toEqual(expect.arrayContaining([
      expect.objectContaining({id: "root", kind: "root"}),
      expect.objectContaining({id: "peer", kind: "root"}),
      expect.objectContaining({id: handle.id, kind: "agent"}),
    ]));
    host.results.get(handle.id)!.resolve({status: "completed", text: "done"});
    expect(await instance.wait("root", handle.id)).toMatchObject({status: "completed"});
    expect(await instance.followUp("root", handle.id, "after settle")).toMatchObject({id: handle.id, status: "completed"});
    expect(followUp).toHaveBeenCalledTimes(2);
    expect(await instance.create("root", {name: "Researcher", task: "own inbox"})).toMatchObject({id: "new-peer", name: "Researcher"});
    expect(await instance.remove("root", "peer", "peer-bot")).toMatchObject({id: "peer", status: "stopped"});
    expect(await instance.spawn("root", {task: "independent", cwd: "proj", residency: "durable"})).toMatchObject({id: "durable-work"});
    expect(topology.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      callerId: "root",
      request: expect.objectContaining({task: "independent", cwd: "proj", residency: "durable"}),
    }));
  });

});
