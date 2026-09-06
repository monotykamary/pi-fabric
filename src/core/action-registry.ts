import { randomUUID } from "node:crypto";
import { repairCatalogInput, validateCatalogArgs, validationMessage } from "./action-arguments.js";
import {
  MAX_AUDIT_VALUE_CHARS,
  boundedPreviewValue,
  boundedResult,
  failedResultError,
  failedResultOutcome,
  previewArgs,
  previewResult,
} from "./action-result.js";
import { runAbortable, settleWithin } from "../async-settlement.js";
import type {
  FabricCapabilityRequirement,
  FabricComponentProviderLease,
} from "../components/types.js";
import {
  executionOutcomeFromError,
  FabricResolutionError,
  FabricTraceSafeError,
  type FabricExecutionTraceOperationHandle,
  type FabricExecutionTraceRecorder,
} from "../audit/trace.js";
import {
  FABRIC_NESTED_TOOL_CALL_ID_PREFIX,
  type FabricActionDescriptor,
  type FabricActionEffect,
  type FabricCapabilityBindingView,
  type FabricCapabilityCatalog,
  type FabricCapabilityResolution,
  type FabricCommittedCapabilityView,
  type FabricGuestTypeSources,
  type FabricInvocationActivityUpdate,
  type FabricInvocationContext,
  type FabricMediaBlock,
  type FabricNamedActionTypeSource,
  type FabricProvider,
  type FabricProviderListRequest,
  type FabricScopedProviderResult,
} from "../protocol.js";
import {
  formatUnknownActionMessage,
  repairActionName,
} from "./action-repair.js";
import {
  applyActiveActionName,
  applyActiveArgRepairs,
  getActiveRepairCompiler,
} from "../repairs/active.js";
import {
  activeQuarantinedRefNames,
  effectiveInputSchema,
  isActiveQuarantine,
} from "../entropy/active.js";
import { formatFabricEffectConflict } from "./effect-conflict.js";
import { stableJsonHash } from "./stable-hash.js";
import type {
  FabricSpeculationReplay,
  FabricSpeculationRuntime,
} from "../speculation/types.js";
import type { FabricNestedToolResultProxy } from "./tool-result-proxy.js";
import {
  FabricProviderBindings,
  type FabricProviderBinding,
  type FabricProviderBindingEvent,
} from "./provider-bindings.js";

export interface ResolvedFabricAction extends FabricActionDescriptor {
  ref: string;
  provider: string;
}

interface FabricEffectConflict {
  withRef: string;
  resources: string[];
  reason: "shared_resource" | "unknown_resource";
}

export interface FabricCallAudit {
  ref: string;
  nestedToolCallId: string;
  startedAt: number;
  endedAt?: number;
  success?: boolean;
  error?: string;
  resultChars?: number;
  resultTruncated?: boolean;
  tool?: string;
  provider?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  media?: FabricMediaBlock[];
  mediaNote?: string;
  preview?: unknown;
  effectConflicts?: FabricEffectConflict[];
  /** Result was pre-launched while the program streamed and served from the speculation store. */
  speculated?: boolean;
  /** Spelled action name that repaired to the canonical one at resolve (e.g. search → recall). */
  repairedFrom?: string;
}

export type FabricRegistryActivityEvent =
  | {
      type: "call_start";
      callId: string;
      ref: string;
      args: Record<string, unknown>;
    }
  | {
      type: "call_update";
      callId: string;
      update: FabricInvocationActivityUpdate;
    }
  | {
      type: "call_args";
      callId: string;
      args: Record<string, unknown>;
    }
  | {
      type: "call_end";
      callId: string;
      success: boolean;
      result?: unknown;
      preview?: unknown;
      error?: string;
    };

export interface FabricCapabilityViewLease extends FabricCapabilityResolution {
  release(): Promise<void>;
}

export interface FabricRegistryInvocationContext extends FabricInvocationContext {
  authorize?(action: ResolvedFabricAction): Promise<void>;
  approve(
    action: ResolvedFabricAction,
    args: Record<string, unknown>,
  ): Promise<void>;
  audits: FabricCallAudit[];
  maxResultChars: number;
  trace?: FabricExecutionTraceRecorder;
  traceOperation?: FabricExecutionTraceOperationHandle;
  observeInvocation?(event: FabricRegistryActivityEvent): void;
}

/**
 * Prefix pi-fabric prepends to every nested tool-call id it generates inside a
 * fabric_exec run (one per pi., mcp., or agents. invocation). Extensions can
 * detect that a tool_call/tool_result event came from a nested fabric call —
 * rather than a top-level call the LLM made directly — by checking
 * `event.toolCallId.startsWith(NESTED_TOOL_CALL_ID_PREFIX)`. The LLM's own
 * tool-call ids (e.g. openai "call_…", anthropic "toolu_…") never use this
 * prefix, so the signal is unambiguous.
 */
export const NESTED_TOOL_CALL_ID_PREFIX = FABRIC_NESTED_TOOL_CALL_ID_PREFIX;

const providerNamePattern = /^[a-z][a-z0-9_-]*$/;

const resolveDescriptor = (
  provider: FabricProvider,
  descriptor: FabricActionDescriptor,
): ResolvedFabricAction => ({
  ...descriptor,
  effect: descriptor.effect ?? (descriptor.risk === "read"
    ? { kind: "none", ordering: "commutative" }
    : { kind: "emission", ordering: "unknown" }),
  provider: provider.name,
  ref: `${provider.name}.${descriptor.name}`,
});

const descriptorHash = stableJsonHash;

const actionDescriptorHash = (action: ResolvedFabricAction): string =>
  descriptorHash({
    ref: action.ref,
    description: action.description,
    inputSchema: action.inputSchema,
    outputSchema: action.outputSchema,
    risk: action.risk,
    namespace: action.namespace,
    effect: action.effect,
  });

const discoveryTerms = (value: string): string[] =>
  [...value.normalize("NFKC").matchAll(/[\p{L}\p{N}_]+/gu)]
    .map((match) => match[0].toLowerCase());

