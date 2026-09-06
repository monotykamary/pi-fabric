import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const FABRIC_PROVIDER_REGISTER_EVENT = "pi-fabric:provider:register:v1";
export const FABRIC_PROVIDER_DISCOVER_EVENT = "pi-fabric:provider:discover:v1";
export const FABRIC_COMPONENT_REGISTER_EVENT = "pi-fabric:component:register:v1";
export const FABRIC_COMPONENT_DISCOVER_EVENT = "pi-fabric:component:discover:v1";
export const FABRIC_PREWALK_REQUEST_EVENT = "pi-fabric:prewalk:request:v1";

export type FabricPrewalkRequestResultV1 =
  | { ok: true }
  | { ok: false; error: string };

/** Host-local request used by queue extensions that need an acknowledged prewalk arm. */
export interface FabricPrewalkRequestV1 {
  version: 1;
  context: ExtensionContext;
  claim: () => boolean;
  respond: (result: FabricPrewalkRequestResultV1) => void;
}

export const readFabricPrewalkRequestV1 = (
  value: unknown,
): FabricPrewalkRequestV1 | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.context !== "object" ||
    record.context === null ||
    typeof record.claim !== "function" ||
    typeof record.respond !== "function"
  ) {
    return undefined;
  }
  return value as FabricPrewalkRequestV1;
};

export const FABRIC_PEER_CARDS_EVENT = "pi-fabric:peers:cards:v1";
export const FABRIC_PEER_AWAIT_SETTLE_EVENT = "pi-fabric:peer:await-settle:v1";

/** One root peer session on the project mesh, for pickers and status lines. */
export interface FabricPeerCardV1 {
  id: string;
  /** Linear-style project label (e.g. "PQS-2") minted by the owning host. */
  label: string;
  status: "idle" | "running";
  model?: string;
  cwd?: string;
  startedAt: number;
  updatedAt: number;
  pendingMessages: boolean;
}

export type FabricPeerCardsResultV1 =
  | { ok: true; cards: FabricPeerCardV1[] }
  | { ok: false; error: string };

/** Host-local request used by queue extensions to enumerate live peer sessions. */
export interface FabricPeerCardsRequestV1 {
  version: 1;
  context: ExtensionContext;
  claim: () => boolean;
  respond: (result: FabricPeerCardsResultV1) => void;
}

export const readFabricPeerCardsRequestV1 = (
  value: unknown,
): FabricPeerCardsRequestV1 | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.context !== "object" ||
    record.context === null ||
    typeof record.claim !== "function" ||
    typeof record.respond !== "function"
  ) {
    return undefined;
  }
  return value as FabricPeerCardsRequestV1;
};

export interface FabricPeerSettleProgressV1 {
  waiting: Array<{ label: string; status: "idle" | "running" }>;
}

export type FabricPeerAwaitSettleResultV1 =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Host-local request used by queue extensions to hold dispatch until peer
 * sessions settle. A peer counts as settled once it has been quiet
 * (status-wide) for settledForMs; peers that vanish from the mesh count as
 * settled since they can no longer conflict. Selector matches a peer label
 * (case-insensitive) or exact participant id; omitted waits on all peers.
 */
export interface FabricPeerAwaitSettleRequestV1 {
  version: 1;
  context: ExtensionContext;
  selector?: string;
  settledForMs?: number;
  signal?: AbortSignal;
  update?: (progress: FabricPeerSettleProgressV1) => void;
  claim: () => boolean;
  respond: (result: FabricPeerAwaitSettleResultV1) => void;
}

export const readFabricPeerAwaitSettleRequestV1 = (
  value: unknown,
): FabricPeerAwaitSettleRequestV1 | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const signal = record.signal as AbortSignal | undefined;
  if (
    record.version !== 1 ||
    typeof record.context !== "object" ||
    record.context === null ||
    typeof record.claim !== "function" ||
    typeof record.respond !== "function" ||
    (record.selector !== undefined && typeof record.selector !== "string") ||
    (record.settledForMs !== undefined && typeof record.settledForMs !== "number") ||
    (signal !== undefined && typeof signal.aborted !== "boolean") ||
    (record.update !== undefined && typeof record.update !== "function")
  ) {
    return undefined;
  }
  return value as FabricPeerAwaitSettleRequestV1;
};

/** Identifies host-side tool lifecycle events replayed for a nested Fabric call. */
export const FABRIC_NESTED_TOOL_CALL_ID_PREFIX = "fabric_";

