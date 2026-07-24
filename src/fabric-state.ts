import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { FabricActivityStore } from "./activity/store.js";
import { ActorManager } from "./actors/manager.js";
import { GlobalActorRegistry } from "./actors/global-registry.js";
import { buildActorContext } from "./actors/context.js";
import { actorDeliveryNotice } from "./actors/delivery-policy.js";
import { prepareFabricActorHostPayload } from "./actors/host-event-payload.js";
import type { FabricActorHostEvent, FabricActorInfo } from "./actors/types.js";
import { CapturedToolCatalog } from "./capture/catalog.js";
import {
  loadFabricConfig,
  type FabricConfig,
  type FabricResultFormat,
} from "./config.js";
import { ActionRegistry } from "./core/action-registry.js";
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
  FabricParticipantRecord,
  FabricPeerInfo,
} from "./topology/types.js";
import { PrewalkController } from "./prewalk/controller.js";
import {
  claimFabricHandoff,
  runFabricHandoffAtBoundary,
  type PendingFabricHandoff,
} from "./prewalk/handoff.js";
import type {
  SubagentHandleInfo,
  SubagentRunRecord,
  SubagentToolResultMessage,
} from "./subagents/types.js";
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
import { McpProvider } from "./providers/mcp-provider.js";
import { MemoryProvider, type MemoryProviderContext } from "./providers/memory-provider.js";
import { MeshProvider } from "./providers/mesh-provider.js";
import { PiToolsProvider } from "./providers/pi-tools-provider.js";
import { SchemaProvider } from "./providers/schema-provider.js";
import { StateProvider } from "./providers/state-provider.js";
import { SchemaController } from "./schema/controller.js";
import { StateStore } from "./state/store.js";
import {
  FABRIC_PROVIDER_DISCOVER_EVENT,
  type FabricProvider,
  type FabricProviderDiscovery,
} from "./protocol.js";
import { SubagentManager } from "./subagents/manager.js";

const BACKGROUND_COMPLETION_MAX_CHARS = 8_000;

const escapeXmlText = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const isSubagentRunRecord = (
  record: SubagentRunRecord | SubagentHandleInfo,
): record is SubagentRunRecord => "startedAt" in record;