const conflictBetween = (
  left: FabricActionEffect,
  right: FabricActionEffect,
): { resources: string[]; reason: FabricEffectConflict["reason"] } | undefined => {
  if (left.kind === "none" || right.kind === "none") return undefined;
  const resources = (effect: FabricActionEffect): string[] =>
    [...new Set((effect.resources ?? []).filter(
      (resource): resource is string => typeof resource === "string" && resource.length > 0,
    ).map((resource) => resource.slice(0, 256)))].slice(0, 64);
  const leftResources = resources(left);
  const rightResources = resources(right);
  if (leftResources.length === 0 || rightResources.length === 0) {
    if (left.ordering === "commutative" && right.ordering === "commutative") return undefined;
    return { resources: ["*"], reason: "unknown_resource" };
  }
  const rightSet = new Set(rightResources);
  const overlap = leftResources.filter((resource) => rightSet.has(resource)).sort();
  if (overlap.length === 0) return undefined;
  if (left.ordering === "commutative" && right.ordering === "commutative") return undefined;
  return { resources: overlap, reason: "shared_resource" };
};

export class ActionRegistry {
  readonly #providerBindings = new FabricProviderBindings();
  readonly #activeEffects = new Map<string, { ref: string; effect: FabricActionEffect }>();
  readonly #unavailable = new Map<string, string>();
  #speculation: FabricSpeculationRuntime | undefined;
  #speculationEligibility: ((action: ResolvedFabricAction) => boolean) | undefined;

  constructor(readonly toolResultProxy?: FabricNestedToolResultProxy) {
    this.#providerBindings.subscribe(() => this.#speculation?.reset?.());
  }

  /**
   * Attach the speculative-PTC runtime. Eligibility is re-checked against the
   * resolved descriptor inside speculate(), so a config/captured-tool change
   * cannot sneak a side-effecting ref into the store after the fact.
   */
  setSpeculation(
    runtime: FabricSpeculationRuntime | undefined,
    eligibility?: (action: ResolvedFabricAction) => boolean,
  ): void {
    this.#speculation = runtime;
    this.#speculationEligibility = eligibility;
  }

  register(provider: FabricProvider, options: { overwrite?: boolean } = {}): void {
    this.mount(provider, options);
  }

  mount(
    provider: FabricProvider,
    options: { overwrite?: boolean; staged?: boolean } = {},
  ): FabricComponentProviderLease {
    if (!providerNamePattern.test(provider.name)) {
      throw new Error(`Invalid Fabric provider name: ${provider.name}`);
    }
    const lease = this.#providerBindings.mount(provider, options);
    this.#unavailable.delete(provider.name);
    return lease;
  }

  activateProviderBindings(bindingIds: readonly string[]): string[] {
    return this.#providerBindings.activate(bindingIds);
  }

  subscribeProviderChanges(
    listener: (event: FabricProviderBindingEvent) => void,
  ): () => void {
    return this.#providerBindings.subscribe(listener);
  }

  notifyCatalogChanged(provider: string): void {
    this.#providerBindings.notifyCatalogChanged(provider);
  }

  has(name: string): boolean {
    return this.#providerBindings.has(name);
  }

  markUnavailable(name: string, reason: string): void {
    if (!providerNamePattern.test(name)) {
      throw new Error(`Invalid Fabric provider name: ${name}`);
    }
    if (this.#providerBindings.has(name)) {
      throw new Error(`Cannot mark a registered Fabric provider unavailable: ${name}`);
    }
    this.#unavailable.set(name, reason);
  }

