import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { FabricActivityStore } from "./activity/store.js";
import { ActorManager } from "./actors/manager.js";
import { GlobalActorRegistry } from "./actors/global-registry.js";
import { buildActorContext } from "./actors/context.js";
import { actorDeliveryNotice } from "./actors/delivery-policy.js";
import type { FabricActorHostEvent } from "./actors/types.js";
import { CapturedToolCatalog } from "./capture/catalog.js";
import { loadFabricConfig, type FabricConfig } from "./config.js";
import { ActionRegistry } from "./core/action-registry.js";
import { CompactController, type CompactLastCommit, type CompactPendingIntent } from "./core/compact-controller.js";
import { FabricExecutionService } from "./execution-service.js";
import { MeshStore, type MeshIdentity } from "./mesh/store.js";
import { PeerSessionRegistry, type FabricPeerInfo } from "./peer-session.js";
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
const ACTOR_DELIVERY_MAX_CHARS = 8_000;

const escapeXmlText = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

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
  #peers: PeerSessionRegistry | undefined;
  #agentsProvider: AgentsProvider | undefined;
  #compact: CompactController | undefined;
  #schema: SchemaController | undefined;
  #cwd: string | undefined;
  readonly #externalProviders = new Map<string, FabricProvider>();
  readonly activity = new FabricActivityStore();
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
    return this.#peers?.list() ?? [];
  }

  async queueUserMessage(
    targetId: string,
    message: string,
    delivery: FabricAgentMessageDelivery,
  ): Promise<FabricAgentMessageResult> {
    if (!this.#mainAgent || !this.#agentsProvider) {
      throw new Error("Pi Fabric has not initialized");
    }
    if (this.#mainAgent.matches(targetId)) {
      return this.#mainAgent.deliverUser(message, delivery);
    }
    return this.#agentsProvider.routeMessage(targetId, message, undefined, delivery);
  }

  get compact(): CompactController {
    if (!this.#compact) throw new Error("Pi Fabric has not initialized");
    return this.#compact;
  }

  async initialize(context: ExtensionContext): Promise<void> {
    await this.#closeInternal();
    this.activity.reset();
    this.#cwd = context.cwd;
    const projectTrusted = context.isProjectTrusted();
    this.#config = loadFabricConfig({
      cwd: context.cwd,
      agentDir: getAgentDir(),
      projectTrusted,
    });
    this.#registry = new ActionRegistry();
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
    const configuredMeshRoot = this.#config.mesh.root;
    const meshRoot =
      process.env.PI_FABRIC_MESH_ROOT ??
      (configuredMeshRoot
        ? path.resolve(context.cwd, configuredMeshRoot)
        : path.join(context.cwd, ".pi", "fabric", "mesh"));
    this.#mesh = new MeshStore(
      meshRoot,
      this.#config.mesh.maxEventBytes,
      this.#config.mesh.maxReadEvents,
    );
    this.#peers = new PeerSessionRegistry(
      this.#mesh,
      identity,
      mainAgent,
      context,
      this.#config.mesh.enabled,
    );
    await this.#peers.start();
    if (this.#config.mesh.enabled) {
      this.#registry.register(new MeshProvider(this.#mesh, identity));
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
    this.#actors = new ActorManager(
      sessionId,
      identity,
      this.#mesh,
      enforceSchema ? { ...this.#config.mesh, enabled: false } : this.#config.mesh,
      this.#subagents,
      ({ actor, message, delivery, triggerTurn }) => {
        const actorText = message.text ?? "";
        if (!actorText) return;
        const text =
          actorText.length > ACTOR_DELIVERY_MAX_CHARS
            ? `${actorText.slice(0, ACTOR_DELIVERY_MAX_CHARS)}\n[actor delivery truncated]`
            : actorText;
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
          }
        : { persistent: false, mainAgent },
    );
    this.#globalActors = new GlobalActorRegistry(getAgentDir(), this.#config.mesh.maxEventBytes);
    this.#agentsProvider = new AgentsProvider(
      this.#subagents,
      this.#actors,
      this.#globalActors,
      mainAgent,
      () => this.#config?.ui.showNestedToolCalls ?? true,
      this.#peers,
    );
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
    const maxChars = this.#config.mesh.eventContextChars;
    const bounded = (value: unknown): unknown => {
      let json: string;
      try {
        const serialized = JSON.stringify(value, (_key, nested) => {
          if (typeof nested === "bigint") return String(nested);
          if (typeof nested === "function") return undefined;
          if (
            typeof nested === "object" &&
            nested !== null &&
            "type" in nested &&
            (nested as { type?: unknown }).type === "image"
          ) {
            return { type: "image", redacted: true };
          }
          return nested;
        });
        if (serialized === undefined) return null;
        json = serialized;
      } catch {
        return String(value);
      }
      if (json.length > maxChars) json = json.slice(json.length - maxChars);
      try {
        return JSON.parse(json) as unknown;
      } catch {
        return json;
      }
    };
    const branch = context.sessionManager.getBranch();
    const { digest, transcript } = buildActorContext(
      branch as unknown[],
      this.#config.mesh.actorContextEntries,
      this.#config.mesh.eventContextChars,
    );
    return this.#actors.dispatchHostEvent(event, {
      event,
      session: { id: context.sessionManager.getSessionId(), cwd: context.cwd },
      digest,
      transcript,
      signal: { payload: bounded(payload), idle: context.isIdle(), observedAt: Date.now() },
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
    await this.#peers?.close();
    await this.#registry?.close();
    this.#registry = undefined;
    this.#config = undefined;
    this.#execution = undefined;
    this.#subagents = undefined;
    this.#actors = undefined;
    this.#globalActors = undefined;
    this.#mesh = undefined;
    this.#identity = undefined;
    this.#mainAgent = undefined;
    this.#peers = undefined;
    this.#agentsProvider = undefined;
    this.#compact = undefined;
    this.#schema = undefined;
    this.#cwd = undefined;
    this.activity.reset();
    this.#widgetDismissedAt = 0;
    this.#externalProviders.clear();
  }

  // Publish a best-effort mesh event to the durable `fabric.compact` topic so
  // other Fabric participants (actors, peers) observe compaction transitions.
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
    await this.#peers?.close();
    const externalNames = new Set(this.#externalProviders.keys());
    await this.#registry.close(externalNames);
    this.#registry = undefined;
    this.#execution = undefined;
    this.#subagents = undefined;
    this.#actors = undefined;
    this.#mesh = undefined;
    this.#identity = undefined;
    this.#mainAgent = undefined;
    this.#peers = undefined;
    this.#agentsProvider = undefined;
    this.#compact = undefined;
    this.#schema = undefined;
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const deepAssign = (
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void => {
  for (const [key, value] of Object.entries(source)) {
    const targetValue = target[key];
    if (isPlainObject(value) && isPlainObject(targetValue)) {
      deepAssign(targetValue, value);
    } else {
      target[key] = value;
    }
  }
};