const agentParticipantRecords = (
  records: Array<SubagentRunRecord | SubagentHandleInfo>,
  rootId: string,
  ownerHostId: string,
  ownerIdentityId: string,
  parentId: string,
  firstSeen: Map<string, number>,
): FabricParticipantRecord[] => {
  const participants: FabricParticipantRecord[] = [];
  const append = (
    record: SubagentRunRecord | SubagentHandleInfo,
    semanticParentId: string,
  ): void => {
    const observedAt = firstSeen.get(record.id) ?? Date.now();
    firstSeen.set(record.id, observedAt);
    const run = isSubagentRunRecord(record) ? record : undefined;
    const parent = record.actorId ?? semanticParentId;
    if (!record.actorId) {
      const active = record.status === "queued" || record.status === "running";
      participants.push({
        format: 1,
        id: record.id,
        kind: "agent",
        rootId,
        ownerHostId,
        ownerIdentityId,
        parentId: parent,
        name: record.name,
        status: record.status,
        runner: record.runner,
        transport: record.transport,
        capabilities: [
          ...(active ? (["steer", "followUp", "stop"] as const) : []),
          ...(record.attachCommand ? (["attach"] as const) : []),
          ...(record.recursive ? (["fabric"] as const) : []),
        ],
        cwd: record.cwd,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        ...(record.model ? { model: record.model } : {}),
        ...(record.thinking ? { thinking: record.thinking } : {}),
        startedAt: run?.startedAt ?? observedAt,
        updatedAt: run?.updatedAt ?? observedAt,
        ...(run?.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
        ...(run?.currentTool ? { currentTool: run.currentTool } : {}),
        ...(run ? { turns: run.turns, toolCalls: run.toolCalls, usage: { ...run.usage } } : {}),
        controlProtocol: "v1",
      });
    }
  };
  for (const record of records) append(record, parentId);
  return participants;
};

const actorParticipantRecord = (
  actor: FabricActorInfo,
  rootId: string,
  ownerHostId: string,
  ownerIdentityId: string,
  parentId: string,
): FabricParticipantRecord => ({
  format: 1,
  id: actor.id,
  kind: "actor",
  rootId,
  ownerHostId,
  ownerIdentityId,
  parentId,
  name: actor.name,
  status: actor.status,
  runner: actor.runner,
  transport: "host",
  capabilities: [
    ...(actor.status === "stopped" ? [] : (["steer", "followUp", "stop"] as const)),
    ...(actor.runner === "pi" && actor.extensions !== false ? (["fabric"] as const) : []),
  ],
  ...(actor.model ? { model: actor.model } : {}),
  ...(actor.thinking ? { thinking: actor.thinking } : {}),
  startedAt: actor.createdAt,
  updatedAt: actor.updatedAt,
  actorQueued: actor.queued,
  actorMessages: actor.messages,
  controlProtocol: "v1",
});

export class FabricState {
  #registry: ActionRegistry | undefined;
  #config: FabricConfig | undefined;
  #execution: FabricExecutionService | undefined;
  #subagents: SubagentManager | undefined;
  #actors: ActorManager | undefined;
  #globalActors: GlobalActorRegistry | undefined;
  #mesh: MeshStore | undefined;
  #identity: MeshIdentity | undefined;
  #mainAgent: MainAgentController | undefined;
  #participants: ParticipantDirectory | undefined;
  #control: FabricControlPlane | undefined;
  #lifecycle: LifecycleBroker | undefined;
  #agentsProvider: AgentsProvider | undefined;
  #compact: CompactController | undefined;
  #schema: SchemaController | undefined;
  #cwd: string | undefined;
  readonly #externalProviders = new Map<string, FabricProvider>();
  readonly activity = new FabricActivityStore();
  readonly prewalk = new PrewalkController();
  #widgetDismissedAt = 0;

  constructor(
    readonly pi: ExtensionAPI,
    readonly capturedTools: CapturedToolCatalog,
  ) {}

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

  get execution(): FabricExecutionService {
    if (!this.#execution) throw new Error("Pi Fabric has not initialized");
    return this.#execution;
  }

  get subagents(): SubagentManager {
    if (!this.#subagents) throw new Error("Pi Fabric has not initialized");
    return this.#subagents;
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

  async initialize(context: ExtensionContext): Promise<void> {
    await this.#closeInternal();
    this.prewalk.cancel();
    context.ui.setStatus("fabric-prewalk", undefined);
    this.activity.reset();
    this.#cwd = context.cwd;
    const projectTrusted = context.isProjectTrusted();
    this.#config = loadFabricConfig({
      cwd: context.cwd,
      agentDir: getAgentDir(),
      projectTrusted,
    });
    this.#registry = new ActionRegistry(
      new FabricToolResultProxy(() => this.capturedTools.runner),
    );
    const enforceSchema = this.#config.schema.mode === "enforce";
    const effectiveFullCodeMode = this.#config.fullCodeMode || enforceSchema;
    const capturedToolsProvider =
      effectiveFullCodeMode && this.#config.capture.enabled && !enforceSchema
        ? new CapturedToolsProvider(this.capturedTools)
        : undefined;
    if (effectiveFullCodeMode) {
      this.#registry.register(
        new PiToolsProvider(
          context.cwd,
          enforceSchema ? undefined : this.capturedTools,
          capturedToolsProvider,
        ),
      );
    }
    this.#registry.register(new McpProvider(context.cwd, this.#config.mcp));
    if (capturedToolsProvider) this.#registry.register(capturedToolsProvider);
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
      this.#registry.register(new MeshProvider(this.#mesh, identity, this.#participants));
      this.#registry.register(new StateProvider(this.#mesh, identity));
    }
    this.#schema = new SchemaController(
      context.cwd,
      this.#config.schema,
      this.#mesh,
      identity,
      new StateStore(this.#mesh),
    );
    this.#registry.register(new SchemaProvider(this.#schema));
    this.#identity = identity;
    this.#compact = new CompactController({
      onRequest: (intent) => void this.#publishCompactEvent("requested", intent),
      onCommit: (info) => void this.#publishCompactEvent(info.status, info),
    });
    this.#registry.register(new CompactProvider(this.#compact));
    const subagentConfig = enforceSchema
      ? { ...this.#config.subagents, enabled: false }
      : this.#config.subagents;
    this.#subagents = new SubagentManager(context.cwd, subagentConfig, {
      fullCodeMode: this.#config.fullCodeMode,
      mainAgentId,
      meshRoot,
      projectRoot,
      hostId,
      identityId: identity.id,
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
            customType: "pi-fabric-subagent-complete",
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
    this.#actors = new ActorManager(
      sessionId,
      identity,
      this.#mesh,
      enforceSchema ? { ...this.#config.mesh, enabled: false } : this.#config.mesh,
      this.#subagents,
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
            actorRoot:
              this.#config.mesh.actorScope === "session"
                ? path.join(meshRoot, "actors", sessionId)
                : path.join(meshRoot, "actors"),
            persistent: true,
            mainAgent,
            canManageActor,
          }
        : { persistent: false, mainAgent, canManageActor },
    );
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
    const firstSeenAgents = new Map<string, number>();
    if (mainAgent.local) {
      this.#participants.registerSource(() => [
        this.#participants!.root(mainAgent.info(context)),
      ]);
    }
    this.#participants.registerSource(() =>
      agentParticipantRecords(
        this.#subagents!.listForUi(),
        mainAgentId,
        hostId,
        identity.id,
        identity.id,
        firstSeenAgents,
      ),
    );
    this.#participants.registerSource(() =>
      this.#actors!.list().map((actor) =>
        actorParticipantRecord(actor, mainAgentId, hostId, identity.id, identity.id),
      ),
    );
    this.#subagents.subscribeUi(() => this.#participants?.scheduleRefresh());
    this.#actors.subscribe(() => this.#participants?.scheduleRefresh());
    this.#agentsProvider = new AgentsProvider(
      this.#subagents,
      this.#actors,
      this.#globalActors,
      mainAgent,
      this.#participants,
      this.#control,
      this.#lifecycle,
      () => this.#config?.ui.showNestedToolCalls ?? true,
    );
    this.#control.start((command, from) => this.#agentsProvider!.acceptControl(command, from));
    await this.#participants.start();
    this.#lifecycle.start();
    this.#registry.register(this.#agentsProvider);
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
      this.#registry.register(new MemoryProvider(memoryContext));
    }
    for (const provider of this.#externalProviders.values()) {
      this.#registry.register(provider);
    }
    this.#execution = new FabricExecutionService(
      this.#registry,
      this.#config,
      this.activity,
      this.#schema,
    );
    const discovery: FabricProviderDiscovery = {
      version: 1,
      register: (provider, options) => this.registerExternal(provider, options),
    };
    this.pi.events.emit(FABRIC_PROVIDER_DISCOVER_EVENT, discovery);
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
    deepAssign(this.#config as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
  }

  claimHandoff(
    execution: FabricExecutionResult,
    sessionId: string,
    resultFormat: FabricResultFormat,
  ): PendingFabricHandoff | undefined {
    return claimFabricHandoff(this.prewalk, execution, sessionId, resultFormat);
  }

  async runHandoffAtBoundary(
    pending: PendingFabricHandoff,
    outerToolResult: SubagentToolResultMessage,
    context: ExtensionContext,
  ): Promise<Record<string, unknown>> {
    if (!this.#agentsProvider) throw new Error("Pi Fabric has not initialized");
    return runFabricHandoffAtBoundary(
      this.prewalk,
      this.#agentsProvider,
      pending,
      outerToolResult,
      context,
    );
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
      [
        "pi",
        "mcp",
        "agents",
        "mesh",
        "extensions",
        "fabric",
        "schema",
        "state",
        "memory",
        "compact",
      ].includes(provider.name)
    ) {
      throw new Error(`Reserved Fabric provider name: ${provider.name}`);
    }
    if (this.#externalProviders.has(provider.name) && !options.overwrite) {
      throw new Error(`Fabric provider already registered: ${provider.name}`);
    }
    this.#externalProviders.set(provider.name, provider);
    if (this.#registry) this.#registry.register(provider, options);
  }

  async shutdown(): Promise<void> {
    await this.#participants?.quiesce().catch(() => undefined);
    await this.#lifecycle?.close();
    await this.#control?.close();
    try {
      await this.#registry?.close();
    } finally {
      await this.#participants?.close();
    }
    this.#registry = undefined;
    this.#config = undefined;
    this.#execution = undefined;
    this.#subagents = undefined;
    this.#actors = undefined;
    this.#globalActors = undefined;
    this.#mesh = undefined;
    this.#identity = undefined;
    this.#mainAgent = undefined;
    this.#participants = undefined;
    this.#control = undefined;
    this.#lifecycle = undefined;
    this.#agentsProvider = undefined;
    this.#compact = undefined;
    this.#schema = undefined;
    this.#cwd = undefined;
    this.activity.reset();
    this.#widgetDismissedAt = 0;
    this.#externalProviders.clear();
    this.prewalk.cancel();
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
    await this.#lifecycle?.close();
    await this.#control?.close();
    const externalNames = new Set(this.#externalProviders.keys());
    try {
      await this.#registry.close(externalNames);
    } finally {
      await this.#participants?.close();
    }
    this.#registry = undefined;
    this.#execution = undefined;
    this.#subagents = undefined;
    this.#actors = undefined;
    this.#mesh = undefined;
    this.#identity = undefined;
    this.#mainAgent = undefined;
    this.#participants = undefined;
    this.#control = undefined;
    this.#lifecycle = undefined;
    this.#agentsProvider = undefined;
    this.#compact = undefined;
    this.#schema = undefined;
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