  unavailableProviders(): Array<{ name: string; reason: string }> {
    return [...this.#unavailable.entries()]
      .map(([name, reason]) => ({ name, reason }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  unregister(name: string): FabricProvider | undefined {
    return this.#providerBindings.unregister(name);
  }

  providers(): Array<{ name: string; description: string }> {
    return this.#providerBindings.providers()
      .map((provider) => ({ name: provider.name, description: provider.description }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async inspectCapabilities(
    requirements: readonly (string | FabricCapabilityRequirement)[],
    context: FabricInvocationContext,
  ): Promise<FabricCapabilityResolution> {
    return this.#resolveCapabilities(requirements, context, false);
  }

  async acquireCapabilityView(
    requirements: readonly (string | FabricCapabilityRequirement)[],
    context: FabricInvocationContext,
  ): Promise<FabricCapabilityViewLease> {
    return this.#resolveCapabilities(requirements, context, true);
  }

  /**
   * Snapshot the tool schemas backing the dynamic guest surfaces (mcp and
   * extensions) so the type gate can reject argument-shape mistakes before
   * the sandbox runs. Side-effect-free by construction: MCP data comes from
   * the provider's cache-warm descriptor slice (listing would schedule
   * background revalidation), extension data from the captured-tool catalog.
   * Providers that cannot supply data yet simply contribute no section and
   * the loose declarations stand for that execution.
   */
  async guestTypeSources(context: FabricInvocationContext): Promise<FabricGuestTypeSources> {
    const sources: FabricGuestTypeSources = {};
    if (context.capabilityView) {
      const actions = await this.list({ limit: 1_000 }, context);
      const byServer = new Map<string, FabricNamedActionTypeSource[]>();
      for (const action of actions.filter((candidate) => candidate.provider === "mcp")) {
        const server = action.namespace;
        if (!server || server === "management" || action.name.startsWith("$")) continue;
        const prefix = `${server}.`;
        const name = action.name.startsWith(prefix)
          ? action.name.slice(prefix.length)
          : action.name;
        const tools = byServer.get(server) ?? [];
        tools.push({ name, inputSchema: action.inputSchema });
        byServer.set(server, tools);
      }
      if (byServer.size > 0) {
        sources.mcpServers = [...byServer.entries()].map(([server, tools]) => ({
          server,
          tools,
        }));
      }
      const extensionTools = actions
        .filter((action) => action.provider === "extensions")
        .map((action) => ({ name: action.name, inputSchema: action.inputSchema }));
      if (extensionTools.length > 0) sources.extensionTools = extensionTools;
      return sources;
    }
    const mcp = this.#providerBindings.current("mcp")?.provider as
      | (FabricProvider & { sliceDescriptors?: () => FabricActionDescriptor[] })
      | undefined;
    const mcpDescriptors = mcp?.sliceDescriptors?.();
    if (mcpDescriptors && mcpDescriptors.length > 0) {
      const byServer = new Map<string, Map<string, FabricNamedActionTypeSource>>();
      for (const descriptor of mcpDescriptors) {
        const server = descriptor.namespace;
        if (!server || server === "management" || descriptor.name.startsWith("$")) continue;
        const prefix = `${server}.`;
        const toolName = descriptor.name.startsWith(prefix)
          ? descriptor.name.slice(prefix.length)
          : descriptor.name;
        let tools = byServer.get(server);
        if (!tools) {
          tools = new Map();
          byServer.set(server, tools);
        }
        // Teaching: the type gate checks programs against the compiled
        // schema, the same shape invoke validates against, so shape
        // mistakes surface before the sandbox runs.
        tools.set(toolName, {
          name: toolName,
          inputSchema: effectiveInputSchema(
            `mcp.${descriptor.name}`,
            descriptor.inputSchema,
          ) as Record<string, unknown>,
        });
      }
      if (byServer.size > 0) {
        sources.mcpServers = [...byServer.entries()].map(([server, tools]) => ({
          server,
          tools: [...tools.values()],
        }));
      }
    }
    const extensions = this.#providerBindings.current("extensions")?.provider;
    if (extensions) {
      try {
        const descriptors = await extensions.list({}, context);
        if (descriptors.length > 0) {
          sources.extensionTools = descriptors.map((descriptor) => ({
            name: descriptor.name,
            inputSchema: effectiveInputSchema(
              `extensions.${descriptor.name}`,
              descriptor.inputSchema,
            ) as Record<string, unknown>,
          }));
        }
      } catch {
        // Capture catalog not ready yet; the loose extensions surface stands
        // for this execution.
      }
    }
    return sources;
  }

  // The model-facing discovery view: quarantined refs hide here, and the
  // compiled overlay teaches: listed schemas show the compiled shape so
  // tightened enums are visible before the first call. Pass `declared: true`
  // for the compile's base-surface truth, which keeps quarantined refs
  // visible and schemas declared so base-digest proofs and artifact
  // carry-forward read the live contract. Capability-view paths stay
  // declared everywhere (see describe): committed views pin declared
  // digests, and a surface activation must never invalidate them.
  async list(
    request: FabricProviderListRequest & { provider?: string; declared?: boolean },
    context: FabricInvocationContext,
  ): Promise<ResolvedFabricAction[]> {
    if (context.capabilityView) {
      const refs = Object.keys(context.capabilityView.bindings)
        .filter((ref) => !request.provider || ref.startsWith(`${request.provider}.`))
        .filter((ref) => request.declared || !activeQuarantinedRefNames().has(ref))
        .sort();
      const actions = await Promise.all(refs.map((ref) => this.describe(ref, context)));
      const query = request.query?.normalize("NFKC").trim().toLowerCase();
      return actions
        .filter((action) => !request.namespace || action.namespace === request.namespace)
        .filter((action) =>
          !query || `${action.ref} ${action.description}`.toLowerCase().includes(query),
        )
        .slice(0, Math.max(1, Math.min(request.limit ?? 100, 1_000)));
    }
    const providers = request.provider
      ? [this.#requireProvider(request.provider)]
      : this.#providerBindings.providers();
    const lists = await Promise.all(
      providers.map(async (provider) => {
        const descriptors = await provider.list(request, context);
        return descriptors
          .filter(
            (descriptor) =>
              request.declared ||
              !activeQuarantinedRefNames().has(`${provider.name}.${descriptor.name}`),
          )
          .map((descriptor) => {
            const action = resolveDescriptor(provider, descriptor);
            // Teaching: the listing carries the compiled schema. Declared
            // requests (the compile snapshot) keep the live contract.
            return request.declared
              ? action
              : {
                  ...action,
                  inputSchema: effectiveInputSchema(
                    action.ref,
                    action.inputSchema,
                  ) as Record<string, unknown>,
                };
          });
      }),
    );
    const limit = Math.max(1, Math.min(request.limit ?? 100, 1_000));
    return lists.flat().slice(0, limit);
  }

  async catalog(
    context: FabricInvocationContext,
    options: {
      provider?: string;
      limit?: number;
      includeProvider?: (provider: string) => boolean;
    } = {},
  ): Promise<FabricCapabilityCatalog> {
    const providers = (context.capabilityView
      ? [...new Map(
          Object.values(context.capabilityView.bindings).flatMap((pinned) => {
            const binding = this.#providerBindings.binding(pinned.providerBindingId);
            return binding ? [[binding.name, binding.provider] as const] : [];
          }),
        ).values()]
      : options.provider
        ? [this.#requireProvider(options.provider)]
        : this.#providerBindings.providers())
      .filter((provider) => !options.provider || provider.name === options.provider)
      .filter((provider) => options.includeProvider?.(provider.name) ?? true)
      .sort((left, right) => left.name.localeCompare(right.name));
    const lists = await Promise.all(
      providers.map(async (provider) => ({
        provider,
        actions: context.capabilityView
          ? await this.list({ provider: provider.name, limit: 1_000 }, context)
          : (await provider.list({}, context))
              .filter(
                (descriptor) =>
                  !activeQuarantinedRefNames().has(`${provider.name}.${descriptor.name}`),
              )
              .map((descriptor) => resolveDescriptor(provider, descriptor)),
      })),
    );
    const allActions = lists.flatMap(({ actions }) => actions)
      .sort((left, right) => left.ref.localeCompare(right.ref));
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 1_000), 1_000));
    const retainedRefs = new Set(allActions.slice(0, limit).map((action) => action.ref));
    const providerHeads = lists.map(({ provider, actions }) => {
      const actionHeads = actions
        .filter((action) => retainedRefs.has(action.ref))
        .sort((left, right) => left.ref.localeCompare(right.ref))
        .map((action) => ({
          key: `action:${action.ref}`,
          parentKey: `provider:${provider.name}`,
          ref: action.ref,
          name: action.name,
          description: action.description,
          descriptorHash: actionDescriptorHash(action),
          risk: action.risk,
          ...(action.namespace === undefined ? {} : { namespace: action.namespace }),
          ...(action.effect === undefined ? {} : { effect: action.effect }),
        }));
      return {
        key: `provider:${provider.name}`,
        parentKey: "capability:fabric",
        name: provider.name,
        description: provider.description,
        descriptorHash: descriptorHash({
          name: provider.name,
          description: provider.description,
          actions: actionHeads.map((action) => action.descriptorHash),
        }),
        actions: actionHeads,
      };
    });
    const indexedActions = providerHeads.reduce((total, provider) => total + provider.actions.length, 0);
    const rootHash = descriptorHash(providerHeads.map((provider) => provider.descriptorHash));
    return {
      kind: "pi-fabric.capability-catalog",
      version: 1,
      root: {
        key: "capability:fabric",
        name: "Fabric capabilities",
        description: context.capabilityView
          ? "Committed provider and action metadata for this execution; not historical session evidence."
          : "Current registered provider and action metadata for navigation; not historical session evidence.",
        descriptorHash: rootHash,
      },
      providers: providerHeads,
      totalActions: allActions.length,
      indexedActions,
      complete: indexedActions === allActions.length,
      reasons: indexedActions === allActions.length ? [] : ["action_limit"],
    };
  }

  async search(
    query: string,
    context: FabricInvocationContext,
    limit = 30,
  ): Promise<ResolvedFabricAction[]> {
    const normalizedQuery = query.normalize("NFKC").trim().toLowerCase();
    if (!normalizedQuery) return [];
    const queryTerms = [...new Set(discoveryTerms(normalizedQuery))];
    const listed = await this.list({ limit: 1_000 }, context);
    return listed
      .map((action) => {
        const providerDescription =
          this.#providerBindings.current(action.provider)?.provider.description ?? "";
        const ref = action.ref.normalize("NFKC").toLowerCase();
        const name = action.name.normalize("NFKC").toLowerCase();
        const description = action.description.normalize("NFKC").toLowerCase();
        const provider = action.provider.normalize("NFKC").toLowerCase();
        const providerBody = providerDescription.normalize("NFKC").toLowerCase();
        const namespace = (action.namespace ?? "").normalize("NFKC").toLowerCase();
        const schema = JSON.stringify(action.inputSchema).normalize("NFKC").toLowerCase();
        const tokenSets = {
          ref: new Set(discoveryTerms(ref)),
          name: new Set(discoveryTerms(name)),
          description: new Set(discoveryTerms(description)),
          provider: new Set(discoveryTerms(provider)),
          providerBody: new Set(discoveryTerms(providerBody)),
          namespace: new Set(discoveryTerms(namespace)),
          schema: new Set(discoveryTerms(schema)),
        };
        const fields = Object.values(tokenSets);
        let score = 0;
        if (ref === normalizedQuery) score += 1_000;
        if (name === normalizedQuery) score += 800;
        if (ref.startsWith(normalizedQuery)) score += 300;
        else if (ref.includes(normalizedQuery)) score += 120;
        if (description.includes(normalizedQuery)) score += 40;
        if (providerBody.includes(normalizedQuery)) score += 20;
        if (schema.includes(normalizedQuery)) score += 10;
        let matchedTerms = 0;
        for (const term of queryTerms) {
          const matched = fields.some((field) => field.has(term));
          if (!matched) continue;
          matchedTerms += 1;
          if (tokenSets.ref.has(term) || tokenSets.name.has(term)) score += 30;
          if (tokenSets.provider.has(term)) score += 20;
          if (tokenSets.description.has(term)) score += 8;
          if (tokenSets.providerBody.has(term)) score += 4;
          if (tokenSets.namespace.has(term)) score += 6;
          if (tokenSets.schema.has(term)) score += 2;
        }
        if (queryTerms.length > 0 && matchedTerms === queryTerms.length) score += 15;
        return { action, score };
      })
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.action.ref.localeCompare(right.action.ref),
      )
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map((entry) => entry.action);
  }

  async describe(ref: string, context: FabricInvocationContext): Promise<ResolvedFabricAction> {
    if (ref.includes(".")) {
      const { provider, actionName, expectedDescriptorHash } = this.#parseRef(
        ref,
        context.capabilityView,
      );
      const resolved = await this.#resolveActionDescriptor(
        provider,
        actionName,
        context,
        context.capabilityView === undefined,
      );
      if (!resolved.action) {
        throw new FabricResolutionError(formatUnknownActionMessage(ref, resolved.suggestions));
      }
      const action = resolved.action;
      if (expectedDescriptorHash && actionDescriptorHash(action) !== expectedDescriptorHash) {
        throw new FabricResolutionError(`Fabric capability descriptor changed: ${ref}`);
      }
      return action;
    }
    if (context.capabilityView) {
      const pinned = await Promise.all(
        Object.keys(context.capabilityView.bindings).map((candidate) =>
          this.describe(candidate, context),
        ),
      );
      const matches = pinned.filter((action) => action.name === ref);
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) {
        throw new Error(
          `"${ref}" matches ${matches.length} committed Fabric actions; qualify with provider.action: ` +
            matches.map((match) => match.ref).sort().join(", "),
        );
      }
      throw new FabricResolutionError(`Unknown Fabric action in committed view: ${ref}`);
    }
    // Bare action names (what typed calls pragmatically use): walk every
    // provider for a unique action-name match.
    const matches: ResolvedFabricAction[] = [];
    const declaredNames: string[] = [];
    for (const provider of this.#providerBindings.providers()) {
      let descriptors: FabricActionDescriptor[];
      try {
        descriptors = await provider.list({}, context);
      } catch {
        continue;
      }
      for (const descriptor of descriptors) {
        declaredNames.push(descriptor.name);
        if (descriptor.name === ref) matches.push(resolveDescriptor(provider, descriptor));
      }
    }
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(
        `"${ref}" matches ${matches.length} Fabric actions; qualify with provider.action: ` +
          matches.map((match) => match.ref).sort().join(", "),
      );
    }
    const repair = repairActionName(declaredNames, ref);
    throw new FabricResolutionError(formatUnknownActionMessage(ref, repair.suggestions));
  }

  async acquireScoped(
    ref: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<FabricScopedProviderResult> {
    const { binding, provider, actionName, expectedDescriptorHash } = this.#parseRef(
      ref,
      context.capabilityView,
    );
    const endInvocation = this.#providerBindings.beginInvocation(binding.id);
    const releaseBinding = this.#providerBindings.retain([binding.id]);
    let retentionTransferred = false;
    try {
      const resolved = await this.#resolveActionDescriptor(
        provider,
        actionName,
        context,
        context.capabilityView === undefined,
      );
      if (!resolved.action) {
        throw new FabricResolutionError(formatUnknownActionMessage(ref, resolved.suggestions));
      }
      const action = resolved.action;
      const providerActionName = resolved.repairedFrom === undefined ? actionName : action.name;
      if (expectedDescriptorHash && actionDescriptorHash(action) !== expectedDescriptorHash) {
        throw new FabricResolutionError(`Fabric capability descriptor changed: ${ref}`);
      }
      if (action.effect?.kind !== "scoped") {
        throw new Error(`Fabric action is not a scoped acquisition: ${ref}`);
      }
      if (!provider.acquire) {
        throw new Error(`Fabric provider does not implement scoped acquisition: ${provider.name}`);
      }
      const effectiveSchema = effectiveInputSchema(
        action.ref,
        action.inputSchema,
      ) as Record<string, unknown>;
      const catalogInput = repairCatalogInput(action.ref, effectiveSchema, args);
      const preparedArgs = provider.prepareArguments
        ? await runAbortable(context.signal, () =>
            provider.prepareArguments!(providerActionName, catalogInput.args, context),
          )
        : catalogInput.args;
      if (typeof preparedArgs !== "object" || preparedArgs === null || Array.isArray(preparedArgs)) {
        throw new Error(`Argument preparation for ${ref} did not return an object`);
      }
      const catalog = validateCatalogArgs(
        action.ref,
        effectiveSchema,
        preparedArgs,
        catalogInput.observedUnexpected,
      );
      if (catalog.invalid) throw new Error(`Invalid arguments for ${ref}: ${catalog.invalid}`);
      const acquired = await runAbortable(context.signal, () =>
        provider.acquire!(providerActionName, catalog.args, context),
      );
      if (!acquired || typeof acquired.dispose !== "function") {
        throw new Error(`Scoped acquisition ${ref} did not return a disposer`);
      }
      let disposal: Promise<void> | undefined;
      retentionTransferred = true;
      return {
        value: acquired.value,
        dispose: () => {
          disposal ??= (async () => {
            try {
              await acquired.dispose();
            } finally {
              await releaseBinding();
            }
          })();
          return disposal;
        },
      };
    } finally {
      await endInvocation().catch(() => undefined);
      if (!retentionTransferred) await releaseBinding().catch(() => undefined);
    }
  }

  async invoke(
    ref: string,
    args: Record<string, unknown>,
    context: FabricRegistryInvocationContext,
  ): Promise<unknown> {
    const traceOperation = context.traceOperation ?? context.trace?.issueCall(ref, args);
    let failureStage: "resolve" | "guard" | "prepare" | "validate" | "approve" | "invoke" = "resolve";
    let audit: FabricCallAudit | undefined;
    let invocationActive = false;
    let endBindingInvocation: (() => Promise<void>) | undefined;
    try {
      const { binding, provider, actionName, expectedDescriptorHash } = this.#parseRef(
        ref,
        context.capabilityView,
      );
      endBindingInvocation = this.#providerBindings.beginInvocation(binding.id);
      const resolved = await this.#resolveActionDescriptor(
        provider,
        actionName,
        context,
        context.capabilityView === undefined,
      );
      if (!resolved.action) {
        throw new FabricResolutionError(formatUnknownActionMessage(ref, resolved.suggestions));
      }
      const action = resolved.action;
      const providerActionName = resolved.repairedFrom === undefined ? actionName : action.name;
      if (expectedDescriptorHash && actionDescriptorHash(action) !== expectedDescriptorHash) {
        throw new FabricResolutionError(`Fabric capability descriptor changed: ${ref}`);
      }
      traceOperation?.resolved(action.provider, action.name);

      failureStage = "guard";
      if (action.effect?.kind === "scoped") {
        throw new FabricTraceSafeError(
          `Fabric scoped action ${ref} requires a supervised acquisition context`,
        );
      }
      if (context.authorize) {
        await runAbortable(context.signal, () => context.authorize!(action));
      }

      failureStage = "prepare";
      const effectiveSchema = effectiveInputSchema(
        action.ref,
        action.inputSchema,
      ) as Record<string, unknown>;
      const catalogInput = repairCatalogInput(action.ref, effectiveSchema, args);
      const preparedArgs = provider.prepareArguments
        ? await runAbortable(context.signal, () =>
            provider.prepareArguments!(providerActionName, catalogInput.args, context),
          )
        : catalogInput.args;
      if (typeof preparedArgs !== "object" || preparedArgs === null || Array.isArray(preparedArgs)) {
        throw new FabricTraceSafeError(`Argument preparation for ${ref} did not return an object`);
      }

      failureStage = "validate";
      const catalog = validateCatalogArgs(
        action.ref,
        effectiveSchema,
        preparedArgs,
        catalogInput.observedUnexpected,
      );
      traceOperation?.prepared(catalog.args);
      // TypeBox validator messages describe schema expectations only — they
      // never echo argument values — so they are safe for durable traces.
      if (catalog.invalid) {
        // A validate-rejected attempt is in-domain evidence against the
        // effective surface, but rejected argument values are untrusted
        // input and never enter the durable record. The trace-safe feed
        // persists only values the live schema's own enums declare: for a
        // closed-domain parameter the refused value is already the author's
        // public vocabulary, so the observation pool can carry it and a
        // later reset (base drift or review) re-derives with it included.
        // Values outside the declared enums (typos, payloads) drop here,
        // the same pre-birth rule the derivation applies.
        const declaredSchema = action.inputSchema;
        const declaredProperties =
          typeof declaredSchema === "object" &&
          declaredSchema !== null &&
          !Array.isArray(declaredSchema) &&
          typeof (declaredSchema as Record<string, unknown>).properties === "object" &&
          (declaredSchema as Record<string, unknown>).properties !== null
            ? ((declaredSchema as Record<string, unknown>).properties as Record<string, unknown>)
            : undefined;
        const attemptArgs: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(catalog.args)) {
          const property = declaredProperties ? declaredProperties[key] : undefined;
          const declaredEnum =
            typeof property === "object" && property !== null
              ? (property as Record<string, unknown>).enum
              : undefined;
          if (!Array.isArray(declaredEnum)) continue;
          if (
            typeof value !== "string" &&
            typeof value !== "number" &&
            typeof value !== "boolean"
          ) {
            continue;
          }
          if (String(value).length > MAX_AUDIT_VALUE_CHARS) continue;
          if (!declaredEnum.includes(value)) continue;
          attemptArgs[key] = value;
        }
        if (Object.keys(attemptArgs).length > 0) {
          const attempt: FabricCallAudit = {
            ref,
            nestedToolCallId: `${NESTED_TOOL_CALL_ID_PREFIX}${randomUUID()}`,
            startedAt: Date.now(),
            tool: action.name,
            provider: action.provider,
            args: attemptArgs,
            success: false,
            error: `Invalid arguments for ${ref}: ${catalog.invalid}`,
            endedAt: Date.now(),
            ...(resolved.repairedFrom !== undefined
              ? { repairedFrom: resolved.repairedFrom }
              : {}),
          };
          context.audits.push(attempt);
        }
        throw new FabricTraceSafeError(`Invalid arguments for ${ref}: ${catalog.invalid}`);
      }

