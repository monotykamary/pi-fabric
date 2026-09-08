import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService, createAgentServiceClient, createAgentServiceHandler, type AgentAuthorityBoundary, type AgentPrepareRequest, type AgentExecutionPort, type AgentExecutionRequest, type AgentExecutionResponse, type AgentServiceOptions, type AgentServiceEvent } from "../src/agents.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return {promise, resolve};
};
const services: AgentService[] = [];
const service = (port: AgentExecutionPort, options: Partial<AgentServiceOptions> = {}) => {
  const instance = new AgentService({rootId: "root", port, ...options});
  services.push(instance);
  return instance;
};
const held = () => {
  const entered = deferred<AgentExecutionRequest>();
  const result = deferred<AgentExecutionResponse>();
  const execute = vi.fn(async (request: AgentExecutionRequest) => {
    request.signal.addEventListener("abort", () => result.resolve({status: "stopped"}), {once: true});
    entered.resolve(request);
    return result.promise;
  });
  const cleanup = vi.fn(async () => {});
  return {entered, result, port: {execute, cleanup}};
};
const authority = () => {
  const state = {paused: false, lease: true};
  const assertAuthority = vi.fn((_caller: string, boundary?: AgentAuthorityBoundary) => {
    if (!state.lease) throw new Error("lease revoked");
    if (state.paused && !boundary?.checkpoint) throw new Error("product paused");
  });
  return {state, assertAuthority};
};
afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(services.splice(0).map((instance) => instance.close()));
  vi.restoreAllMocks();
});

