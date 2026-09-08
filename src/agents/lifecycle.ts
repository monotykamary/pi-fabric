import { Semaphore } from "./semaphore.js";

export const terminalAgentStatuses = new Set(["completed", "failed", "stopped", "timed_out"]);

export function assertAgentTask(request: {task: string; recursive?: boolean; extensions?: boolean}): void {
  if (typeof request.task !== "string" || !request.task.trim()) throw new Error("Agent task must not be empty");
  if (request.recursive === true && request.extensions === false) {
    throw new Error("Recursive Fabric requires extensions enabled; omit recursive or extensions: false");
  }
}

/** One semaphore per direct parent: recursive parents never hold their children's permits. */
export class AgentAdmission {
  readonly #parents = new Map<string, Semaphore>();
  starts: number;
  constructor(readonly concurrency: number, readonly maxStarts = Infinity, readonly maxDepth = Infinity, starts = 0) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Agent concurrency must be positive");
    this.starts = starts;
  }
  acquire(parentId: string, signal?: AbortSignal): Promise<() => void> {
    let semaphore = this.#parents.get(parentId);
    if (!semaphore) this.#parents.set(parentId, semaphore = new Semaphore(this.concurrency));
    return semaphore.acquire(signal);
  }
  admit(depth: number): void {
    if (depth > this.maxDepth) throw new Error(`Fabric agent depth limit reached (${this.maxDepth})`);
    if (this.starts >= this.maxStarts) throw new Error(`Fabric agent start limit reached (${this.maxStarts})`);
    this.starts++;
  }
}

export interface AgentLifecycleState<T> {
  settled: boolean;
  result: Promise<T> | undefined;
  resolve: ((result: T) => void) | undefined;
  release(): void;
  abortSignal: AbortSignal | undefined;
  abortHandler: (() => void) | undefined;
}

export function createAgentLifecycle<T>(release: () => void): AgentLifecycleState<T> {
  let resolve: ((result: T) => void) | undefined;
  const result = new Promise<T>((done) => { resolve = done; });
  return { settled: false, result, resolve, release, abortSignal: undefined, abortHandler: undefined };
}

/** Claim settlement once, detach owner cancellation, and release admission exactly once. */
export function beginAgentSettlement<T>(state: AgentLifecycleState<T>): boolean {
  if (state.settled) return false;
  state.settled = true;
  if (state.abortSignal && state.abortHandler) state.abortSignal.removeEventListener("abort", state.abortHandler);
  state.abortSignal = undefined;
  state.abortHandler = undefined;
  state.release();
  state.release = () => {};
  return true;
}

export function finishAgentSettlement<T>(state: AgentLifecycleState<T>, result: T): void {
  state.resolve?.(result);
  state.resolve = undefined;
  state.result = undefined;
}

/** Cancellation belongs to this observer, not to the participant being observed. */
export function waitForAgent<T>(result: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return result;
  if (signal.aborted) return Promise.reject(new Error("Operation aborted"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("Operation aborted")); };
    signal.addEventListener("abort", abort, { once: true });
    void result.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
