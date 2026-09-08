import { AgentAdmission, beginAgentSettlement, createAgentLifecycle, finishAgentSettlement, terminalAgentStatuses, waitForAgent, type AgentLifecycleState } from "./lifecycle.js";
import { validateAgentResult } from "./result.js";
import { normalizeAgentServiceRequest } from "./service-schema.js";
import type { AgentAuthorityBoundary, AgentPublicRecord, AgentControlRequest, AgentExecutionEvent, AgentExecutionResponse, AgentServiceCapabilities, AgentServiceEvent, AgentServiceOptions, AgentServiceRecord, AgentServiceRequest, AgentServiceSnapshot } from "./service-types.js";

type Entry = {
  request: AgentServiceRequest;
  record: AgentServiceRecord;
  lifecycle: AgentLifecycleState<AgentServiceRecord>;
  controller: AbortController;
  done?: Promise<void>;
  stopping?: Promise<AgentPublicRecord>;
  resuming?: boolean;
  stopAck?: Promise<void>;
  pauseAck?: Promise<void>;
  suspendRequested?: boolean;
  executing?: boolean;
  stopReason?: "stop" | "close";
  controls?: Set<Promise<unknown>>;
};
const copy = <T>(value: T): T => structuredClone(value);
const publicRecord = (record: AgentServiceRecord): AgentPublicRecord => {
  const keys = ["id", "rootId", "parentId", "depth", "generation", "name", "task", "status", "runner", "kernel", "cwd", "model", "thinking", "recursive", "startedAt", "updatedAt", "finishedAt", "currentTool", "turns", "toolCalls", "text", "value", "error", "usage", "sessionId"] as const;
  return copy(Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]))) as AgentPublicRecord;
};
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const idle = (): AgentLifecycleState<AgentServiceRecord> => ({settled: true, result: undefined, resolve: undefined, release() {}, abortSignal: undefined, abortHandler: undefined});

/** Portable one-shot agent authority. The execution port runs one participant, never a tree. */
export class AgentService {
  readonly #options: AgentServiceOptions;
  readonly #entries = new Map<string, Entry>();
  readonly #admission: AgentAdmission;
  readonly #pending = new Map<AbortController, Promise<unknown>>();
  readonly #closing = new AbortController();
  #close: Promise<void> | undefined;
  #suspend: Promise<void> | undefined;
  #suspended = false;
  #sequence = 0;
  #publication: Promise<void> = Promise.resolve();
  readonly capabilities: AgentServiceCapabilities;