/** Discriminant for the transient details envelope on a proxied provider result. */
export const FABRIC_TOOL_RESULT_PROXY_KIND = "pi-fabric.tool-result-proxy.v1";

/**
 * Host-only middleware details for non-Pi Fabric providers. `result` is the
 * exact value before maxNestedResultChars is enforced and is not persisted as
 * a separate Pi tool-result message.
 */
export interface FabricToolResultProxyDetailsV1 {
  kind: typeof FABRIC_TOOL_RESULT_PROXY_KIND;
  ref: string;
  result: unknown;
}

export const readFabricToolResultProxyDetailsV1 = (
  value: unknown,
): FabricToolResultProxyDetailsV1 | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.kind !== FABRIC_TOOL_RESULT_PROXY_KIND ||
    typeof record.ref !== "string" ||
    !Object.prototype.hasOwnProperty.call(record, "result")
  ) {
    return undefined;
  }
  return record as unknown as FabricToolResultProxyDetailsV1;
};

export type FabricRisk = "read" | "write" | "execute" | "network" | "agent";
export type FabricEffectKind = "none" | "scoped" | "transactional" | "emission";
export type FabricEffectOrdering = "commutative" | "ordered" | "unknown";

export interface FabricActionEffect {
  kind: FabricEffectKind;
  resources?: string[];
  ordering?: FabricEffectOrdering;
}

/** MCP tool annotations (Model Context Protocol ToolAnnotations), cached when a runtime surfaces them. */
export interface FabricToolAnnotations {
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}
export type FabricActivityEntityKind =
  | "agent"
  | "actor"
  | "tool"
  | "extension"
  | "mcp"
  | "mesh"
  | "task"
  | "custom";

export type FabricInvocationActivityUpdate =
  | { type: "progress"; message: string }
  | { type: "entity"; id: string; kind: FabricActivityEntityKind; name?: string }
  | { type: "metrics"; tokens?: number; toolCalls?: number; cost?: number };

export interface FabricMediaBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export interface FabricActionDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  risk: FabricRisk;
  namespace?: string;
  effect?: FabricActionEffect;
  annotations?: FabricToolAnnotations;
}

export interface FabricCapabilityActionHead {
  key: string;
  parentKey: string;
  ref: string;
  name: string;
  description: string;
  descriptorHash: string;
  risk: FabricRisk;
  namespace?: string;
  effect?: FabricActionEffect;
}

export interface FabricCapabilityProviderHead {
  key: string;
  parentKey: string;
  name: string;
  description: string;
  descriptorHash: string;
  actions: FabricCapabilityActionHead[];
}

export interface FabricCapabilityBindingView {
  ref: string;
  provider: string;
  providerBindingId: string;
  generation: number;
  descriptorHash: string;
}

export interface FabricCommittedCapabilityView {
  id: string;
  /** Runtime-local digest including provider binding generations. */
  digest: string;
  /** Portable digest of exact refs and descriptor semantics across runtimes. */
  semanticDigest: string;
  bindings: Record<string, FabricCapabilityBindingView>;
}

export interface FabricCapabilityResolution {
  satisfied: boolean;
  missing: string[];
  optionalMissing: string[];
  view?: FabricCommittedCapabilityView;
}

export interface FabricCapabilityCatalog {
  kind: "pi-fabric.capability-catalog";
  version: 1;
  root: {
    key: "capability:fabric";
    name: "Fabric capabilities";
    description: string;
    descriptorHash: string;
  };
  providers: FabricCapabilityProviderHead[];
  totalActions: number;
  indexedActions: number;
  complete: boolean;
  reasons: string[];
}

export interface FabricProviderListRequest {
  namespace?: string;
  query?: string;
  limit?: number;
}

/** One named action whose arguments should be typed in guest declarations. */
export interface FabricNamedActionTypeSource {
  name: string;
  inputSchema: Record<string, unknown>;
}

/** One MCP server plus the tools to type for `mcp.<server>.*` guest calls. */
export interface FabricMcpServerTypeSource {
  server: string;
  tools: FabricNamedActionTypeSource[];
}

export type {
  FabricKernel,
  FabricKernelRuntime,
  FabricHostCall,
  FabricSandboxOptions,
  FabricSandboxResult,
  FabricSandboxTerminationReason,
} from "./runtime/kernel.js";
export type { FabricPythonRuntime } from "./config.js";