      failureStage = "approve";
      await runAbortable(context.signal, () => context.approve(action, catalog.args));

      failureStage = "invoke";
      const nestedToolCallId = `${NESTED_TOOL_CALL_ID_PREFIX}${randomUUID()}`;
      const effect = action.effect!;
      const effectConflicts = [...this.#activeEffects.values()].flatMap((active) => {
        const conflict = conflictBetween(effect, active.effect);
        return conflict ? [{ withRef: active.ref, ...conflict }] : [];
      }).slice(0, 32);
      if (effectConflicts.length > 0 && context.effectPolicy === "strict") {
        failureStage = "guard";
        throw new FabricTraceSafeError(
          `Fabric effect conflict for ${ref}: ${effectConflicts
            .map((conflict) => formatFabricEffectConflict(
              conflict.withRef,
              conflict.resources,
              conflict.reason,
            ))
            .join("; ")}`,
        );
      }
      const argsPreview = previewArgs(ref, catalog.args);
      const activeAudit: FabricCallAudit = {
        ref,
        nestedToolCallId,
        startedAt: Date.now(),
        tool: action.name,
        provider: action.provider,
        args: boundedPreviewValue(
          argsPreview,
          MAX_AUDIT_VALUE_CHARS,
        ) as Record<string, unknown>,
        ...(effectConflicts.length > 0 ? { effectConflicts } : {}),
        ...(resolved.repairedFrom !== undefined
          ? { repairedFrom: resolved.repairedFrom }
          : {}),
      };
      audit = activeAudit;
      invocationActive = true;
      context.audits.push(activeAudit);
      context.observeInvocation?.({
        type: "call_start",
        callId: nestedToolCallId,
        ref,
        args: argsPreview,
      });
      context.update(`Calling ${ref}`);
      this.#activeEffects.set(nestedToolCallId, { ref, effect });
      let servedFromSpeculation = false;
      let providerValue: unknown;
      if (this.#speculation && effect.kind === "none") {
        const served = await runAbortable(context.signal, () =>
          this.#speculation!.tryServe(context.parentToolCallId, ref, catalog.args, binding.id));
        if (served.hit) {
          servedFromSpeculation = true;
          activeAudit.speculated = true;
          providerValue = served.value;
          if (served.replay.updatedArgs !== undefined) {
            const replayedPreview = previewArgs(ref, served.replay.updatedArgs);
            activeAudit.args = boundedPreviewValue(
              replayedPreview,
              MAX_AUDIT_VALUE_CHARS,
            ) as Record<string, unknown>;
            traceOperation?.prepared(served.replay.updatedArgs);
            context.observeInvocation?.({
              type: "call_args",
              callId: nestedToolCallId,
              args: replayedPreview,
            });
          }
          if (served.replay.media?.length) {
            activeAudit.media = [...(activeAudit.media ?? []), ...served.replay.media];
            if (served.replay.mediaNote) activeAudit.mediaNote = served.replay.mediaNote;
          }
          if (served.replay.preview !== undefined) activeAudit.preview = served.replay.preview;
        }
      }
      let providerInvoked = false;
      try {
        if (!servedFromSpeculation) {
        providerInvoked = true;
        providerValue = await runAbortable(context.signal, () =>
          provider.invoke(providerActionName, catalog.args, {
          ...context,
          nestedToolCallId,
          update(message) {
            if (!invocationActive) return;
            context.update(message);
            context.observeInvocation?.({
              type: "call_update",
              callId: nestedToolCallId,
              update: { type: "progress", message },
            });
          },
          activity(update) {
            if (!invocationActive) return;
            context.activity?.(update);
            context.observeInvocation?.({
              type: "call_update",
              callId: nestedToolCallId,
              update,
            });
          },
          attachMedia(blocks, note) {
            if (!invocationActive) return;
            if (!activeAudit.media) activeAudit.media = [];
            for (const block of blocks) activeAudit.media.push(block);
            if (note) activeAudit.mediaNote = note;
          },
          updateArguments(updatedArgs) {
            if (!invocationActive) return;
            const updatedPreview = previewArgs(ref, updatedArgs);
            activeAudit.args = boundedPreviewValue(
              updatedPreview,
              MAX_AUDIT_VALUE_CHARS,
            ) as Record<string, unknown>;
            traceOperation?.prepared(updatedArgs);
            context.observeInvocation?.({
              type: "call_args",
              callId: nestedToolCallId,
              args: updatedPreview,
            });
          },
          attachPreview(preview) {
            if (!invocationActive) return;
            activeAudit.preview = preview;
          },
          }),
        );
        }
      } finally {
        if (providerInvoked && effect.kind !== "none") this.#speculation?.bumpEpoch();
        this.#activeEffects.delete(nestedToolCallId);
      }
      const value = this.toolResultProxy
        ? await runAbortable(context.signal, () => this.toolResultProxy!.proxy({
            action,
            args: catalog.args,
            toolCallId: nestedToolCallId,
            value: providerValue,
            ...(context.signal ? { signal: context.signal } : {}),
          }))
        : providerValue;
      const bounded = boundedResult(value, context.maxResultChars);
      const resultError = failedResultError(value);
      activeAudit.success = resultError === undefined;
      if (resultError) activeAudit.error = resultError;
      activeAudit.resultChars = bounded.chars;
      activeAudit.resultTruncated = bounded.truncated;
      const resultPreview = previewResult(bounded.value);
      activeAudit.result = boundedPreviewValue(resultPreview, MAX_AUDIT_VALUE_CHARS);
      activeAudit.endedAt = Date.now();
      context.observeInvocation?.({
        type: "call_end",
        callId: nestedToolCallId,
        success: resultError === undefined,
        result: resultPreview,
        ...(activeAudit.preview !== undefined ? { preview: activeAudit.preview } : {}),
        ...(resultError ? { error: resultError } : {}),
      });
      if (resultError) {
        traceOperation?.fail("invoke", resultError, failedResultOutcome(value), bounded.value, {
          resultTruncated: bounded.truncated,
        });
      } else {
        traceOperation?.succeed(bounded.value, { resultTruncated: bounded.truncated });
      }
      return bounded.value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      traceOperation?.fail(failureStage, error, executionOutcomeFromError(error, context.signal));
      if (audit) {
        audit.success = false;
        audit.error = message;
        audit.endedAt = Date.now();
        context.observeInvocation?.({
          type: "call_end",
          callId: audit.nestedToolCallId,
          success: false,
          error: audit.error,
        });
      }
      throw error;
    } finally {
      invocationActive = false;
      if (audit) audit.endedAt ??= Date.now();
      await endBindingInvocation?.().catch(() => undefined);
    }
  }

  /**
   * Prepare + pre-launch a speculative call discovered in a partially
   * streamed program (see src/speculation). Pure pipeline only: descriptor
   * resolution, the eligibility gate on the resolved action, argument
   * preparation, and schema validation. The compiled entropy surface gates
   * launches too: quarantined refs never pre-launch and overlays validate
   * prepared arguments, so the store never warms a call the serve path
   * would reject. authorize/approve/audits are skipped
   * because the eligibility gate restricts this path to actions that never
   * prompt, and the real call re-runs the full pipeline on a serve miss.
   * Side-channel outputs are captured into `replay` so the serve path can
   * project them into the real audit.
   */
  async speculate(
    ref: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
    replay: FabricSpeculationReplay,
  ): Promise<
    | {
        preparedArgs: Record<string, unknown>;
        bindingToken: string;
        execute(signal: AbortSignal | undefined): Promise<unknown>;
      }
    | undefined
  > {
    if (!this.#speculationEligibility) return undefined;
    try {
      const { binding, provider, actionName, expectedDescriptorHash } = this.#parseRef(
        ref,
        context.capabilityView,
      );
      const descriptor = await runAbortable(context.signal, () =>
        provider.describe(actionName, context));
      if (!descriptor) return undefined;
      const action = resolveDescriptor(provider, descriptor);
      if (expectedDescriptorHash && actionDescriptorHash(action) !== expectedDescriptorHash) {
        return undefined;
      }
      if (isActiveQuarantine(provider.name, actionName, descriptor.inputSchema)) {
        return undefined;
      }
      if (!this.#speculationEligibility(action)) return undefined;
      const effectiveSchema = effectiveInputSchema(
        action.ref,
        action.inputSchema,
      ) as Record<string, unknown>;
      const catalogInput = applyActiveArgRepairs(action.ref, args, effectiveSchema);
      const preparedArgs = provider.prepareArguments
        ? await runAbortable(context.signal, () =>
            provider.prepareArguments!(actionName, catalogInput, context))
        : catalogInput;
      if (
        typeof preparedArgs !== "object" ||
        preparedArgs === null ||
        Array.isArray(preparedArgs)
      ) {
        return undefined;
      }
      const repairedArgs = applyActiveArgRepairs(
        action.ref,
        preparedArgs,
        effectiveSchema,
      );
      if (validationMessage(effectiveSchema, repairedArgs)) return undefined;
      const nestedToolCallId = `${NESTED_TOOL_CALL_ID_PREFIX}spec-${randomUUID()}`;
      return {
        preparedArgs: repairedArgs,
        bindingToken: binding.id,
        execute: async (signal) => {
          const endBindingInvocation = this.#providerBindings.beginInvocation(binding.id);
          try {
            return await runAbortable(signal, () =>
              provider.invoke(actionName, repairedArgs, {
                ...context,
                signal,
                nestedToolCallId,
                update() {},
                activity() {},
                attachMedia(blocks, note) {
                  replay.media = [...(replay.media ?? []), ...blocks];
                  if (note) replay.mediaNote = note;
                },
                updateArguments(updatedArgs) {
                  replay.updatedArgs = updatedArgs;
                },
                attachPreview(preview) {
                  replay.preview = preview;
                },
              }),
            );
          } finally {
            await endBindingInvocation().catch(() => undefined);
          }
        },
      };
    } catch {
      // Speculation degrades silently; the real call runs the full pipeline.
      return undefined;
    }
  }

  async endInvocation(parentToolCallId: string, timeoutMs = 1_000): Promise<void> {
    this.#speculation?.onInvocationEnd?.(parentToolCallId);
    const providers = new Set(
      this.#providerBindings.entries().map((binding) => binding.provider),
    );
    const finalizers = [...providers].flatMap((provider) =>
      provider.invocationEnded
        ? [Promise.resolve().then(() => provider.invocationEnded!(parentToolCallId))]
        : [],
    );
    await settleWithin(finalizers, timeoutMs);
  }

  async close(excludedProviderNames: Set<string> = new Set()): Promise<void> {
    await this.#providerBindings.close(excludedProviderNames);
  }

  async #resolveCapabilities(
    requirements: readonly (string | FabricCapabilityRequirement)[],
    context: FabricInvocationContext,
    retain: boolean,
  ): Promise<FabricCapabilityViewLease> {
    const normalized = new Map<string, boolean>();
    for (const requirement of requirements) {
      const ref = (typeof requirement === "string" ? requirement : requirement.ref).trim();
      if (!ref || ref.length > 256 || !ref.includes(".")) {
        throw new Error(`Fabric capability requirements must use provider.action: ${ref || "<empty>"}`);
      }
      const optional = typeof requirement === "string" ? false : requirement.optional === true;
      normalized.set(ref, (normalized.get(ref) ?? true) && optional);
    }

    const missing: string[] = [];
    const optionalMissing: string[] = [];
    const resolved = new Map<string, FabricCapabilityBindingView>();
    const temporaryReleases: Array<() => Promise<void>> = [];
    let permanentRelease: (() => Promise<void>) | undefined;
    try {
      for (const [ref, optional] of [...normalized].sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        try {
          const { binding, provider, actionName } = this.#parseRef(ref);
          const release = this.#providerBindings.retain([binding.id]);
          temporaryReleases.push(release);
          const descriptor = await runAbortable(context.signal, () =>
            provider.describe(actionName, context),
          );
          if (!descriptor) throw new FabricResolutionError(`Unknown Fabric action: ${ref}`);
          const action = resolveDescriptor(provider, descriptor);
          resolved.set(ref, {
            ref,
            provider: provider.name,
            providerBindingId: binding.id,
            generation: binding.generation,
            descriptorHash: actionDescriptorHash(action),
          });
        } catch (error) {
          if (!(error instanceof FabricResolutionError)) throw error;
          (optional ? optionalMissing : missing).push(ref);
        }
      }

      let view: FabricCommittedCapabilityView | undefined;
      if (missing.length === 0) {
        const bindings = Object.fromEntries(resolved);
        const values = [...resolved.values()];
        if (retain) permanentRelease = this.#providerBindings.retain(
          values.map((binding) => binding.providerBindingId),
        );
        view = {
          id: randomUUID(),
          digest: descriptorHash(values),
          semanticDigest: descriptorHash(
            values.map(({ ref, provider, descriptorHash: hash }) => ({
              ref,
              provider,
              descriptorHash: hash,
            })),
          ),
          bindings,
        };
      }
      return {
        satisfied: missing.length === 0,
        missing,
        optionalMissing,
        ...(view ? { view } : {}),
        release: async () => {
          const release = permanentRelease;
          permanentRelease = undefined;
          await release?.();
        },
      };
    } finally {
      await Promise.allSettled(temporaryReleases.map((release) => release()));
    }
  }

  async #declaredActionNames(
    provider: FabricProvider,
    context: FabricInvocationContext,
  ): Promise<string[]> {
    try {
      const descriptors = await runAbortable(context.signal, () => provider.list({}, context));
      return descriptors.map((descriptor) => descriptor.name);
    } catch {
      return [];
    }
  }

  // Resolve a provider action descriptor, repairing a near-miss action name
  // (mirroring arg-normalization's prepare-stage argument repair) when the
  // caller is not pinned to a committed capability view. Committed views are
  // exact contracts: a pinned miss keeps the plain resolution error.
  async #resolveActionDescriptor(
    provider: FabricProvider,
    actionName: string,
    context: FabricInvocationContext,
    allowRepair: boolean,
  ): Promise<{ action?: ResolvedFabricAction; suggestions: string[]; repairedFrom?: string }> {
    const descriptor = await runAbortable(context.signal, () =>
      provider.describe(actionName, context),
    );
    // A quarantined ref resolves as unknown: the model-facing catalog never
    // shows it, and a direct call gets the standard not-found message with
    // suggestions, exactly like any retired action.
    if (descriptor && !isActiveQuarantine(provider.name, actionName, descriptor.inputSchema)) {
      return {
        action: resolveDescriptor(provider, descriptor),
        suggestions: [],
      };
    }
    if (!allowRepair) return { suggestions: [] };
    const declared = (await this.#declaredActionNames(provider, context)).filter(
      (name) => !activeQuarantinedRefNames().has(`${provider.name}.${name}`),
    );
    const catalogName = applyActiveActionName(provider.name, actionName, declared);
    if (catalogName !== actionName) {
      const catalogDescriptor = await runAbortable(context.signal, () =>
        provider.describe(catalogName, context),
      );
      if (catalogDescriptor) {
        return {
          action: resolveDescriptor(provider, catalogDescriptor),
          suggestions: [],
          repairedFrom: actionName,
        };
      }
    }
    const repair = repairActionName(declared, actionName);
    const compiler = getActiveRepairCompiler();
    if (repair.repaired !== undefined) {
      compiler?.observeUnknownAction(provider.name, actionName, declared, {
        countError: false,
      });
      const repairedDescriptor = await runAbortable(context.signal, () =>
        provider.describe(repair.repaired!, context),
      );
      if (repairedDescriptor) {
        return {
          action: resolveDescriptor(provider, repairedDescriptor),
          suggestions: [],
          repairedFrom: actionName,
        };
      }
      compiler?.recordInvocationError();
    } else {
      compiler?.observeUnknownAction(provider.name, actionName, declared);
    }
    return {
      suggestions: repair.suggestions.map((name) => `${provider.name}.${name}`),
    };
  }

  #parseRef(
    ref: string,
    view?: FabricCommittedCapabilityView,
  ): {
    binding: FabricProviderBinding;
    provider: FabricProvider;
    actionName: string;
    expectedDescriptorHash?: string;
  } {
    const separator = ref.indexOf(".");
    if (separator <= 0 || separator === ref.length - 1) {
      throw new Error(`Fabric action references must use provider.action: ${ref}`);
    }
    const providerName = ref.slice(0, separator);
    const pinned = view?.bindings[ref];
    if (view && !pinned) {
      throw new FabricResolutionError(`Fabric capability is outside the committed view: ${ref}`);
    }
    const binding = pinned
      ? this.#providerBindings.binding(pinned.providerBindingId)
      : this.#providerBindings.current(providerName);
    if (!binding || binding.name !== providerName) {
      if (pinned) {
        throw new FabricResolutionError(
          `Fabric capability binding is no longer available: ${ref} (${pinned.providerBindingId})`,
        );
      }
      this.#requireProvider(providerName);
      throw new FabricResolutionError(`Unknown Fabric provider: ${providerName}`);
    }
    return {
      binding,
      provider: binding.provider,
      actionName: ref.slice(separator + 1),
      ...(pinned ? { expectedDescriptorHash: pinned.descriptorHash } : {}),
    };
  }

  #requireProvider(name: string): FabricProvider {
    const provider = this.#providerBindings.current(name)?.provider;
    if (provider) return provider;
    const unavailableReason = this.#unavailable.get(name);
    if (unavailableReason) {
      throw new FabricResolutionError(
        `Fabric provider "${name}" is unavailable: ${unavailableReason}`,
      );
    }
    const registered = this.#providerBindings.providers()
      .map((provider) => provider.name)
      .sort((left, right) => left.localeCompare(right));
    throw new FabricResolutionError(
      `Unknown Fabric provider: ${name}` +
        (registered.length > 0 ? ` (registered providers: ${registered.join(", ")})` : ""),
    );
  }
}
