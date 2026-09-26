import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FabricCacheHoldOptions, FabricCacheHoldResult, FabricCacheLease } from "./types.js";

/** Optional upstream proposal. No monkey-patching, settings writes, or replay fallback. */
type NativeWarmingContext = ExtensionContext & { acquireCacheWarming?: (mode: "idle") => (() => void) };
interface OwnedLease {
  value: FabricCacheLease;
  timer: ReturnType<typeof setTimeout>;
  detach: () => void;
  invocationId: string;
}
export const MAX_CACHE_LEASE_MS = 30 * 60_000;
export const MAX_CACHE_LEASES = 128;

export class CacheLeases {
  readonly #leases = new Map<string, OwnedLease>();
  readonly #unsubscribe: Array<() => void> = [];
  #releaseNative: (() => void) | undefined;
  #binding: string | undefined;
  #failedBinding: string | undefined;
  #cleanupError: string | null = null;
  #closed = false;

  constructor(private readonly pi: ExtensionAPI, private readonly sessionId: string) {}

  supported(context: ExtensionContext): boolean {
    return typeof (context as NativeWarmingContext).acquireCacheWarming === "function";
  }
  get cleanupError(): string | null { return this.#cleanupError; }
  values(): FabricCacheLease[] { return [...this.#leases.values()].map(lease => ({ ...lease.value })); }

  #key(context: ExtensionContext): string {
    return createHash("sha256").update(JSON.stringify([
      context.sessionManager.getSessionId(), context.model?.provider, context.model?.id,
      context.thinkingLevel ?? this.pi.getThinkingLevel(), context.getSystemPrompt(),
      [...this.pi.getActiveTools()].sort(),
    ])).digest("hex");
  }

  reconcile(context: ExtensionContext): void {
    if (!this.#binding && !this.#failedBinding) return;
    const key = this.#key(context);
    if (this.#binding && (this.#binding !== key || !this.supported(context))) this.invalidate();
    if (this.#failedBinding !== key) this.#failedBinding = undefined;
  }

  #listen(): void {
    if (this.#unsubscribe.length) return;
    const invalidate = () => { this.invalidate(); };
    this.#unsubscribe.push(
      this.pi.on("session_start", invalidate),
      this.pi.on("session_before_switch", invalidate),
      this.pi.on("session_before_fork", invalidate),
      this.pi.on("session_tree", invalidate),
      this.pi.on("session_before_compact", invalidate),
      this.pi.on("session_compact", invalidate),
      this.pi.on("model_select", invalidate),
      this.pi.on("session_shutdown", invalidate),
    );
    this.#unsubscribe.push(this.pi.on("cache_warming_decision", (_event, context) => {
      // Revoke only our interest. Never override Pi's or another owner's decision.
      this.reconcile(context);
    }));
    this.#unsubscribe.push(this.pi.on("before_agent_start", (_event, context) => { this.reconcile(context); }));
  }

  hold(options: FabricCacheHoldOptions, context: ExtensionContext, scope: FabricCacheLease["scope"],
    invocationId: string, signal?: AbortSignal): FabricCacheHoldResult {
    signal?.throwIfAborted();
    if (this.#closed || context.sessionManager.getSessionId() !== this.sessionId) {
      return { status: "unavailable", reason: "Session or provider generation has ended" };
    }
    this.reconcile(context);
    if (!this.supported(context)) return { status: "unsupported", reason: "Native scoped cache warming is unavailable; no fallback requests are made" };
    if (options.maxCostUsd !== undefined || options.maxRefreshes !== undefined) {
      return { status: "unsupported", reason: "Native cost and refresh-count admission is unavailable; requested bounds cannot be enforced" };
    }
    if (!context.model) return { status: "unavailable", reason: "No current model" };
    if (this.#cleanupError) return { status: "unavailable", reason: this.#cleanupError };
    if (this.#leases.size >= MAX_CACHE_LEASES) return { status: "unavailable", reason: "Cache lease capacity reached" };
    const key = this.#key(context);
    if (this.#failedBinding === key) return { status: "unavailable", reason: "Native acquisition failed for this binding; no automatic retry" };
    this.#listen();
    if (!this.#releaseNative) {
      try {
        const release = (context as NativeWarmingContext).acquireCacheWarming!("idle");
        if (typeof release !== "function") throw new Error("Invalid native lease");
        this.#releaseNative = release;
        this.#binding = key;
      } catch {
        this.#failedBinding = key;
        return { status: "unavailable", reason: "Native acquisition failed for this binding; no automatic retry" };
      }
    }
    const value: FabricCacheLease = { id: randomUUID(), scope, sessionId: this.sessionId,
      model: `${context.model.provider}/${context.model.id}`, expiresAt: Date.now() + options.durationMs };
    const timer = setTimeout(() => this.#drop(value.id), options.durationMs);
    timer.unref();
    const abort = () => { this.#drop(value.id); };
    const detach = () => signal?.removeEventListener("abort", abort);
    this.#leases.set(value.id, { value, timer, detach, invocationId });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { this.#drop(value.id); signal.throwIfAborted(); }
    return { status: "held", ...value };
  }

  release(id: string): { released: boolean; cleanupError: string | null } {
    const lease = this.#leases.get(id);
    if (lease?.value.scope === "component") throw new Error("A component cache lease can only be released by its owning scope");
    return { released: this.#drop(id), cleanupError: this.#cleanupError };
  }
  dispose(id: string): void {
    this.#drop(id);
    if (this.#cleanupError) throw new Error(this.#cleanupError);
  }
  invocationEnded(id: string): void {
    // Successful holds survive the allocating fabric_exec, not its operation signal.
    for (const lease of this.#leases.values()) {
      if (lease.value.scope === "session" && lease.invocationId === id) lease.detach();
    }
  }
  #drop(id: string): boolean {
    const lease = this.#leases.get(id);
    if (!lease) return false;
    this.#leases.delete(id);
    clearTimeout(lease.timer);
    lease.detach();
    if (this.#leases.size === 0) this.#release();
    return true;
  }
  #release(): void {
    try {
      this.#releaseNative?.();
      this.#releaseNative = undefined;
      this.#binding = undefined;
      this.#cleanupError = null;
    } catch {
      // Retain the disposer for final cleanup; never claim native release succeeded.
      this.#cleanupError = "Native cache lease cleanup failed";
    }
  }
  invalidate(): void {
    for (const id of this.#leases.keys()) this.#drop(id);
    this.#failedBinding = undefined;
  }
  close(): void {
    this.#closed = true;
    this.invalidate();
    this.#release();
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    if (this.#cleanupError) throw new Error(this.#cleanupError);
  }
}
