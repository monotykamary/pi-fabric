/**
 * Degenerate-loop breaker for fabric_exec. Identical guest code back-to-back
 * is how lower-tier models burn a session (2026-09-15: 220x `bash echo noop`
 * on glm-5.3-flash). Display names and payload cosmetics are deliberately
 * excluded from the fingerprint: cosmetic variation is part of the loop
 * signature, not evidence of new work. Any differing code resets the count.
 */
export class FabricRepeatGuard {
  #code: string | undefined;
  #count = 0;

  constructor(
    /** Consecutive identical executions that start producing a warning. */
    readonly warnAt: number,
    /** Consecutive identical executions that get blocked outright. */
    readonly blockAt: number,
  ) {}

  observe(code: string): { count: number; blocked: boolean; warn: boolean } {
    this.#count = code === this.#code ? this.#count + 1 : 1;
    this.#code = code;
    return { count: this.#count, blocked: this.#count >= this.blockAt, warn: this.#count >= this.warnAt };
  }
}
