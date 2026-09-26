import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validationMessage } from "../core/action-arguments.js";
import { CacheLeases, MAX_CACHE_LEASE_MS } from "../cache/leases.js";
import { observePromptCache } from "../cache/observations.js";
import type { FabricCacheHoldOptions, FabricCacheHoldResult, FabricCacheStatus } from "../cache/types.js";
import type { FabricActionDescriptor, FabricInvocationContext, FabricProvider, FabricProviderListRequest, FabricScopedProviderResult } from "../protocol.js";

const target = { type: "string", enum: ["self", "main"], description: "Local session only. main is accepted only in the root Pi runtime; never routes to another process." };
const statusSchema = { type: "object", properties: { target }, additionalProperties: false };
const holdSchema = {
  type: "object", required: ["durationMs"], additionalProperties: false,
  properties: {
    target,
    durationMs: { type: "integer", minimum: 1_000, maximum: MAX_CACHE_LEASE_MS },
    maxRefreshes: { type: "integer", minimum: 1, maximum: 1_000, description: "Currently unsupported: specifying this bound rejects acquisition, never silently ignores it." },
    maxCostUsd: { type: "number", exclusiveMinimum: 0, maximum: 1_000, description: "Currently unsupported: specifying this bound rejects acquisition, never silently ignores it." },
  },
};
const descriptors: FabricActionDescriptor[] = [
  { name: "status", description: "Observe local prompt-cache usage from a bounded active-branch window and inspect Fabric leases. Past cache reads and held leases never prove cache residency. No warming requests or settings changes.",
    inputSchema: statusSchema, risk: "read", effect: { kind: "none", resources: ["pi:prompt-cache"], ordering: "commutative" } },
  { name: "hold", description: "Opt into a time-bounded local idle-warming lease. May incur paid native requests; Pi retains eligibility and economic policy. Unsupported SDKs or requested cost/count caps return unsupported without fallback. Survives successful fabric_exec until release, expiry, or invalidation; not restart-durable.",
    inputSchema: holdSchema, risk: "agent", effect: { kind: "emission", resources: ["pi:prompt-cache"], ordering: "ordered" } },
  { name: "release", description: "Idempotently release a session-owned cache hold. Does not disable native settings or another owner's interest, or undo already-billed refreshes. Component leases are scope-owned.",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 128 } }, required: ["id"], additionalProperties: false },
    risk: "write", effect: { kind: "emission", resources: ["pi:prompt-cache"], ordering: "ordered" } },
  { name: "lease", description: "Host-component scoped cache hold; use context.acquire, not tools.call. Disposal releases only this interest; paid usage is irreversible. Same native capability and bounds as cache.hold.",
    inputSchema: holdSchema, risk: "agent", effect: { kind: "scoped", resources: ["pi:prompt-cache"], ordering: "ordered" } },
];

function checked(action: string, args: Record<string, unknown>): void {
  const descriptor = descriptors.find(candidate => candidate.name === action);
  if (!descriptor) throw new Error(`Unknown cache action: ${action}`);
  const error = validationMessage(descriptor.inputSchema, args);
  if (error) throw new Error(`Invalid cache.${action} arguments: ${error}`);
}

export class CacheProvider implements FabricProvider {
  readonly name = "cache";
  readonly description = "Observed prompt-cache usage and optional native scoped warming; not a key/value or tool-result cache";
  readonly #leases: CacheLeases;
  readonly #sessionId: string;
  constructor(pi: ExtensionAPI, context: ExtensionContext, private readonly isMain: boolean) {
    this.#sessionId = context.sessionManager.getSessionId();
    this.#leases = new CacheLeases(pi, this.#sessionId);
  }
  async list(request: FabricProviderListRequest): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    return descriptors.filter(action => !query || `${action.name} ${action.description}`.toLowerCase().includes(query));
  }
  async describe(name: string): Promise<FabricActionDescriptor | undefined> { return descriptors.find(action => action.name === name); }
  #checkContext(args: Record<string, unknown>, context: FabricInvocationContext): void {
    if (context.extensionContext.sessionManager.getSessionId() !== this.#sessionId) throw new Error("Cache provider belongs to a different session");
    if (args.target === "main" && !this.isMain) throw new Error("Main cache is not local to this runtime; use self for this child session");
  }
  async invoke(name: string, args: Record<string, unknown>, context: FabricInvocationContext): Promise<unknown> {
    if (!["status", "hold", "release"].includes(name)) throw new Error(name === "lease" ? "cache.lease requires component context.acquire" : `Unknown cache action: ${name}`);
    checked(name, args);
    this.#checkContext(args, context);
    const host = context.extensionContext;
    if (name === "release") return this.#leases.release(args.id as string);
    if (name === "hold") return this.#hold(args, context, "session");
    const supported = this.#leases.supported(host);
    const result: FabricCacheStatus = {
      target: "self", sessionId: this.#sessionId,
      model: host.model ? `${host.model.provider}/${host.model.id}` : null,
      supported, reason: supported ? null : "Native scoped cache warming is unavailable; observations remain available",
      limits: { durationMs: true, maxRefreshes: false, maxCostUsd: false },
      leases: this.#leases.values(), scheduled: null, cleanupError: this.#leases.cleanupError,
      observation: observePromptCache(host),
    };
    return result;
  }
  #hold(args: Record<string, unknown>, context: FabricInvocationContext, scope: "session" | "component"): FabricCacheHoldResult {
    const result = this.#leases.hold(args as unknown as FabricCacheHoldOptions, context.extensionContext,
      scope, context.parentToolCallId, context.signal);
    context.activity?.({ type: "progress", message: result.status === "held"
      ? "Native cache-warming interest held; not proof of refresh or cache residency" : result.reason });
    return result;
  }
  async acquire(name: string, args: Record<string, unknown>, context: FabricInvocationContext): Promise<FabricScopedProviderResult> {
    if (name !== "lease") throw new Error(`Not a scoped cache action: ${name}`);
    checked(name, args);
    this.#checkContext(args, context);
    const result = this.#hold(args, context, "component");
    return { value: result, dispose: () => { if (result.status === "held") this.#leases.dispose(result.id); } };
  }
  async invocationEnded(id: string): Promise<void> { this.#leases.invocationEnded(id); }
  async close(): Promise<void> { this.#leases.close(); }
}
