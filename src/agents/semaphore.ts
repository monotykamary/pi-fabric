interface SemaphoreWaiter {
  resolve(release: () => void): void;
  reject(error: Error): void;
  signal: AbortSignal | undefined;
  abortHandler: (() => void) | undefined;
}

export class Semaphore {
  #active = 0;
  readonly #waiters: SemaphoreWaiter[] = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Semaphore limit must be positive");
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("Operation aborted"));
    if (this.#active < this.limit) {
      this.#active++;
      return Promise.resolve(this.#releaseFunction());
    }
    return new Promise((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        resolve,
        reject,
        signal,
        abortHandler: undefined,
      };
      if (signal) {
        waiter.abortHandler = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(new Error("Operation aborted"));
        };
        signal.addEventListener("abort", waiter.abortHandler, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  #releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.#waiters.shift();
      if (waiter) {
        if (waiter.signal && waiter.abortHandler) {
          waiter.signal.removeEventListener("abort", waiter.abortHandler);
        }
        waiter.resolve(this.#releaseFunction());
        return;
      }
      this.#active--;
    };
  }
}