  constructor(options: AgentServiceOptions) {
    if (!options.rootId) throw new Error("Agent service requires a trusted rootId");
    for (const [key, value] of Object.entries({maxStarts: options.maxStarts ?? 8, maxDepth: options.maxDepth ?? 3, maxConcurrent: options.maxConcurrent ?? 4})) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
    }
    this.#options = {...options, port: options.port};
    this.#admission = new AgentAdmission(options.maxConcurrent ?? 4, options.maxStarts ?? 8, options.maxDepth ?? 3);
    this.capabilities = Object.freeze({steer: Boolean(options.port.steer), compact: Boolean(options.port.compact), resume: Boolean(options.port.resume)});
    if (options.snapshot) this.#restore(options.snapshot);
  }

  snapshot(): AgentServiceSnapshot {
    return copy({version: 1, rootId: this.#options.rootId, starts: this.#admission.starts, sequence: this.#sequence,
      records: [...this.#entries.values()].map(({request, record}) => ({request, record}))});
  }

  async run(callerId: string, request: AgentServiceRequest, signal?: AbortSignal): Promise<AgentPublicRecord> {
    const handle = await this.spawn(callerId, request, signal);
    return this.wait(callerId, handle.id, signal);
  }

  async spawn(callerId: string, request: AgentServiceRequest, signal?: AbortSignal): Promise<AgentPublicRecord> {
    return this.#start(callerId, normalizeAgentServiceRequest(request), undefined, signal);
  }

  async wait(callerId: string, id: string, signal?: AbortSignal): Promise<AgentPublicRecord> {
    await this.#authorize(callerId);
    const entry = this.#child(callerId, id);
    const result = entry.lifecycle.result ?? Promise.resolve(copy(entry.record));
    const record = await waitForAgent(result, signal);
    await this.#authorize(callerId);
    return publicRecord(record);
  }

  async status(callerId: string, id: string): Promise<AgentPublicRecord> {
    await this.#authorize(callerId);
    return publicRecord(this.#child(callerId, id).record);
  }

  async list(callerId: string): Promise<AgentPublicRecord[]> {
    await this.#authorize(callerId);
    return [...this.#entries.values()].filter((entry) => entry.record.parentId === callerId).map((entry) => publicRecord(entry.record));
  }

  async stop(callerId: string, id: string): Promise<AgentPublicRecord> {
    await this.#authorize(callerId);
    const result = await this.#stop(this.#child(callerId, id));
    await this.#authorize(callerId);
    return publicRecord(result);
  }

  async steer(callerId: string, id: string, message: string): Promise<AgentPublicRecord> {
    if (!this.#options.port.steer) throw new Error("Hosted agents.steer is unsupported");
    if (!message.trim()) throw new Error("Steering message must not be empty");
    return this.#control(callerId, id, "steer", (request) => this.#options.port.steer!({...request, message}));
  }

  async compact(callerId: string, id: string, instructions?: string): Promise<AgentPublicRecord> {
    if (!this.#options.port.compact) throw new Error("Hosted agents.compact is unsupported");
    return this.#control(callerId, id, "compact", (request) => this.#options.port.compact!({...request, ...(instructions !== undefined ? {instructions} : {})}));
  }

  async resume(callerId: string, id: string, task?: string, signal?: AbortSignal): Promise<AgentPublicRecord> {
    if (!this.#options.port.resume) throw new Error("Hosted agents.resume is unsupported");
    await this.#authorize(callerId);
    const entry = this.#child(callerId, id);
    if (!["paused", "completed", "failed"].includes(entry.record.status) || !entry.lifecycle.settled || entry.resuming || entry.stopping) throw new Error("Only an idle paused, completed or failed agent can resume");
    entry.resuming = true;
    try {
      const request = normalizeAgentServiceRequest({...entry.request, ...(task !== undefined ? {task} : {})});
      await this.#start(callerId, request, entry, signal);
      return await this.wait(callerId, id, signal);
    } finally { entry.resuming = false; }
  }

  /** Natural root completion waits for all background descendants without fencing live parents. */
  async drain(): Promise<void> {
    for (;;) {
      const work: Promise<unknown>[] = [...this.#pending.values()];
      for (const entry of this.#entries.values()) {
        if (entry.lifecycle.result && entry.done) work.push(entry.done);
      }
      if (work.length === 0) return;
      await Promise.allSettled(work);
    }
  }

  /** Host-only graceful pause. The port, not the owner signal, quiesces participant effects. */
  suspend(): Promise<void> {
    if (this.#suspend) return this.#suspend;
    if (this.#closing.signal.aborted) return Promise.reject(new Error("Agent service is closed"));
    if (!this.#options.port.pause && [...this.#entries.values()].some((entry) => !entry.lifecycle.settled)) {
      return Promise.reject(new Error("Hosted agent suspension requires port.pause"));
    }
    this.#suspended = true;
    for (const entry of this.#entries.values()) {
      if (!entry.lifecycle.settled && !terminalAgentStatuses.has(entry.record.status)) entry.suspendRequested = true;
    }
    for (const controller of this.#pending.keys()) controller.abort();
    this.#suspend = (async () => {
      const roots = [...this.#entries.values()].filter((entry) => entry.record.parentId === this.#options.rootId);
      const paused = await Promise.allSettled(roots.map((entry) => this.#pause(entry)));
      await Promise.allSettled([...this.#pending.values()]);
      const errors = paused.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (errors.length) throw new AggregateError(errors.map((result) => result.reason), "Agent suspension failed");
      await this.drain();
    })();
    return this.#suspend;
  }

  async #pause(entry: Entry): Promise<void> {
    const children = [...this.#entries.values()].filter((child) => child.record.parentId === entry.record.id);
    const paused = await Promise.allSettled(children.map((child) => this.#pause(child)));
    const errors = paused.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "Agent descendant suspension failed");
    if (entry.executing && !entry.stopping) {
      entry.pauseAck = Promise.resolve().then(async () => {
        if (entry.executing && !entry.stopping) await this.#options.port.pause!(this.#identity(entry));
      });
      try { await entry.pauseAck; }
      catch (error) { throw new AggregateError([...errors, error], "Agent pause acknowledgment failed"); }
    }
    await entry.done;
  }

  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#closing.abort();
    for (const controller of this.#pending.keys()) controller.abort();
    this.#close = (async () => {
      const errors: unknown[] = [];
      const stopped = await Promise.allSettled([...this.#entries.values()].map((entry) => this.#stop(entry, true)));
      for (const result of stopped) if (result.status === "rejected") errors.push(result.reason);
      await Promise.allSettled([...this.#pending.values()]);
      if (errors.length) throw new AggregateError(errors, "Agent shutdown failed");
    })();
    return this.#close;
  }

  #start(callerId: string, request: AgentServiceRequest, previous?: Entry, signal?: AbortSignal): Promise<AgentPublicRecord> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, {once: true});
    if (signal?.aborted || this.#closing.signal.aborted || this.#suspended) controller.abort();
    const operation = (async () => {
      let release: (() => void) | undefined;
      try {
        await this.#authorize(callerId);
        const depth = this.#depth(callerId);
        if (controller.signal.aborted) throw new Error("Operation aborted");
        if (depth > this.#admission.maxDepth) throw new Error(`Fabric agent depth limit reached (${this.#admission.maxDepth})`);
        const id = previous?.record.id ?? crypto.randomUUID().replaceAll("-", "");
        const generation = (previous?.record.generation ?? 0) + 1;
        const prepare = {id, generation, rootId: this.#options.rootId, parentId: callerId, depth, request: copy(request), signal: controller.signal};
        const binding = await this.#options.port.prepare?.(prepare);
        release = await this.#admission.acquire(callerId, controller.signal);
        await this.#authorize(callerId);
        this.#depth(callerId);
        if (controller.signal.aborted || this.#closing.signal.aborted || previous?.stopping) throw new Error("Agent admission aborted");
        // No await between the final authority/parent check and the root-wide charge.
        this.#admission.admit(depth);
        const now = Date.now();
        const record: AgentServiceRecord = previous ? {
          ...previous.record, task: request.task, status: "queued", generation: previous.record.generation + 1,
          text: "", turns: 0, toolCalls: 0, updatedAt: now,
        } : {
          id, rootId: this.#options.rootId, parentId: callerId, depth, generation: 1,
          name: (request.name ?? request.task.split("\n", 1)[0] ?? "Fabric agent").replace(/[\r\n\t]+/g, " ").trim().slice(0, 60) || "Fabric agent",
          task: request.task, status: "queued", runner: "pi", kernel: "typescript", startedAt: now, updatedAt: now,
          turns: 0, toolCalls: 0, text: "", usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0},
          ...(request.model ? {model: request.model} : {}), ...(request.thinking ? {thinking: request.thinking} : {}),
          ...(request.cwd !== undefined ? {cwd: request.cwd} : {}), ...(request.recursive !== undefined ? {recursive: request.recursive} : {}),
        };
        delete record.finishedAt; delete record.error; delete record.value; delete record.currentTool;
        const entry: Entry = previous ?? {request, record, lifecycle: idle(), controller};
        entry.request = copy(request); entry.record = record; entry.controller = controller;
        entry.lifecycle = createAgentLifecycle<AgentServiceRecord>(release);
        release = undefined;
        this.#entries.set(record.id, entry);
        this.#pending.delete(controller);
        // Admission cancellation detaches here. Background execution has a distinct owner signal.
        signal?.removeEventListener("abort", abort);
        let acknowledge!: () => void;
        const admitted = new Promise<void>((resolve) => { acknowledge = resolve; });
        entry.done = this.#drive(entry, binding, Boolean(previous), acknowledge);
        await admitted;
        await this.#authorize(callerId);
        return publicRecord(record);
      } finally {
        release?.();
        signal?.removeEventListener("abort", abort);
      }
    })();
    this.#pending.set(controller, operation);
    void operation.finally(() => this.#pending.delete(controller)).catch(() => {});
    return operation;
  }

  async #drive(entry: Entry, binding: unknown, resume: boolean, admitted: () => void): Promise<void> {
    const generation = entry.record.generation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeout = false;
    let responded = false;
    try {
      await this.#publish("admitted", entry);
      admitted();
      await this.#authorize(entry.record.parentId);
      if (entry.controller.signal.aborted) throw new Error("Agent start aborted");
      entry.record.status = "running";
      await this.#publish("running", entry);
      await this.#authorize(entry.record.parentId);
      if (entry.controller.signal.aborted) throw new Error("Agent start aborted");
      const request = {
        ...this.#identity(entry), depth: entry.record.depth, request: copy(entry.request), signal: entry.controller.signal,
        binding, ...(entry.record.checkpoint !== undefined ? {checkpoint: copy(entry.record.checkpoint)} : {}),
        emit: async (event: AgentExecutionEvent) => {
          const assertCurrent = () => {
            if (!entry.executing || entry.lifecycle.settled || entry.controller.signal.aborted || entry.record.generation !== generation || entry.record.status !== "running") throw new Error("Stale agent execution event");
          };
          assertCurrent();
          if (event.type !== "checkpoint" && event.type !== "progress") throw new Error("Unsupported agent execution event");
          const saved = copy(event);
          await this.#publish(saved.type, entry, undefined, () => {
            if (saved.type === "checkpoint") entry.record.checkpoint = saved.checkpoint;
            else {
              for (const key of ["text", "turns", "toolCalls", "currentTool", "usage"] as const) {
                if (saved[key] !== undefined) Object.assign(entry.record, {[key]: saved[key]});
              }
            }
          }, assertCurrent);
        },
      };
      if (entry.request.timeoutMs) timer = setTimeout(() => {
        if (entry.suspendRequested) return;
        timeout = true;
        void this.#stop(entry).catch(() => {});
      }, entry.request.timeoutMs);
      const execute = resume ? this.#options.port.resume! : this.#options.port.execute;
      entry.executing = true;
      let response: AgentExecutionResponse;
      try { response = await execute.call(this.#options.port, request); }
      finally { entry.executing = false; }
      if (!["completed", "failed", "stopped", "timed_out", "paused"].includes(response.status)) throw new Error("Invalid agent execution response status");
      await this.#authorize(entry.record.parentId, response.status === "paused" ? {checkpoint: true} : undefined);
      if (entry.record.generation !== generation || entry.lifecycle.settled) throw new Error("Stale agent execution response");
      this.#applyResponse(entry, response);
      responded = true;
    } catch (error) {
      entry.record.status = "failed";
      entry.record.error = errorText(error);
    } finally {
      admitted();
      if (timer) clearTimeout(timer);
      await Promise.allSettled([...(entry.controls ?? []), ...(entry.stopAck ? [entry.stopAck] : []), ...(entry.pauseAck ? [entry.pauseAck] : [])]);
      if (entry.suspendRequested && !entry.controller.signal.aborted) {
        entry.record.status = "paused"; delete entry.record.error; delete entry.record.finishedAt;
      }
      if (entry.controller.signal.aborted) {
        if (entry.stopReason === "close") {
          if (!responded || !["completed", "failed"].includes(entry.record.status)) { entry.record.status = "paused"; delete entry.record.error; }
        } else entry.record.status = timeout ? "timed_out" : "stopped";
      }
      try { await this.#options.port.cleanup?.(this.#identity(entry)); }
      catch (error) { entry.record.status = "failed"; entry.record.error = `Agent cleanup failed: ${errorText(error)}`; }
      validateAgentResult(entry.record, entry.request.schema);
      delete entry.record.currentTool;
      if (terminalAgentStatuses.has(entry.record.status)) entry.record.finishedAt = Date.now();
      if (beginAgentSettlement(entry.lifecycle)) {
        try { await this.#publish("settled", entry); }
        catch (error) { entry.record.status = "failed"; entry.record.error = `Agent publication failed: ${errorText(error)}`; }
        finishAgentSettlement(entry.lifecycle, copy(entry.record));
      }
    }
  }

  #applyResponse(entry: Entry, response: AgentExecutionResponse): void {
    // Port output cannot overwrite host-owned identifiers, lineage or admission metadata.
    entry.record.status = response.status;
    for (const key of ["text", "value", "error", "usage", "checkpoint", "sessionId"] as const) {
      if (response[key] !== undefined) Object.assign(entry.record, {[key]: copy(response[key])});
    }
  }

  #stop(entry: Entry, preservePaused = false): Promise<AgentPublicRecord> {
    if (entry.stopping) return entry.stopping;
    entry.stopReason = preservePaused ? "close" : "stop";
    const work = (async () => {
      const active = !entry.lifecycle.settled;
      entry.controller.abort();
      const descendants = [...this.#entries.values()].filter((child) => child.record.parentId === entry.record.id);
      const operations: Promise<unknown>[] = descendants.map((child) => this.#stop(child, preservePaused));
      if (active && this.#options.port.stop) {
        entry.stopAck = Promise.resolve().then(() => this.#options.port.stop!(this.#identity(entry)));
        operations.push(entry.stopAck);
      }
      if (entry.done) operations.push(entry.done);
      const settled = await Promise.allSettled(operations);
      if (entry.record.status === "paused" && !preservePaused) {
        entry.record.status = "stopped"; entry.record.finishedAt = Date.now();
        await this.#publish("settled", entry);
      }
      const errors = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (errors.length) throw new AggregateError(errors.map((result) => result.reason), "Agent stop failed");
      return publicRecord(entry.record);
    })();
    entry.stopping = work;
    return work;
  }

  async #control(callerId: string, id: string, control: "steer" | "compact", invoke: (request: AgentControlRequest) => Promise<void>): Promise<AgentPublicRecord> {
    await this.#authorize(callerId);
    const entry = this.#child(callerId, id);
    if (entry.record.status !== "running" || entry.stopping) throw new Error("Agent is not running");
    const generation = entry.record.generation;
    const pending = Promise.resolve().then(async () => {
      await this.#authorize(callerId);
      if (entry.record.generation !== generation || entry.controller.signal.aborted || entry.lifecycle.settled) throw new Error("Stale agent control");
      await invoke(this.#identity(entry));
    });
    (entry.controls ??= new Set()).add(pending);
    try { await pending; } finally { entry.controls.delete(pending); }
    await this.#authorize(callerId);
    if (entry.record.generation !== generation || entry.controller.signal.aborted) throw new Error("Stale agent control acknowledgment");
    await this.#publish("control", entry, control);
    return publicRecord(entry.record);
  }

  #identity(entry: Entry): AgentControlRequest {
    const {id, rootId, parentId, generation} = entry.record;
    return {id, rootId, parentId, generation};
  }

  async #authorize(callerId: string, boundary?: AgentAuthorityBoundary): Promise<void> {
    if (callerId !== this.#options.rootId && !this.#entries.has(callerId)) throw new Error("Unknown agent caller");
    if (this.#suspended && !boundary?.checkpoint) throw new Error("Agent service is paused");
    await this.#options.assertAuthority?.(callerId, boundary);
    if (this.#suspended && !boundary?.checkpoint) throw new Error("Agent service is paused");
  }

  #child(callerId: string, id: string): Entry {
    const entry = this.#entries.get(id);
    if (!entry || entry.record.parentId !== callerId) throw new Error(`Unknown direct child agent: ${id}`);
    return entry;
  }

  #depth(callerId: string): number {
    if (this.#closing.signal.aborted) throw new Error("Agent service is closed");
    if (this.#suspended) throw new Error("Agent service is paused");
    if (callerId === this.#options.rootId) return 1;
    const parent = this.#entries.get(callerId);
    if (!parent || parent.record.status !== "running" || parent.stopping || parent.controller.signal.aborted || parent.request.recursive === false) throw new Error("Agent parent cannot admit children");
    return parent.record.depth + 1;
  }

  async #publish(type: AgentServiceEvent["type"], entry: Entry, control?: AgentServiceEvent["control"], update?: () => void, assertCurrent?: () => void): Promise<void> {
    const boundary = type === "checkpoint" || type === "settled" ? {checkpoint: true} : undefined;
    const generation = entry.record.generation;
    await this.#authorize(entry.record.parentId, boundary);
    const publication = this.#publication.then(async () => {
      await this.#authorize(entry.record.parentId, boundary);
      if (entry.record.generation !== generation) throw new Error("Stale agent publication");
      assertCurrent?.();
      // Commit event mutations only after serialized, phase-matched lease authorization.
      update?.();
      entry.record.updatedAt = Date.now();
      const event: AgentServiceEvent = {version: 1, sequence: ++this.#sequence, type, record: copy(entry.record), ...(control ? {control} : {})};
      await this.#options.onEvent?.(event);
    });
    this.#publication = publication.catch(() => {});
    await publication;
  }

  #restore(snapshot: AgentServiceSnapshot): void {
    const saved = copy(snapshot);
    const newRoot = this.#options.restorePolicy === "new-root";
    if (newRoot && saved.rootId !== this.#options.rootId) {
      const oldRoot = saved.rootId;
      saved.rootId = this.#options.rootId;
      for (const {record} of saved.records) {
        if (record.rootId !== oldRoot) throw new Error("Invalid agent snapshot root");
        record.rootId = saved.rootId;
        if (record.parentId === oldRoot) record.parentId = saved.rootId;
      }
    }
    if (saved.version !== 1 || saved.rootId !== this.#options.rootId || !Number.isSafeInteger(saved.starts) || saved.starts < 0 || (!newRoot && saved.starts > this.#admission.maxStarts) || !Number.isSafeInteger(saved.sequence) || saved.sequence < 0 || !Array.isArray(saved.records)) throw new Error("Invalid agent service snapshot");
    let generations = 0;
    for (const item of saved.records) {
      const request = normalizeAgentServiceRequest(item.request);
      const record = item.record;
      if (!record.id || record.id === saved.rootId || this.#entries.has(record.id) || record.rootId !== saved.rootId || !Number.isSafeInteger(record.depth) || record.depth < 1 || record.depth > this.#admission.maxDepth || !Number.isSafeInteger(record.generation) || record.generation < 1 || !["queued", "running", "paused", ...terminalAgentStatuses].includes(record.status)) throw new Error("Invalid agent snapshot record");
      generations += record.generation;
      if (record.status === "running" || record.status === "queued") { record.status = "paused"; delete record.finishedAt; }
      this.#entries.set(record.id, {request, record, lifecycle: idle(), controller: new AbortController()});
    }
    for (const {record} of this.#entries.values()) {
      const parent = this.#entries.get(record.parentId);
      if (record.parentId === saved.rootId ? record.depth !== 1 : !parent || parent.record.depth + 1 !== record.depth) throw new Error("Invalid agent snapshot lineage");
    }
    if (saved.starts > generations) throw new Error("Invalid agent snapshot admission count");
    this.#admission.starts = newRoot ? 0 : saved.starts;
    this.#sequence = saved.sequence;
  }
}
