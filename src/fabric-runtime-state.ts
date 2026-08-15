import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FabricActivityStore } from "./activity/store.js";
import { ActorManager } from "./actors/manager.js";
import { GlobalActorRegistry } from "./actors/global-registry.js";
import { buildActorContext } from "./actors/context.js";
import { actorDeliveryNotice } from "./actors/delivery-policy.js";
import { prepareFabricActorHostPayload } from "./actors/host-event-payload.js";
import type { FabricActorHostEvent } from "./actors/types.js";
import { CapturedToolCatalog, type CapturedToolEntry } from "./capture/catalog.js";
import { FabricComponentCatalog } from "./components/catalog.js";
import { FabricComponentLoader } from "./components/loader.js";
import { FabricComponentSupervisor } from "./components/supervisor.js";
import {
  createProviderComponent,
  FABRIC_COMPONENT_PROVIDER_NAMES,
  FABRIC_PROVIDER_COMPONENT_PREFIX,
  FabricProviderComponentManifest,
  type FabricProviderComponent,
} from "./components/provider-component.js";
import type {
  FabricComponentDefinition,
  FabricComponentGraph,
  FabricComponentInfo,
} from "./components/types.js";
import {
  loadFabricConfig,
  type FabricConfig,
  type FabricResultFormat,
} from "./config.js";
import {
  ActionRegistry,
  type FabricCapabilityViewLease,
} from "./core/action-registry.js";
import { FabricSessionApprovals } from "./core/approval-controller.js";
import { CompactController, type CompactLastCommit, type CompactPendingIntent } from "./core/compact-controller.js";
import { FabricToolResultProxy } from "./core/tool-result-proxy.js";
import { FabricExecutionService, type FabricExecutionResult } from "./execution-service.js";
import { MeshStore, type MeshIdentity } from "./mesh/store.js";
import { LifecycleBroker } from "./lifecycle/broker.js";
import type { FabricLifecycleEventType } from "./lifecycle/types.js";
import { FabricControlPlane } from "./topology/control-plane.js";
import { ParticipantDirectory } from "./topology/participant-directory.js";
import type {
  FabricParticipantInfo,
  FabricParticipantListOptions,
  FabricPeerInfo,
} from "./topology/types.js";
import { actorParticipantRecord, agentParticipantRecords } from "./topology/records.js";
import { PrewalkController } from "./prewalk/controller.js";
import { PrewalkDriftTracker } from "./prewalk/fs-drift.js";
import {
  claimFabricFsDriftHandoff,
  claimFabricHandoff,
  runFabricHandoffAtBoundary,
  type PendingFabricHandoff,
} from "./prewalk/handoff.js";
import type { AgentToolResultMessage } from "./agents/types.js";
import {
  MainAgentController,
  resolveFabricIdentity,
  type FabricAgentMessageDelivery,
  type FabricAgentMessageResult,
  type FabricMainAgentInfo,
} from "./main-agent.js";
import { AgentsProvider } from "./providers/agents-provider.js";
import { CapturedToolsProvider } from "./providers/captured-tools-provider.js";
import { CompactProvider } from "./providers/compact-provider.js";
import { ComponentsProvider } from "./providers/components-provider.js";
import { McpDescriptorCacheStore } from "./providers/mcp-descriptor-cache.js";
import { McpProvider, type McpProviderHooks } from "./providers/mcp-provider.js";
import { MemoryProvider, type MemoryProviderContext } from "./providers/memory-provider.js";
import { MeshProvider } from "./providers/mesh-provider.js";
import { PiToolsProvider } from "./providers/pi-tools-provider.js";
import { SchemaProvider } from "./providers/schema-provider.js";
import { StateProvider } from "./providers/state-provider.js";
import { SchemaController } from "./schema/controller.js";
import { StateStore } from "./state/store.js";
import {
  FABRIC_COMPONENT_DISCOVER_EVENT,
  FABRIC_PROVIDER_DISCOVER_EVENT,
  type FabricActionDescriptor,
  type FabricComponentDiscovery,
  type FabricProvider,
  type FabricProviderDiscovery,
} from "./protocol.js";
import { AgentManager } from "./agents/manager.js";
import { ResidencyClient } from "./residency/client.js";
import { RESIDENT_HOST_FORMAT, residentRoot } from "./residency/protocol.js";
import type { FabricRuntimePaths } from "./runtime-paths.js";

const BACKGROUND_COMPLETION_MAX_CHARS = 8_000;
const inheritedCapabilityRequirements = (): string[] => {
  const source = process.env.PI_FABRIC_CAPABILITY_REQUIREMENTS;
  if (!source) return [];
  const parsed: unknown = JSON.parse(source);
  if (!Array.isArray(parsed) || parsed.length > 128) {
    throw new Error("PI_FABRIC_CAPABILITY_REQUIREMENTS must be an array of at most 128 refs");
  }
  const refs = parsed.filter((value): value is string => typeof value === "string");
  if (refs.length !== parsed.length || refs.some((ref) => ref.length > 256 || !ref.includes("."))) {
    throw new Error("PI_FABRIC_CAPABILITY_REQUIREMENTS contains an invalid provider.action ref");
  }
  return [...new Set(refs)];
};

const escapeXmlText = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");


export interface FabricRuntimeStateOptions {
  activity?: FabricActivityStore;
  prewalk?: PrewalkController;
  prewalkDrift?: PrewalkDriftTracker;
  sessionApprovals?: FabricSessionApprovals;
  paths?: FabricRuntimePaths;
}

