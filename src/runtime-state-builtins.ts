import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import type { CapturedToolCatalog } from "./capture/catalog.js";
import { createProviderComponent, type FabricProviderComponent, type FabricProviderComponentManifest } from "./components/provider-component.js";
import type { FabricConfig } from "./config.js";
import type { ActionRegistry } from "./core/action-registry.js";
import { resolveAgentDir } from "./core/agent-dir.js";
import type { MeshStore, MeshIdentity } from "./mesh/store.js";
import type { ParticipantDirectory } from "./topology/participant-directory.js";
import { CapturedToolsProvider } from "./providers/captured-tools-provider.js";
import { McpDescriptorCacheStore } from "./providers/mcp-descriptor-cache.js";
import { McpProvider } from "./providers/mcp-provider.js";
import { MemoryProvider, type MemoryProviderContext } from "./providers/memory-provider.js";
import { MeshProvider } from "./providers/mesh-provider.js";
import { PiToolsProvider } from "./providers/pi-tools-provider.js";
import { StateProvider } from "./providers/state-provider.js";

import type { FabricManagedHost } from "./managed-host.js";

/** Built-in provider recipes and policy; the runtime chooses installation order. */
export class RuntimeStateBuiltins {
  constructor(
    private readonly manifest: FabricProviderComponentManifest,
    private readonly registry: ActionRegistry,
    private readonly onInstalled: (name: string) => void,
    private readonly managedHost?: FabricManagedHost,
  ) {}

  async install(component: FabricProviderComponent): Promise<void> {
    await this.manifest.install(this.managedHost?.component(component) ?? component);
    this.onInstalled(component.definition.name);
  }

  async tools(cwd: string, config: FabricConfig, capturedTools: CapturedToolCatalog): Promise<void> {
    let mcpProvider: McpProvider | undefined;
    const enforceSchema = config.schema.mode === "enforce";
    const effectiveFullCodeMode = config.fullCodeMode || enforceSchema;
    // Enforce keeps this provider private to the Pi adapter: core overrides
    // still resolve through pi.* while the schema authorizer blocks protected
    // mutations and external effects. Do not expose the generic extensions.*
    // namespace in enforce mode.
    const capturedToolsProvider =
      effectiveFullCodeMode && (config.capture.enabled || enforceSchema)
        ? new CapturedToolsProvider(capturedTools)
        : undefined;
    if (effectiveFullCodeMode) {
      await this.install(createProviderComponent({
        provider: "pi",
        description: "Pi core tools adapter",
        create: () => new PiToolsProvider(
          cwd,
          capturedTools,
          capturedToolsProvider,
          this.managedHost ? {requireCapturedOverrides: true, powerShellToolDefinitionFactory: undefined} : undefined,
        ),
      }));
    }
    await this.install(createProviderComponent({
      provider: "mcp",
      description: "MCP runtime and descriptor cache",
      create: () => new McpProvider(cwd, config.mcp, {
        ...(config.mcp.cache.enabled
          ? {
              cache: new McpDescriptorCacheStore(
                path.join(
                  process.env.PI_FABRIC_PROJECT_ROOT ?? cwd,
                  ".pi",
                  "fabric",
                  "mcp-cache.json",
                ),
              ),
            }
          : {}),
        hooks: {
          onSliceChanged: () => {
            this.registry.notifyCatalogChanged("mcp");
          },
        },
      }),
      mounted: (provider) => { mcpProvider = provider; },
      unmounted: (provider) => {
        if (mcpProvider === provider) mcpProvider = undefined;
      },
      start: (provider) => { provider.warmup(); },
    }));
    if (capturedToolsProvider && !enforceSchema) {
      await this.install(createProviderComponent({
        provider: "extensions",
        description: "Captured extension tool catalog",
        create: () => capturedToolsProvider,
      }));
    }
  }

  async mesh(config: FabricConfig, mesh: MeshStore, identity: MeshIdentity, participants: ParticipantDirectory): Promise<void> {
    if (this.managedHost) {
      for (const provider of ["mesh", "state"]) {
        if (this.managedHost.has(provider)) await this.install(createProviderComponent({provider, description: "Managed scoped provider", create: () => this.managedHost!.provider(provider)}));
        else this.registry.markUnavailable(provider, "unavailable in managed host");
      }
    } else if (config.mesh.enabled) {
      await this.install(createProviderComponent({
        provider: "mesh",
        description: "Project mesh and participant directory",
        create: () => new MeshProvider(mesh, identity, participants),
      }));
      await this.install(createProviderComponent({
        provider: "state",
        description: "Labeled world state over the project mesh",
        requires: ["mesh.get"],
        create: () => new StateProvider(mesh, identity),
      }));
    } else {
      const meshDisabled =
        'disabled by configuration (mesh.enabled=false); set "mesh": { "enabled": true } in .pi/fabric.json or the agent fabric.json';
      this.registry.markUnavailable("mesh", `${meshDisabled} to enable mesh.* actions`);
      this.registry.markUnavailable("state", `${meshDisabled}; state.* actions run on the mesh`);
    }
  }

  async memory(context: ExtensionContext, config: FabricConfig, sessionId: string): Promise<void> {
    if (this.managedHost?.has("memory")) {
      await this.install(createProviderComponent({provider: "memory", description: "Managed current-session recall", create: () => this.managedHost!.provider("memory")}));
    } else if (config.memory.enabled) {
      const sessionFile = context.sessionManager.getSessionFile();
      const memoryContext: MemoryProviderContext = {
        agentDir: resolveAgentDir(),
        cwd: context.cwd,
        config: config.memory,
        sessionId,
        ...(sessionFile ? { sessionFile } : {}),
        getLiveBranch: () => ({
          entries: context.sessionManager.getBranch(),
          leafId: context.sessionManager.getLeafId(),
        }),
      };
      await this.install(createProviderComponent({
        provider: "memory",
        description: "Session memory index and source hydration",
        create: () => new MemoryProvider(memoryContext),
      }));
    } else {
      this.registry.markUnavailable(
        "memory",
        'disabled by configuration (memory.enabled=false); set "memory": { "enabled": true } in .pi/fabric.json or the agent fabric.json to enable memory.* actions',
      );
    }
  }

  assertActive(config: FabricConfig): void {
    const expectedBuiltinProviders = new Set<string>([
      ...(config.fullCodeMode || config.schema.mode === "enforce" ? ["pi"] : []),
      ...(config.fullCodeMode && config.capture.enabled && config.schema.mode !== "enforce" ? ["extensions"] : []),
      "mcp",
      ...(config.mesh.enabled ? ["mesh", "state"] : ["mesh", "state"].filter((name) => this.managedHost?.has(name))),
      "schema",
      "compact",
      "agents",
      ...(config.memory.enabled || this.managedHost?.has("memory") ? ["memory"] : []),
    ]);
    this.manifest.assertActive(expectedBuiltinProviders, this.registry);
  }
}