/**
 * Live descriptor snapshot the registry hands to the guest declaration
 * builder so dynamic surfaces (mcp, extensions) get argument checking before
 * the sandbox runs. Empty/absent sections keep the loose static declarations.
 */
export interface FabricGuestTypeSources {
  mcpServers?: FabricMcpServerTypeSource[];
  extensionTools?: FabricNamedActionTypeSource[];
}

/**
 * Pre-rendered `declare const` blocks replacing the loose mcp/extensions
 * declaration lines. Values are full replacement text (helpers + declare).
 */
export interface FabricDynamicGuestDeclarations {
  mcp?: string;
  extensions?: string;
}

export interface FabricInvocationContext {
  cwd: string;
  signal: AbortSignal | undefined;
  parentToolCallId: string;
  nestedToolCallId: string;
  extensionContext: ExtensionContext;
  update(message: string): void;
  activity?(update: FabricInvocationActivityUpdate): void;
  /** Host-supplied inside fabric_exec so agents.handoff schedules the outer-call boundary. */
  deferHandoff?(args: Record<string, unknown>): Record<string, unknown>;
  // Out-of-band image content blocks a provider (currently only pi.read of an
  // image file) wants attached to the call audit, so the single-call render can
  // re-attach them to the fabric_exec result content for pi core's kitty image
  // preview. Bypasses the result char bound that would truncate the base64.
  // `note` is the read tool's own text output (e.g. "Read image file [image/png]"),
  // captured after any tool_result patch so a handoff that strips pi's
  // non-vision note has run; used as the single-call body + content text so the
  // preview shows the clean note instead of the swapped description.
  attachMedia?(blocks: FabricMediaBlock[], note?: string): void;
  // Providers call this after mutable tool_call middleware has run so live and
  // durable audit surfaces reflect the arguments actually passed to the tool.
  updateArguments?(args: Record<string, unknown>): void;
  // Ephemeral renderer-only metadata. It is exposed to live Fabric previews but
  // never projected into the durable execution trace.
  attachPreview?(preview: unknown): void;
  capabilityView?: FabricCommittedCapabilityView;
  /** Advisory for ordinary calls; strict components reject concurrent conflicting effects. */
  effectPolicy?: "advisory" | "strict";
}

export interface FabricScopedProviderResult {
  value: unknown;
  dispose(): void | Promise<void>;
}

export interface FabricProvider {
  name: string;
  description: string;
  list(
    request: FabricProviderListRequest,
    context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]>;
  describe(
    actionName: string,
    context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined>;
  prepareArguments?(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown>;
  acquire?(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<FabricScopedProviderResult>;
  invocationEnded?(parentToolCallId: string): Promise<void>;
  subscribeCatalog?(listener: () => void): () => void;
  close?(): Promise<void>;
}

export interface FabricProviderRegistration {
  version: 1;
  provider: FabricProvider;
  overwrite?: boolean;
}

export interface FabricProviderDiscovery {
  version: 1;
  register(provider: FabricProvider, options?: { overwrite?: boolean }): void;
}

export type {
  FabricCapabilityRequirement,
  FabricComponentChildOptions,
  FabricComponentContext,
  FabricComponentDefinition,
  FabricComponentDiscovery,
  FabricComponentDisposer,
  FabricComponentEffect,
  FabricComponentEffectConflict,
  FabricComponentEffectInfo,
  FabricComponentEffectOptions,
  FabricComponentEffectRegistration,
  FabricComponentEntry,
  FabricComponentGraph,
  FabricComponentGuarantee,
  FabricComponentHandle,
  FabricComponentInfo,
  FabricComponentProviderLease,
  FabricModelGuidance,
  FabricModelGuidanceInfo,
  FabricModelGuidancePlacement,
  FabricModelGuidanceTarget,
  FabricComponentProvision,
  FabricComponentRegistration,
  FabricComponentState,
  FabricComponentStopOptions,
} from "./components/types.js";

export {
  FABRIC_EXECUTION_GUIDANCE_SLOT,
  MAX_FABRIC_MODEL_GUIDANCE_CONTENT_CHARS,
  MAX_FABRIC_MODEL_GUIDANCE_PER_COMPONENT,
  MAX_FABRIC_MODEL_GUIDANCE_REGISTRATIONS,
  MAX_FABRIC_MODEL_GUIDANCE_SNAPSHOT_CHARS,
  MAX_FABRIC_MODEL_GUIDANCE_TOTAL_CHARS,
} from "./components/model-guidance.js";