describe("host-only AgentService suspension", () => {
  it("denies ordinary final admission when product pause arrives during asynchronous prepare", async () => {
    const preparing = deferred<void>();
    const release = deferred<void>();
    const auth = authority();
    const execute = vi.fn();
    const instance = service({execute, prepare: async () => {preparing.resolve(); await release.promise;}}, auth);
    const admission = instance.spawn("root", {task: "preparing"});
    const rejected = expect(admission).rejects.toThrow("product paused");
    await preparing.promise;
    auth.state.paused = true;
    release.resolve();
    await rejected;
    expect(instance.snapshot()).toMatchObject({starts: 0, records: []});
    expect(execute).not.toHaveBeenCalled();
    expect(auth.assertAuthority.mock.calls.every(([, boundary]) => !boundary?.checkpoint)).toBe(true);
  });

  it("fences and drains pending prepare without charging or invoking execute", async () => {
    const preparing = deferred<AbortSignal>();
    const release = deferred<void>();
    const execute = vi.fn();
    const prepare = vi.fn(async (request: AgentPrepareRequest) => {preparing.resolve(request.signal); await release.promise;});
    const instance = service({execute, prepare});
    const admission = instance.spawn("root", {task: "preparing"});
    const rejected = expect(admission).rejects.toThrow(/paused|aborted/);
    const signal = await preparing.promise;
    let suspended = false;
    const suspension = instance.suspend().then(() => {suspended = true;});
    expect(signal.aborted).toBe(true);
    await expect(instance.spawn("root", {task: "late"})).rejects.toThrow("paused");
    expect(suspended).toBe(false);
    expect(prepare).toHaveBeenCalledOnce();
    release.resolve();
    await rejected;
    await suspension;
    await instance.close();
    expect(instance.snapshot()).toMatchObject({starts: 0, records: []});
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not abort an admitted owner while its admitted publication is pending", async () => {
    const admitted = deferred<void>();
    const release = deferred<void>();
    let owner!: AbortSignal;
    const execute = vi.fn();
    const pause = vi.fn(async () => {});
    const cleanup = vi.fn(async () => {});
    const instance = service({execute, pause, cleanup, prepare: async (request) => {owner = request.signal;}}, {
      onEvent: async (event) => {if (event.type === "admitted") {admitted.resolve(); await release.promise;}},
    });
    const admission = instance.spawn("root", {task: "admitted"});
    const rejected = expect(admission).rejects.toThrow("paused");
    await admitted.promise;
    const suspension = instance.suspend();
    expect(owner.aborted).toBe(false);
    release.resolve();
    await rejected;
    await suspension;
    expect(instance.snapshot().starts).toBe(1);
    expect(instance.snapshot().records[0]!.record.status).toBe("paused");
    expect(owner.aborted).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("checkpoints an abort-dependent model via port.pause, never the execution signal, and awaits its acknowledgment", async () => {
    const host = held();
    const auth = authority();
    const model = new AbortController();
    const pausing = deferred<void>();
    const ack = deferred<void>();
    const events: AgentServiceEvent[] = [];
    model.signal.addEventListener("abort", () => host.result.resolve({status: "paused", checkpoint: {private: "final transcript"}}));
    const pause = vi.fn(async () => {
      const request = await host.entered.promise;
      await request.emit({type: "checkpoint", checkpoint: {private: "before model interruption"}});
      model.abort();
      pausing.resolve();
      await ack.promise;
    });
    const steer = vi.fn(async () => {});
    const compact = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const instance = service({...host.port, pause, steer, compact, stop, resume: host.port.execute}, {...auth, onEvent: (event) => {events.push(event);}});
    const client = createAgentServiceClient(createAgentServiceHandler(instance, "root"), instance.capabilities);
    const child = await client.spawn({task: "quiet model"});
    const request = await host.entered.promise;
    const observer = new AbortController();
    const waiter = expect(instance.wait("root", child.id, observer.signal)).rejects.toThrow("aborted");
    observer.abort();
    await waiter;
    expect(request.signal.aborted).toBe(false);
    const waitingAtPause = expect(client.wait(child.id)).rejects.toThrow(/paused/);
    auth.state.paused = true;
    await expect(request.emit({type: "progress", text: "late"})).rejects.toThrow("product paused");
    await expect(client.status(child.id)).rejects.toThrow("product paused");
    await expect(client.list()).rejects.toThrow("product paused");
    await expect(client.wait(child.id)).rejects.toThrow("product paused");
    await expect(client.stop(child.id)).rejects.toThrow("product paused");
    await expect(client.steer(child.id, "late")).rejects.toThrow("product paused");
    await expect(client.compact(child.id)).rejects.toThrow("product paused");
    await expect(client.resume(child.id)).rejects.toThrow("product paused");
    const suspension = instance.suspend();
    expect(instance.suspend()).toBe(suspension);
    await pausing.promise;
    expect(request.signal.aborted).toBe(false);
    expect(model.signal.aborted).toBe(true);
    expect(host.port.cleanup).not.toHaveBeenCalled();
    ack.resolve();
    await suspension;
    await waitingAtPause;
    expect(host.port.cleanup).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalledWith({rootId: "root", parentId: "root", id: child.id, generation: 1});
    expect(steer).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    const saved = instance.snapshot();
    expect(saved.records[0]!.record).toMatchObject({status: "paused", checkpoint: {private: "final transcript"}});
    expect(events.map((event) => event.type)).toEqual(["admitted", "running", "checkpoint", "settled"]);
    expect(events.at(-1)!.record.checkpoint).toEqual({private: "final transcript"});
    await instance.close();
    expect(instance.snapshot()).toEqual(saved);
    expect(stop).not.toHaveBeenCalled();
    const restored = service({execute: host.port.execute}, {snapshot: saved});
    const publicClient = createAgentServiceClient(createAgentServiceHandler(restored, "root"));
    expect(JSON.stringify(await publicClient.list())).not.toMatch(/checkpoint|transcript/);
    expect(await publicClient.wait(child.id)).not.toHaveProperty("checkpoint");
  });

  it("waits for an uncooperative side-effect tool's safe release before interrupting its model, even past timeout", async () => {
    vi.useFakeTimers();
    const host = held();
    const safe = deferred<void>();
    const pausing = deferred<void>();
    const model = new AbortController();
    model.signal.addEventListener("abort", () => host.result.resolve({status: "paused", checkpoint: "safe effect completed"}));
    const instance = service({...host.port, pause: async () => {
      pausing.resolve();
      await safe.promise;
      model.abort();
    }});
    await instance.spawn("root", {task: "effect", timeoutMs: 100});
    const request = await host.entered.promise;
    let suspended = false;
    const suspension = instance.suspend().then(() => {suspended = true;});
    await pausing.promise;
    await vi.advanceTimersByTimeAsync(1000);
    expect(suspended).toBe(false);
    expect(request.signal.aborted).toBe(false);
    expect(model.signal.aborted).toBe(false);
    expect(host.port.cleanup).not.toHaveBeenCalled();
    safe.resolve();
    await suspension;
    expect(request.signal.aborted).toBe(false);
    expect(instance.snapshot().records[0]!.record).toMatchObject({status: "paused", checkpoint: "safe effect completed"});
  });

  it("rejects missing pause capability before fencing authority, leaving explicit stop abortive", async () => {
    const host = held();
    const instance = service(host.port);
    const child = await instance.spawn("root", {task: "unsupported"});
    const request = await host.entered.promise;
    await expect(instance.suspend()).rejects.toThrow("requires port.pause");
    expect(request.signal.aborted).toBe(false);
    expect(await instance.status("root", child.id)).toMatchObject({status: "running"});
    await request.emit({type: "progress", text: "still authorized"});
    expect(await instance.stop("root", child.id)).toMatchObject({status: "stopped"});
    expect(request.signal.aborted).toBe(true);
  });

  it("cancels semaphore-queued admissions without charging or aborting the active owner", async () => {
    const host = held();
    const prepared = deferred<void>();
    const instance = service({...host.port,
      prepare: async (request) => {if (request.request.task === "queued") prepared.resolve();},
      pause: async () => {host.result.resolve({status: "paused", checkpoint: "active"});},
    }, {maxConcurrent: 1});
    await instance.spawn("root", {task: "active"});
    const owner = await host.entered.promise;
    const queued = instance.spawn("root", {task: "queued"});
    const rejected = expect(queued).rejects.toThrow(/paused|aborted/);
    await prepared.promise;
    await instance.suspend();
    await rejected;
    expect(owner.signal.aborted).toBe(false);
    expect(host.port.execute).toHaveBeenCalledOnce();
    expect(instance.snapshot().starts).toBe(1);
    expect(instance.snapshot().records).toHaveLength(1);
  });

  it("pauses descendants and awaits child cleanup before parent pause, preserving prior terminal records", async () => {
    const started = Array.from({length: 3}, () => deferred<AgentExecutionRequest>());
    const results = Array.from({length: 3}, () => deferred<AgentExecutionResponse>());
    const cleaningLeaf = deferred<void>();
    const releaseLeaf = deferred<void>();
    const requests = new Map<string, AgentExecutionRequest>();
    const order: string[] = [];
    const instance = service({
      execute: async (request) => {
        if (request.request.task === "terminal") return {status: "completed", text: "done", checkpoint: "durable"};
        requests.set(request.id, request);
        request.signal.addEventListener("abort", () => results[request.depth - 1]!.resolve({status: "stopped"}), {once: true});
        started[request.depth - 1]!.resolve(request);
        return results[request.depth - 1]!.promise;
      },
      pause: async ({id, generation}) => {
        const request = requests.get(id)!;
        expect(generation).toBe(request.generation);
        expect(request.signal.aborted).toBe(false);
        order.push(`pause:${request.depth}`);
        await request.emit({type: "checkpoint", checkpoint: {depth: request.depth}});
        results[request.depth - 1]!.resolve({status: "paused"});
      },
      cleanup: async ({id}) => {
        const request = requests.get(id);
        if (!request) return;
        order.push(`cleanup:${request.depth}`);
        if (request.depth === 3) {cleaningLeaf.resolve(); await releaseLeaf.promise;}
      },
    }, {maxConcurrent: 1});
    const terminal = await instance.run("root", {task: "terminal"});
    const parent = await instance.spawn("root", {task: "parent"});
    await started[0]!.promise;
    const child = await instance.spawn(parent.id, {task: "child"});
    await started[1]!.promise;
    await instance.spawn(child.id, {task: "leaf"});
    await started[2]!.promise;
    const before = instance.snapshot().records.find(({record}) => record.id === terminal.id);
    const suspension = instance.suspend();
    await cleaningLeaf.promise;
    expect(order).toEqual(["pause:3", "cleanup:3"]);
    expect([...requests.values()].every((request) => !request.signal.aborted)).toBe(true);
    releaseLeaf.resolve();
    await suspension;
    expect(order).toEqual(["pause:3", "cleanup:3", "pause:2", "cleanup:2", "pause:1", "cleanup:1"]);
    const saved = instance.snapshot();
    expect(saved.records.find(({record}) => record.id === terminal.id)).toEqual(before);
    expect(saved.records.filter(({record}) => record.id !== terminal.id).map(({record}) => record.status)).toEqual(["paused", "paused", "paused"]);
    await instance.close();
    expect(instance.snapshot()).toEqual(saved);
  });

  it.each([
    {type: "progress" as const, revoke: false, permitted: false},
    {type: "checkpoint" as const, revoke: false, permitted: true},
    {type: "checkpoint" as const, revoke: true, permitted: false},
  ])("reauthorizes queued $type publication in the same phase (revoked=$revoke)", async ({type, revoke, permitted}) => {
    const host = held();
    const auth = authority();
    const blocking = deferred<void>();
    const release = deferred<void>();
    const checked = deferred<void>();
    const events: AgentServiceEvent[] = [];
    const phases: boolean[] = [];
    let tracking = false;
    const instance = service(host.port, {
      assertAuthority: (caller, boundary) => {
        if (tracking) {phases.push(Boolean(boundary?.checkpoint)); checked.resolve();}
        auth.assertAuthority(caller, boundary);
      },
      onEvent: async (event) => {
        events.push(event);
        if (event.type === "progress" && event.record.text === "block") {blocking.resolve(); await release.promise;}
      },
    });
    await instance.spawn("root", {task: "publication queue"});
    const request = await host.entered.promise;
    const blocker = request.emit({type: "progress", text: "block"});
    await blocking.promise;
    tracking = true;
    const queued = request.emit(type === "checkpoint" ? {type, checkpoint: "private queued"} : {type, text: "late progress"});
    const observed = permitted ? expect(queued).resolves.toBeUndefined() : expect(queued).rejects.toThrow(revoke ? "lease revoked" : "product paused");
    await checked.promise;
    auth.state.paused = true;
    if (revoke) auth.state.lease = false;
    release.resolve();
    await blocker;
    await observed;
    expect(phases).toEqual([type === "checkpoint", type === "checkpoint"]);
    tracking = false;
    expect(events.filter((event) => event.type === "checkpoint")).toHaveLength(permitted ? 1 : 0);
    expect(instance.snapshot().records[0]!.record.text).toBe("block");
    if (permitted) expect(instance.snapshot().records[0]!.record.checkpoint).toBe("private queued");
    else expect(instance.snapshot().records[0]!.record).not.toHaveProperty("checkpoint");
    host.result.resolve({status: "paused"});
    await instance.drain();
    if (revoke) expect(events.some((event) => event.type === "settled")).toBe(false);
  });

  it("rejects revoked-lease emits and paused final checkpoints without persisting either", async () => {
    const host = held();
    const auth = authority();
    const events: AgentServiceEvent[] = [];
    const instance = service(host.port, {...auth, onEvent: (event) => {events.push(event);}});
    await instance.spawn("root", {task: "revoked"});
    const request = await host.entered.promise;
    await request.emit({type: "checkpoint", checkpoint: "authorized"});
    auth.state.paused = true;
    auth.state.lease = false;
    await expect(request.emit({type: "checkpoint", checkpoint: "revoked emit"})).rejects.toThrow("lease revoked");
    host.result.resolve({status: "paused", checkpoint: "revoked response"});
    await instance.drain();
    expect(instance.snapshot().records[0]!.record).toMatchObject({status: "failed", checkpoint: "authorized"});
    expect(events.map((event) => event.type)).toEqual(["admitted", "running", "checkpoint"]);
    expect(JSON.stringify(events)).not.toMatch(/revoked emit|revoked response/);
  });

  it("rejects old-generation and terminal execution events, including during cleanup", async () => {
    const first = held();
    const second = held();
    const cleaning = deferred<void>();
    const release = deferred<void>();
    const instance = service({...first.port, resume: second.port.execute, cleanup: async ({generation}) => {
      if (generation === 1) {cleaning.resolve(); await release.promise;}
    }});
    const child = await instance.spawn("root", {task: "generation one"});
    const old = await first.entered.promise;
    first.result.resolve({status: "paused", checkpoint: "first"});
    await cleaning.promise;
    await expect(old.emit({type: "checkpoint", checkpoint: "terminal overwrite"})).rejects.toThrow("Stale agent execution event");
    release.resolve();
    await instance.drain();
    const continuation = instance.resume("root", child.id);
    const current = await second.entered.promise;
    expect(current.generation).toBe(2);
    await expect(old.emit({type: "progress", text: "old"})).rejects.toThrow("Stale agent execution event");
    await expect(old.emit({type: "checkpoint", checkpoint: "old"})).rejects.toThrow("Stale agent execution event");
    await current.emit({type: "checkpoint", checkpoint: "second"});
    second.result.resolve({status: "completed"});
    expect(await continuation).not.toHaveProperty("checkpoint");
    expect(instance.snapshot().records[0]!.record.checkpoint).toBe("second");
    await expect(current.emit({type: "checkpoint", checkpoint: "too late"})).rejects.toThrow("Stale agent execution event");
  });

  it("rejects checkpoint authorization that finishes after execution has become terminal", async () => {
    const host = held();
    const checked = deferred<void>();
    const release = deferred<void>();
    let gate = false;
    const events: AgentServiceEvent[] = [];
    const instance = service(host.port, {
      assertAuthority: async (_caller, boundary) => {
        if (gate && boundary?.checkpoint) {gate = false; checked.resolve(); await release.promise;}
      },
      onEvent: (event) => {events.push(event);},
    });
    await instance.spawn("root", {task: "terminal race"});
    const request = await host.entered.promise;
    gate = true;
    const emission = request.emit({type: "checkpoint", checkpoint: "late authorization"});
    const rejected = expect(emission).rejects.toThrow("Stale agent execution event");
    await checked.promise;
    host.result.resolve({status: "completed"});
    await instance.drain();
    release.resolve();
    await rejected;
    expect(instance.snapshot().records[0]!.record).not.toHaveProperty("checkpoint");
    expect(events.map((event) => event.type)).toEqual(["admitted", "running", "settled"]);
  });

  it.each(["completed", "failed", "stopped"] as const)("settles an interrupted %s response as paused without elevating its response authority", async (status) => {
    const host = held();
    const instance = service({...host.port, pause: async () => {
      const request = await host.entered.promise;
      await request.emit({type: "checkpoint", checkpoint: "authorized pause emit"});
      host.result.resolve({status, checkpoint: "ordinary response must not bypass pause"});
    }});
    await instance.spawn("root", {task: "interrupted response"});
    const request = await host.entered.promise;
    await instance.suspend();
    expect(request.signal.aborted).toBe(false);
    expect(instance.snapshot().records[0]!.record).toMatchObject({status: "paused", checkpoint: "authorized pause emit"});
    await expect(instance.list("root")).rejects.toThrow("paused");
  });

  it("reports pause acknowledgment failure without pretending graceful cancellation; explicit close remains available", async () => {
    const host = held();
    const instance = service({...host.port, pause: async () => {throw new Error("unsafe to pause");}});
    await instance.spawn("root", {task: "pause failure"});
    const request = await host.entered.promise;
    await expect(instance.suspend()).rejects.toThrow("Agent suspension failed");
    expect(request.signal.aborted).toBe(false);
    expect(host.port.cleanup).not.toHaveBeenCalled();
    await instance.close();
    expect(request.signal.aborted).toBe(true);
    expect(host.port.cleanup).toHaveBeenCalledOnce();
    expect(instance.snapshot().records[0]!.record.status).toBe("paused");
  });
});