export class FabricRuntimeState {
  #registry: ActionRegistry | undefined;
  #mcpProvider: McpProvider | undefined;
  #config: FabricConfig | undefined;
  #execution: FabricExecutionService | undefined;
  #agents: AgentManager | undefined;
  #actors: ActorManager | undefined;
  #globalActors: GlobalActorRegistry | undefined;
  #mesh: MeshStore | undefined;
  #identity: MeshIdentity | undefined;
  #mainAgent: MainAgentController | undefined;
  #participants: ParticipantDirectory | undefined;
  #control: FabricControlPlane | undefined;
  #lifecycle: LifecycleBroker | undefined;
  #residency: ResidencyClient | undefined;
  #agentsProvider: AgentsProvider | undefined;
  #compact: CompactController | undefined;
  #schema: SchemaController | undefined;
  #componentSupervisor: FabricComponentSupervisor | undefined;
  #componentLoader: FabricComponentLoader | undefined;
  readonly #componentTransitionSignatures = new Map<string, string>();
  readonly #componentTransitionPublications = new Set<Promise<void>>();
  #sessionCapabilityLease: FabricCapabilityViewLease | undefined;
  #unsubscribeCapturedCatalog: (() => void) | undefined;
  #cwd: string | undefined;
  readonly #externalProviders = new Map<string, FabricProvider>();
  readonly #builtinComponentNames = new Set<string>();
  readonly componentCatalog = new FabricComponentCatalog();
  readonly activity: FabricActivityStore;
  readonly prewalk: PrewalkController;
  readonly prewalkDrift: PrewalkDriftTracker;
  readonly sessionApprovals: FabricSessionApprovals;
  readonly #paths: FabricRuntimePaths | undefined;
  #widgetDismissedAt = 0;

  readonly #onCapturedToolUse: ((entry: CapturedToolEntry) => void) | undefined;
  readonly #mcpHooks: McpProviderHooks | undefined;

  constructor(
    readonly pi: ExtensionAPI,
    readonly capturedTools: CapturedToolCatalog,
    onCapturedToolUse?: (entry: CapturedToolEntry) => void,
    mcpHooks?: McpProviderHooks,
    options: FabricRuntimeStateOptions = {},
  ) {
    this.#onCapturedToolUse = onCapturedToolUse;
    this.#mcpHooks = mcpHooks;
    this.activity = options.activity ?? new FabricActivityStore();
    this.prewalk = options.prewalk ?? new PrewalkController();
    this.prewalkDrift = options.prewalkDrift ?? new PrewalkDriftTracker();
    this.sessionApprovals = options.sessionApprovals ?? new FabricSessionApprovals();
    this.#paths = options.paths;
  }

  get initialized(): boolean {
    return Boolean(this.#execution);
  }

  get widgetDismissedAt(): number {
    return this.#widgetDismissedAt;
  }

  set widgetDismissedAt(value: number) {
    this.#widgetDismissedAt = value;
  }

  get cwd(): string | undefined {
    return this.#cwd;
  }

  get config(): FabricConfig {
    if (!this.#config) throw new Error("Pi Fabric has not initialized");
    return this.#config;
  }

  get registry(): ActionRegistry {
    if (!this.#registry) throw new Error("Pi Fabric has not initialized");
    return this.#registry;
  }

  // Current MCP descriptor slice (cache-backed when mcp.cache is enabled), for
  // the capability advisory. Empty until the provider hydrates.
  mcpSlice(): FabricActionDescriptor[] {
    return this.#mcpProvider?.sliceDescriptors() ?? [];
  }

  get components(): FabricComponentLoader {
    if (!this.#componentLoader) throw new Error("Pi Fabric has not initialized");
    return this.#componentLoader;
  }

  get execution(): FabricExecutionService {
    if (!this.#execution) throw new Error("Pi Fabric has not initialized");
    return this.#execution;
  }

  get agents(): AgentManager {
    if (!this.#agents) throw new Error("Pi Fabric has not initialized");
    return this.#agents;
  }

  get actors(): ActorManager {
    if (!this.#actors) throw new Error("Pi Fabric has not initialized");
    return this.#actors;
  }

  get globalActors(): GlobalActorRegistry {
    if (!this.#globalActors) throw new Error("Pi Fabric has not initialized");
    return this.#globalActors;
  }

  get mesh(): MeshStore {
    if (!this.#mesh) throw new Error("Pi Fabric has not initialized");
    return this.#mesh;
  }

  mainAgentInfo(context?: ExtensionContext): FabricMainAgentInfo {
    if (!this.#mainAgent) throw new Error("Pi Fabric has not initialized");
    return this.#mainAgent.info(context);
  }

  peerInfos(): FabricPeerInfo[] {
    return this.#participants?.peers() ?? [];
  }

  componentGraph(): FabricComponentGraph {
    return this.#componentLoader?.graph() ?? { components: [], edges: [], cycles: [] };
  }

  participantInfos(options: FabricParticipantListOptions = {}): FabricParticipantInfo[] {
    return this.#participants?.list(options) ?? [];
  }

  async queueUserMessage(
    targetId: string,
    message: string,
    delivery: FabricAgentMessageDelivery,
  ): Promise<FabricAgentMessageResult> {
    if (!this.#mainAgent || !this.#agentsProvider) {
      throw new Error("Pi Fabric has not initialized");
    }
    if (this.#mainAgent.matches(targetId) && this.#mainAgent.local) {
      return this.#mainAgent.deliverUser(message, delivery);
    }
    return this.#agentsProvider.routeMessage(targetId, message, undefined, delivery);
  }

  async stopParticipant(targetId: string): Promise<unknown> {
    if (!this.#agentsProvider) throw new Error("Pi Fabric has not initialized");
    return this.#agentsProvider.stopParticipant(targetId);
  }

  get compact(): CompactController {
    if (!this.#compact) throw new Error("Pi Fabric has not initialized");
    return this.#compact;
  }

  async initialize(context: ExtensionContext, bootstrapConfig?: FabricConfig): Promise<void> {
    await this.#closeInternal();
    for (const name of this.#builtinComponentNames) this.componentCatalog.unregister(name);
    this.#builtinComponentNames.clear();
    this.prewalk.cancel();
    this.prewalkDrift.clear();
    context.ui.setStatus("fabric-prewalk", undefined);
    this.activity.reset();
    this.sessionApprovals.approvedRisks.clear();
    this.#cwd = context.cwd;
    const projectTrusted = context.isProjectTrusted();
    this.#config = bootstrapConfig ?? loadFabricConfig({
      cwd: context.cwd,
      agentDir: getAgentDir(),
      projectTrusted,
    });
    this.#registry = new ActionRegistry(
      new FabricToolResultProxy(() => this.capturedTools.runner),
    );
    this.#unsubscribeCapturedCatalog = this.capturedTools.subscribe(() =>
      this.#registry?.notifyCatalogChanged("extensions"),
    );
    this.#componentSupervisor = new FabricComponentSupervisor(this.#registry, {
      invocationContext: () => ({
        cwd: context.cwd,
        signal: undefined,
        parentToolCallId: "fabric-component",
        nestedToolCallId: "fabric-component",
        extensionContext: context,
        update() {},
      }),
      maxResultChars: this.#config.executor.maxNestedResultChars,
      acquire: async (ref, args, invocation) => {
        const action = await this.#registry!.describe(ref, invocation);
        await this.#schema?.authorize(action.ref, invocation.parentToolCallId);
        return this.#registry!.acquireScoped(ref, args, invocation);
      },
      invoke: (ref, args, invocation) => this.#registry!.invoke(ref, args, {
        ...invocation,
        ...(this.#schema
          ? { authorize: (action) => this.#schema!.authorize(action.ref, invocation.parentToolCallId) }
          : {}),
        approve: async () => {},
        audits: [],
        maxResultChars: this.#config!.executor.maxNestedResultChars,
      }),
    });
    this.#componentSupervisor.subscribe((componentId) =>
      this.#observeComponentTransitions(componentId),
    );
    this.#componentLoader = new FabricComponentLoader(
      this.componentCatalog,
      this.#componentSupervisor,
    );
    this.#registry.register(new ComponentsProvider(this.#componentLoader));
    const builtinManifest = new FabricProviderComponentManifest(
      this.componentCatalog,
      this.#componentLoader,
    );
    const installBuiltin = async (component: FabricProviderComponent): Promise<void> => {
      await builtinManifest.install(component);
      this.#builtinComponentNames.add(component.definition.name);
    };
    const enforceSchema = this.#config.schema.mode === "enforce";
    const effectiveFullCodeMode = this.#config.fullCodeMode || enforceSchema;
    const capturedToolsProvider =
      effectiveFullCodeMode && this.#config.capture.enabled && !enforceSchema
        ? new CapturedToolsProvider(this.capturedTools, this.#onCapturedToolUse)
        : undefined;
    if (effectiveFullCodeMode) {
      await installBuiltin(createProviderComponent({
        provider: "pi",
        description: "Pi core tools adapter",
        create: () => new PiToolsProvider(
          context.cwd,
          enforceSchema ? undefined : this.capturedTools,
          capturedToolsProvider,
        ),
      }));
    }
    await installBuiltin(createProviderComponent({
      provider: "mcp",
      description: "MCP runtime and descriptor cache",
      create: () => new McpProvider(context.cwd, this.#config!.mcp, {
        ...(this.#config!.mcp.cache.enabled
          ? {
              cache: new McpDescriptorCacheStore(
                path.join(
                  process.env.PI_FABRIC_PROJECT_ROOT ?? context.cwd,
                  ".pi",
                  "fabric",
                  "mcp-cache.json",
                ),
              ),
            }
          : {}),
        hooks: {
          onSliceChanged: (descriptors) => {
            this.#registry?.notifyCatalogChanged("mcp");
            this.#mcpHooks?.onSliceChanged?.(descriptors);
          },
          onToolUse: (server) => this.#mcpHooks?.onToolUse?.(server),
        },
      }),
      mounted: (provider) => { this.#mcpProvider = provider; },
      unmounted: (provider) => {
        if (this.#mcpProvider === provider) this.#mcpProvider = undefined;
      },
      start: (provider) => { provider.warmup(); },
    }));
    if (capturedToolsProvider) {
      await installBuiltin(createProviderComponent({
        provider: "extensions",
        description: "Captured extension tool catalog",
        create: () => capturedToolsProvider,
      }));
    }
    const sessionId = context.sessionManager.getSessionId();
    const { identity, mainAgentId } = resolveFabricIdentity(sessionId);
    const ownsPersistentActorRegistry =
      identity.kind === "main" &&
      !enforceSchema &&
      projectTrusted &&
      this.#config.mesh.enabled;
    const mainAgent = new MainAgentController(
      this.pi,
      mainAgentId,
      identity.kind === "main" && identity.id === mainAgentId,
      context.cwd,
      identity.kind === "main" ? sessionId : undefined,
    );
    this.#mainAgent = mainAgent;
    const projectRoot = process.env.PI_FABRIC_PROJECT_ROOT ?? context.cwd;
    const configuredMeshRoot = this.#config.mesh.root;
    const meshRoot =
      process.env.PI_FABRIC_MESH_ROOT ??
      (configuredMeshRoot
        ? path.resolve(projectRoot, configuredMeshRoot)
        : path.join(projectRoot, ".pi", "fabric", "mesh"));
    this.#mesh = new MeshStore(
      meshRoot,
      this.#config.mesh.maxEventBytes,
      this.#config.mesh.maxReadEvents,
    );
    const hostId = identity.kind === "main" ? mainAgentId : `runtime:${sessionId}`;
    this.#participants = new ParticipantDirectory(this.#mesh, {
      enabled: this.#config.mesh.enabled,
      hostId,
      rootId: mainAgentId,
      identity,
      ...(process.env.PI_FABRIC_OWNER_HOST_ID
        ? { selfOwnerHostId: process.env.PI_FABRIC_OWNER_HOST_ID }
        : {}),
      ...(process.env.PI_FABRIC_OWNER_IDENTITY_ID
        ? { selfOwnerIdentityId: process.env.PI_FABRIC_OWNER_IDENTITY_ID }
        : {}),
    });
    this.#control = new FabricControlPlane(this.#mesh, identity, {
      enabled: this.#config.mesh.enabled,
      hostId,
      pollMs: this.#config.mesh.actorPollMs,
    });
    if (this.#config.mesh.enabled) {
      await installBuiltin(createProviderComponent({
        provider: "mesh",
        description: "Project mesh and participant directory",
        create: () => new MeshProvider(this.#mesh!, identity, this.#participants!),
      }));
      await installBuiltin(createProviderComponent({
        provider: "state",
        description: "Labeled world state over the project mesh",
        requires: ["mesh.get"],
        create: () => new StateProvider(this.#mesh!, identity),
      }));
    } else {
      const meshDisabled =
        'disabled by configuration (mesh.enabled=false); set "mesh": { "enabled": true } in .pi/fabric.json or the agent fabric.json';
      this.#registry.markUnavailable("mesh", `${meshDisabled} to enable mesh.* actions`);
      this.#registry.markUnavailable("state", `${meshDisabled}; state.* actions run on the mesh`);
    }
    this.#schema = new SchemaController(
      context.cwd,
      this.#config.schema,
      this.#mesh,
      identity,
      new StateStore(this.#mesh),
    );
    await installBuiltin(createProviderComponent({
      provider: "schema",
      description: "Schema verification and workspace transactions",
      create: () => new SchemaProvider(this.#schema!),
    }));
    this.#identity = identity;
    this.#compact = new CompactController({
      onRequest: (intent) => void this.#publishCompactEvent("requested", intent),
      onCommit: (info) => void this.#publishCompactEvent(info.status, info),
    });
    await installBuiltin(createProviderComponent({
      provider: "compact",
      description: "Host context compaction controller",
      create: () => new CompactProvider(this.#compact!),
    }));
    const agentConfig = enforceSchema
      ? { ...this.#config.agents, enabled: false }
      : this.#config.agents;
    this.#agents = new AgentManager(context.cwd, agentConfig, {
      fullCodeMode: this.#config.fullCodeMode,
      mainAgentId,
      meshRoot,
      projectRoot,
      hostId,
      identityId: identity.id,
      retention: this.#config.retention,
      ...(this.#paths
        ? {
            workerPath: this.#paths.worker,
            fabricExtensionPath: this.#paths.extension,
          }
        : {}),
      preparePiModel: async (modelKey) => {
        const separator = modelKey.indexOf("/");
        if (separator <= 0 || separator === modelKey.length - 1) return;
        const model = context.modelRegistry.find(
          modelKey.slice(0, separator),
          modelKey.slice(separator + 1),
        );
        if (!model) return;
        const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) throw new Error(auth.error);
      },
      onLifecycle: (event) => {
        const lifecycle = this.#lifecycle;
        if (lifecycle) void lifecycle.publish(event).catch(() => undefined);
      },
      onBackgroundComplete: (result) => {
        const durationMs = Math.max(0, (result.finishedAt ?? Date.now()) - result.startedAt);
        const duration =
          durationMs < 60_000
            ? `${Math.round(durationMs / 1_000)}s`
            : `${(durationMs / 60_000).toFixed(1)}m`;
        const summary = result.text || result.error || "no result";
        const clippedSummary =
          summary.length > BACKGROUND_COMPLETION_MAX_CHARS
            ? `${summary.slice(0, BACKGROUND_COMPLETION_MAX_CHARS)}\n[completion truncated]`
            : summary;
        this.pi.sendMessage(
          {
            customType: "pi-fabric-agent-complete",
            content: `Fabric agent ${result.id.slice(0, 8)} ${result.status} after ${duration}: ${clippedSummary}`,
            display: true,
            details: result,
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      },
    });
    const canManageActor = (actorId: string): boolean | undefined => {
      const participant = this.#participants?.get(actorId);
      return participant ? participant.ownerHostId === hostId : undefined;
    };
    const lineageAlive = (rootId: string): boolean =>
      this.#participants?.get(rootId) !== undefined;
    const persistentActorRoot =
      this.#config.mesh.actorScope === "session"
        ? path.join(meshRoot, "actors", sessionId)
        : path.join(meshRoot, "actors");
    const acquireActorCapabilityView = (
      requirements: Parameters<ActionRegistry["acquireCapabilityView"]>[0],
      signal: AbortSignal,
    ) => this.#registry!.acquireCapabilityView(requirements, {
      cwd: context.cwd,
      signal,
      parentToolCallId: "fabric-actor-capability",
      nestedToolCallId: "fabric-actor-capability",
      extensionContext: context,
      update() {},
    });
    this.#actors = new ActorManager(
      sessionId,
      identity,
      this.#mesh,
      enforceSchema ? { ...this.#config.mesh, enabled: false } : this.#config.mesh,
      this.#agents,
      ({ actor, message, delivery, triggerTurn }) => {
        const text = message.text ?? "";
        if (!text) return;
        const deliveryNotice = actorDeliveryNotice(delivery, triggerTurn);
        this.pi.sendMessage(
          {
            customType: "pi-fabric-actor",
            content: [
              `<fabric-actor name=${JSON.stringify(actor.name)} id=${JSON.stringify(actor.id)}>\n${escapeXmlText(text)}\n</fabric-actor>`,
              deliveryNotice,
            ]
              .filter((line): line is string => Boolean(line))
              .join("\n"),
            display: true,
            details: {
              actor,
              message,
              delivery: { mode: delivery, triggerTurn, passive: Boolean(deliveryNotice) },
            },
          },
          { deliverAs: delivery, triggerTurn },
        );
      },
      ownsPersistentActorRegistry
        ? {
            actorRoot: persistentActorRoot,
            persistent: true,
            mainAgent,
            canManageActor,
            lineageAlive,
            claimResidency: "session",
            rootId: mainAgentId,
            retention: this.#config.retention,
            acquireCapabilityView: acquireActorCapabilityView,
          }
        : {
            persistent: false,
            mainAgent,
            canManageActor,
            lineageAlive,
            claimResidency: "session",
            rootId: mainAgentId,
            retention: this.#config.retention,
            acquireCapabilityView: acquireActorCapabilityView,
          },
    );
    this.#registry.subscribeProviderChanges(() => this.#actors?.retryCapabilityWaiters());
    this.#lifecycle = new LifecycleBroker(
      this.#mesh,
      identity,
      this.#participants,
      {
        enabled: this.#config.mesh.enabled && !enforceSchema,
        pollMs: this.#config.mesh.actorPollMs,
        maxReadEvents: this.#config.mesh.maxReadEvents,
      },
      async (subscription, event) => {
        if (!this.#agentsProvider) throw new Error("Fabric agents provider is unavailable");
        await this.#agentsProvider.deliverLifecycle(subscription, event);
      },
    );
    this.#globalActors = new GlobalActorRegistry(getAgentDir(), this.#config.mesh.maxEventBytes);
    this.#residency = ownsPersistentActorRegistry
      ? new ResidencyClient({
          config: {
            format: RESIDENT_HOST_FORMAT,
            rootId: mainAgentId,
            sessionId,
            cwd: context.cwd,
            projectRoot,
            meshRoot,
            actorRoot: persistentActorRoot,
            residencyRoot: residentRoot(meshRoot, mainAgentId),
            fullCodeMode: this.#config.fullCodeMode,
            agents: structuredClone(this.#config.agents),
            mesh: structuredClone(this.#config.mesh),
            retention: structuredClone(this.#config.retention),
            workerPath: this.#paths?.worker ?? fileURLToPath(new URL("./worker.js", import.meta.url)),
            fabricExtensionPath: this.#paths?.extension ?? fileURLToPath(new URL("./index.js", import.meta.url)),
            piBinary: process.env.PI_FABRIC_PI_BINARY ?? "pi",
            claudeBinary:
              process.env.PI_FABRIC_CLAUDE_BINARY ?? this.#config.agents.claude.binary,
            vedaBinary:
              process.env.PI_FABRIC_VEDA_BINARY ?? this.#config.agents.veda.binary,
          },
          mesh: this.#mesh,
          participants: this.#participants,
          mainAgent,
          ...(this.#paths ? { hostPath: this.#paths.residentHost } : {}),
        })
      : undefined;
    const firstSeenAgents = new Map<string, number>();
    if (mainAgent.local) {
      this.#participants.registerSource(() => [
        this.#participants!.root(mainAgent.info(context)),
      ]);
    }
    this.#participants.registerSource(() =>
      agentParticipantRecords(
        this.#agents!.listForUi(),
        mainAgentId,
        hostId,
        identity.id,
        identity.id,
        firstSeenAgents,
      ),
    );
    this.#participants.registerSource(() =>
      this.#actors!.listOwned().map((actor) =>
        actorParticipantRecord(actor, mainAgentId, hostId, identity.id, identity.id),
      ),
    );
    this.#agents.subscribeUi(() => this.#participants?.scheduleRefresh());
    this.#actors.subscribe(() => this.#participants?.scheduleRefresh());
    const agentsProvider = new AgentsProvider(
      this.#agents,
      this.#actors,
      this.#globalActors,
      mainAgent,
      this.#participants,
      this.#control,
      this.#lifecycle,
      () => this.#config?.ui.showAgentToolPreview ?? true,
      this.#residency,
      false,
    );
    this.#agentsProvider = agentsProvider;
    this.#control.start((command, from) => agentsProvider.acceptControl(command, from));
    try {
      await this.#participants.start();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `[pi-fabric] Initial mesh publish failed (${detail}); the participant heartbeat will keep retrying.`,
      );
      if (context.hasUI) {
        context.ui.notify(
          `Pi Fabric could not reach the mesh (${detail}); retrying in the background.`,
          "warning",
        );
      }
    }
    this.#lifecycle.start();
    this.#residency?.start();
    await installBuiltin(createProviderComponent({
      provider: "agents",
      description: "Agents, actors, lifecycle delivery, and residency control",
      create: () => agentsProvider,
    }));
    if (this.#config.memory.enabled) {
      const sessionFile = context.sessionManager.getSessionFile();
      const memoryContext: MemoryProviderContext = {
        agentDir: getAgentDir(),
        cwd: context.cwd,
        config: this.#config.memory,
        sessionId,
        ...(sessionFile ? { sessionFile } : {}),
        getLiveBranch: () => ({
          entries: context.sessionManager.getBranch(),
          leafId: context.sessionManager.getLeafId(),
        }),
      };
      await installBuiltin(createProviderComponent({
        provider: "memory",
        description: "Session memory index and source hydration",
        create: () => new MemoryProvider(memoryContext),
      }));
    } else {
      this.#registry.markUnavailable(
        "memory",
        'disabled by configuration (memory.enabled=false); set "memory": { "enabled": true } in .pi/fabric.json or the agent fabric.json to enable memory.* actions',
      );
    }
    const expectedBuiltinProviders = new Set<string>([
      ...(effectiveFullCodeMode ? ["pi"] : []),
      ...(capturedToolsProvider ? ["extensions"] : []),
      "mcp",
      ...(this.#config.mesh.enabled ? ["mesh", "state"] : []),
      "schema",
      "compact",
      "agents",
      ...(this.#config.memory.enabled ? ["memory"] : []),
    ]);
    builtinManifest.assertActive(expectedBuiltinProviders, this.#registry);
    for (const provider of this.#externalProviders.values()) {
      this.#registry.register(provider);
    }
    this.#execution = new FabricExecutionService(
      this.#registry,
      this.#config,
      this.activity,
      this.#schema,
      undefined,
      this.sessionApprovals,
      this.capturedTools,
    );
    const discovery: FabricProviderDiscovery = {
      version: 1,
      register: (provider, options) => this.registerExternal(provider, options),
    };
    this.pi.events.emit(FABRIC_PROVIDER_DISCOVER_EVENT, discovery);
    const componentDiscovery: FabricComponentDiscovery = {
      version: 1,
      register: (component, options) => this.registerExternalComponent(component, options),
    };
    this.pi.events.emit(FABRIC_COMPONENT_DISCOVER_EVENT, componentDiscovery);
    await this.#componentLoader.reconcile(enforceSchema ? [] : this.#config.components);
    const inheritedRequirements = inheritedCapabilityRequirements();
    const inheritedDigest = process.env.PI_FABRIC_CAPABILITY_DIGEST;
    const hasInheritedCommit =
      process.env.PI_FABRIC_CAPABILITY_REQUIREMENTS !== undefined && Boolean(inheritedDigest);
    if (inheritedRequirements.length > 0 || hasInheritedCommit) {
      const lease = await this.#registry.acquireCapabilityView(inheritedRequirements, {
        cwd: context.cwd,
        signal: undefined,
        parentToolCallId: "fabric-capability-commit",
        nestedToolCallId: "fabric-capability-commit",
        extensionContext: context,
        update() {},
      });
      if (!lease.satisfied || !lease.view) {
        await lease.release();
        throw new Error(
          `Required Fabric capabilities are unavailable: ${lease.missing.join(", ")}`,
        );
      }
      const expectedDigest = inheritedDigest;
      if (expectedDigest && lease.view.semanticDigest !== expectedDigest) {
        await lease.release();
        throw new Error(
          `Fabric capability commitment mismatch: expected ${expectedDigest}, resolved ${lease.view.semanticDigest}`,
        );
      }
      this.#sessionCapabilityLease = lease;
      this.#execution.setCapabilityView(lease.view);
    }
  }

  async ensure(context: ExtensionContext): Promise<void> {
    if (!this.initialized || this.#cwd !== context.cwd) await this.initialize(context);
  }

  reloadConfig(context: ExtensionContext): void {
    if (!this.#config || !this.#cwd) return;
    const next = loadFabricConfig({
      cwd: context.cwd,
      agentDir: getAgentDir(),
      projectTrusted: context.isProjectTrusted(),
    });
    next.schema.mode = this.#config.schema.mode;
    const previousComponents = structuredClone(this.#config.components);
    deepAssign(this.#config as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
    void this.#componentLoader?.reconcile(next.components).catch((error) => {
      if (this.#config) this.#config.components = previousComponents;
      const detail = error instanceof Error ? error.message : String(error);
      if (context.hasUI) context.ui.notify(`Pi Fabric component reload failed: ${detail}`, "error");
    });
  }

  async claimHandoff(
    execution: FabricExecutionResult,
    sessionId: string,
    resultFormat: FabricResultFormat,
    outerToolCallId: string,
  ): Promise<PendingFabricHandoff | undefined> {
    let pending = claimFabricHandoff(this.prewalk, execution, sessionId, resultFormat);
    if (!pending && this.#config?.prewalk.detectShellWrites) {
      pending = await this.#claimShellWriteHandoff(execution, sessionId, resultFormat);
    }
    if (pending) {
      this.activity.resume(outerToolCallId);
      this.activity.beginCall(outerToolCallId, {
        callId: pending.audit.nestedToolCallId,
        ref: pending.audit.ref,
        args: pending.args,
      });
    }
    return pending;
  }

  // Filesystem fallback for writes audits cannot attribute (shell heredocs,
  // sed -i, formatter binaries). Gated on a successful pi.bash in the program
  // so read-only scans never pay the stat walk, and external saves can only
  // mis-fire inside a bash-running window. The tracker refreshes its baseline
  // on every evaluation, claimed or not, so one change never fires twice.
  async #claimShellWriteHandoff(
    execution: FabricExecutionResult,
    sessionId: string,
    resultFormat: FabricResultFormat,
  ): Promise<PendingFabricHandoff | undefined> {
    if (!this.prewalk.isArmed(sessionId) || !this.#cwd) return undefined;
    if (!execution.audits.some((audit) => audit.ref === "pi.bash" && audit.success === true)) {
      return undefined;
    }
    const drift = await this.prewalkDrift.evaluate(sessionId, this.#cwd);
    if (!drift || drift.files.length === 0) return undefined;
    return claimFabricFsDriftHandoff(this.prewalk, execution, sessionId, drift, resultFormat);
  }

  async runHandoffAtBoundary(
    pending: PendingFabricHandoff,
    outerToolResult: AgentToolResultMessage,
    context: ExtensionContext,
  ): Promise<Record<string, unknown>> {
    if (!this.#agentsProvider) throw new Error("Pi Fabric has not initialized");
    const runId = outerToolResult.toolCallId;
    const callId = pending.audit.nestedToolCallId;
    const result = await runFabricHandoffAtBoundary(
      this.prewalk,
      this.#agentsProvider,
      this.pi,
      pending,
      outerToolResult,
      context,
      (update) => this.activity.updateCall(runId, callId, update),
    );
    const succeeded = result.completed === true || result.continued === true;
    const error = typeof result.error === "string" ? result.error : undefined;
    this.activity.finishCall(runId, callId, {
      success: succeeded,
      result,
      ...(pending.audit.preview !== undefined ? { preview: pending.audit.preview } : {}),
      ...(error ? { error } : {}),
    });
    this.activity.finish(runId, succeeded, error);
    return result;
  }

  noteMainActivity(context: ExtensionContext): void {
    this.#actors?.noteMainActivity(context.isIdle());
    this.#participants?.scheduleRefresh();
  }

  dispatchHostEvent(
    event: FabricActorHostEvent,
    payload: unknown,
    context: ExtensionContext,
  ): number {
    if (
      !this.#actors ||
      !this.#config?.mesh.enabled ||
      this.#config.schema.mode === "enforce"
    ) return 0;
    const idle = context.isIdle();
    if (!this.#actors.observeHostEvent(event, idle)) return 0;
    const branch = context.sessionManager.getBranch();
    const { digest, transcript } = buildActorContext(
      branch as unknown[],
      this.#config.mesh.actorContextEntries,
      this.#config.mesh.eventContextChars,
    );
    const prepared = prepareFabricActorHostPayload(
      payload,
      this.#config.mesh.eventContextChars,
    );
    const preparedContext = prepareFabricActorHostPayload(
      { digest, transcript },
      this.#config.mesh.eventContextChars,
    ).payload;
    const safeContext = isPlainObject(preparedContext)
      ? preparedContext
      : { digest: {}, transcript: [String(preparedContext)] };
    return this.#actors.dispatchObservedHostEvent(
      event,
      {
        event,
        session: { id: context.sessionManager.getSessionId(), cwd: context.cwd },
        digest: safeContext.digest ?? {},
        transcript: safeContext.transcript ?? [],
        signal: {
          payload: prepared.payload,
          ...(prepared.media.length > 0 ? { media: prepared.media } : {}),
          idle,
          observedAt: Date.now(),
        },
      },
      prepared.images,
    );
  }

  #observeComponentTransitions(componentId?: string): void {
    let components: FabricComponentInfo[];
    if (componentId) {
      try {
        components = this.#componentSupervisor
          ? [this.#componentSupervisor.status(componentId)]
          : [];
      } catch {
        this.#componentTransitionSignatures.delete(componentId);
        return;
      }
    } else {
      components = this.#componentSupervisor?.list() ?? [];
    }
    const visible = componentId ? undefined : new Set<string>();
    for (const component of components) {
      visible?.add(component.id);
      const signature = [
        component.state,
        component.revision,
        component.targetDigest ?? "",
        component.missing.join("\u0000"),
        component.optionalMissing.join("\u0000"),
        component.error ?? "",
        component.cleanupErrors?.join("\u0000") ?? "",
      ].join("\u0001");
      if (this.#componentTransitionSignatures.get(component.id) === signature) continue;
      this.#componentTransitionSignatures.set(component.id, signature);
      const publication = this.publishHostLifecycle("component.state", component)
        .catch(() => undefined);
      this.#componentTransitionPublications.add(publication);
      void publication.finally(() => this.#componentTransitionPublications.delete(publication));
    }
    if (visible) {
      for (const id of this.#componentTransitionSignatures.keys()) {
        if (!visible.has(id)) this.#componentTransitionSignatures.delete(id);
      }
    }
  }

  async publishHostLifecycle(
    event: FabricLifecycleEventType,
    payload: unknown,
  ): Promise<void> {
    if (
      !this.#lifecycle ||
      !this.#identity ||
      this.#identity.kind !== "main" ||
      !this.#participants
    ) return;
    const self = this.#participants.self();
    const metadata = lifecycleMetadata(event, payload);
    await this.#lifecycle.publish({
      source: {
        id: self.id,
        name: self.name,
        kind: self.kind,
        rootId: self.rootId,
        runner: self.runner,
        ownerHostId: self.ownerHostId,
        ownerIdentityId: self.ownerIdentityId,
      },
      event,
      occurredAt: lifecycleObservedAt(payload),
      ...(metadata !== undefined ? { data: metadata } : {}),
    });
  }

  registerExternal(provider: FabricProvider, options: { overwrite?: boolean } = {}): void {
    if (
      provider.name === "fabric" ||
      provider.name === "components" ||
      FABRIC_COMPONENT_PROVIDER_NAMES.some((name) => name === provider.name)
    ) {
      throw new Error(`Reserved Fabric provider name: ${provider.name}`);
    }
    if (this.#externalProviders.has(provider.name) && !options.overwrite) {
      throw new Error(`Fabric provider already registered: ${provider.name}`);
    }
    this.#externalProviders.set(provider.name, provider);
    if (this.#registry) this.#registry.register(provider, options);
  }

  registerExternalComponent(
    component: FabricComponentDefinition,
    options: { overwrite?: boolean } = {},
  ): void {
    if (component.name.startsWith(FABRIC_PROVIDER_COMPONENT_PREFIX)) {
      throw new Error(`Reserved Fabric component name: ${component.name}`);
    }
    this.componentCatalog.register(component, options);
  }

  async settleComponents(): Promise<void> {
    await this.#componentLoader?.settle();
  }

  async shutdown(): Promise<void> {
    await this.#participants?.quiesce().catch(() => undefined);
    await this.#componentLoader?.close();
    await Promise.allSettled([...this.#componentTransitionPublications]);
    await this.#sessionCapabilityLease?.release().catch(() => undefined);
    this.#sessionCapabilityLease = undefined;
    await this.#lifecycle?.close();
    await this.#control?.close();
    await this.#residency?.close();
    await this.#actors?.close();
    await this.#agents?.close();
    try {
      await this.#registry?.close();
    } finally {
      await this.#participants?.close();
    }
    this.#registry = undefined;
    this.#mcpProvider = undefined;
    this.#config = undefined;
    this.#execution = undefined;
    this.#agents = undefined;
    this.#actors = undefined;
    this.#globalActors = undefined;
    this.#mesh = undefined;
    this.#identity = undefined;
    this.#mainAgent = undefined;
    this.#participants = undefined;
    this.#control = undefined;
    this.#lifecycle = undefined;
    this.#residency = undefined;
    this.#agentsProvider = undefined;
    this.#compact = undefined;
    this.#schema = undefined;
    this.#componentSupervisor = undefined;
    this.#componentLoader = undefined;
    this.#componentTransitionSignatures.clear();
    this.#componentTransitionPublications.clear();
    this.#sessionCapabilityLease = undefined;
    this.#unsubscribeCapturedCatalog?.();
    this.#unsubscribeCapturedCatalog = undefined;
    this.componentCatalog.clear();
    this.#builtinComponentNames.clear();
    this.#cwd = undefined;
    this.activity.reset();
    this.#widgetDismissedAt = 0;
    this.#externalProviders.clear();
    this.prewalk.cancel();
    this.prewalkDrift.clear();
  }

  // Publish a best-effort mesh event to the durable `fabric.compact` topic so
  // other roots, agents, and actors can observe compaction transitions.
  // Activity-only sessions (mesh disabled) silently skip this.
  #publishCompactEvent(kind: string, data: CompactPendingIntent | CompactLastCommit): void {
    if (!this.#mesh || !this.#identity || !this.#config?.mesh.enabled) return;
    try {
      void this.#mesh.publish({
        topic: "fabric.compact",
        kind,
        from: this.#identity,
        data,
      });
    } catch {
      // Best-effort: a full event log or an oversized payload must not break
      // the host compaction path.
    }
  }

  async #closeInternal(): Promise<void> {
    if (!this.#registry) return;
    await this.#participants?.quiesce().catch(() => undefined);
    await this.#componentLoader?.close();
    await Promise.allSettled([...this.#componentTransitionPublications]);
    await this.#sessionCapabilityLease?.release().catch(() => undefined);
    this.#sessionCapabilityLease = undefined;
    await this.#lifecycle?.close();
    await this.#control?.close();
    await this.#residency?.close();
    await this.#actors?.close();
    await this.#agents?.close();
    const externalNames = new Set(this.#externalProviders.keys());
    try {
      await this.#registry.close(externalNames);
    } finally {
      await this.#participants?.close();
    }
    this.#registry = undefined;
    this.#mcpProvider = undefined;
    this.#execution = undefined;
    this.#agents = undefined;
    this.#actors = undefined;
    this.#mesh = undefined;
    this.#identity = undefined;
    this.#mainAgent = undefined;
    this.#participants = undefined;
    this.#control = undefined;
    this.#lifecycle = undefined;
    this.#residency = undefined;
    this.#agentsProvider = undefined;
    this.#compact = undefined;
    this.#schema = undefined;
    this.#componentSupervisor = undefined;
    this.#componentLoader = undefined;
    this.#componentTransitionSignatures.clear();
    this.#componentTransitionPublications.clear();
    this.#sessionCapabilityLease = undefined;
    this.#unsubscribeCapturedCatalog?.();
    this.#unsubscribeCapturedCatalog = undefined;
  }
}

const scalarMetadata = (
  value: unknown,
  keys: readonly string[],
): Record<string, string | number | boolean | null> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    const nested = source[key];
    if (
      typeof nested === "string" ||
      typeof nested === "number" ||
      typeof nested === "boolean" ||
      nested === null
    ) metadata[key] = nested;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
};

const lifecycleMetadata = (
  event: FabricLifecycleEventType,
  payload: unknown,
): Record<string, string | number | boolean | null> | undefined => {
  switch (event) {
    case "pi.input":
      return scalarMetadata(payload, ["source", "streamingBehavior"]);
    case "pi.agent_end":
      return scalarMetadata(payload, ["willRetry"]);
    case "pi.turn_end":
      return scalarMetadata(payload, ["turnIndex", "timestamp"]);
    case "pi.tool_error":
      return scalarMetadata(payload, ["toolCallId", "toolName"]);
    case "pi.session_compact":
      return scalarMetadata(payload, ["reason", "willRetry"]);
    case "component.state":
      return scalarMetadata(payload, [
        "id",
        "component",
        "parentId",
        "state",
        "guarantee",
        "revision",
        "targetDigest",
      ]);
    default:
      return undefined;
  }
};

const lifecycleObservedAt = (payload: unknown): number => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return Date.now();
  const timestamp = (payload as Record<string, unknown>).timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : Date.now();
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const deepAssign = (
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void => {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key];
  }
  for (const [key, value] of Object.entries(source)) {
    const targetValue = target[key];
    if (isPlainObject(value) && isPlainObject(targetValue)) {
      deepAssign(targetValue, value);
    } else {
      target[key] = value;
    }
  }
};
