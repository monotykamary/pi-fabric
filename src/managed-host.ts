import { DEFAULT_FABRIC_CONFIG, type FabricConfig } from "./config.js";
import { createProviderComponent, type FabricProviderComponent } from "./components/provider-component.js";
import type { FabricProvider } from "./protocol.js";

const REPLACEABLE = new Set(["agents", "memory", "compact", "schema", "state", "mesh", "mcp"]);
export interface FabricManagedHostOptions {
  /** Host code only; never read from project/global configuration or the provider event payload. */
  providers: readonly string[];
}

/** Closed-world provider authority for embedded hosts. Native providers cannot return on reload. */
export class FabricManagedHost {
  readonly #allowed: Set<string>;
  readonly #providers = new Map<string, FabricProvider>();
  readonly #retired = new Set<FabricProvider>();
  #sealed = false;
  constructor(options: FabricManagedHostOptions) {
    this.#allowed = new Set(options.providers);
    for (const name of this.#allowed) if (!REPLACEABLE.has(name)) throw new Error(`Managed host cannot replace provider: ${name}`);
  }
  register(provider: FabricProvider, overwrite = false): void {
    if (!this.#allowed.has(provider.name)) throw new Error(`Managed host provider not authorized: ${provider.name}`);
    const previous = this.#providers.get(provider.name);
    if (previous === provider) return;
    if (this.#sealed) throw new Error("Managed provider authority is sealed; create a new host to replace it");
    if (previous && !overwrite) throw new Error(`Fabric provider already registered: ${provider.name}`);
    if (previous) this.#retired.add(previous);
    this.#providers.set(provider.name, provider);
  }
  seal(): void {
    for (const name of this.#allowed) if (!this.#providers.has(name)) throw new Error(`Managed host provider missing: ${name}`);
    this.#sealed = true;
  }
  has(name: string): boolean { return this.#allowed.has(name); }
  /** Only sealed, live host providers delegate effect approval to the host broker. */
  ownsProvider(name: string): boolean { return this.#sealed && this.#providers.has(name); }
  provider(name: string): FabricProvider {
    const source = this.#providers.get(name);
    if (!source) return {name, description: "Unavailable in managed host", list: async () => [], describe: async () => undefined, invoke: async () => {throw new Error(`Managed host provider unavailable: ${name}`);}};
    // Components own publication, while the host owns the supplied object's lifetime. Reload does
    // not close then reuse it; final host shutdown awaits close exactly once after withdrawal.
    return {name, description: source.description, list: source.list.bind(source), describe: source.describe.bind(source), invoke: source.invoke.bind(source),
      ...(source.prepareArguments ? {prepareArguments: source.prepareArguments.bind(source)} : {}),
      ...(source.acquire ? {acquire: source.acquire.bind(source)} : {}),
      ...(source.invocationEnded ? {invocationEnded: source.invocationEnded.bind(source)} : {}),
      ...(source.subscribeCatalog ? {subscribeCatalog: source.subscribeCatalog.bind(source)} : {}),
    };
  }
  component(component: FabricProviderComponent): FabricProviderComponent {
    const name = component.definition.provides?.[0];
    if (typeof name !== "string" || name === "pi" || name === "extensions") return component;
    return createProviderComponent({provider: name, description: "Managed host provider", create: () => this.provider(name)});
  }
  config(): FabricConfig {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = true;
    config.executor.kernel = "typescript";
    config.executor.runtime = "quickjs";
    config.mcp.enabled = false;
    config.mcp.allowDynamicServers = false;
    config.mesh.enabled = false;
    config.agents.enabled = false;
    config.agents.sessionExport = false;
    config.prewalk.enabled = false;
    config.memory.enabled = false;
    config.repairs.enabled = false;
    config.entropy.compile = false;
    config.speculation.enabled = false;
    config.ui.enabled = false;
    config.schema.mode = "off";
    config.schema.trustedCommands = {};
    config.components = [];
    config.compaction.engine = "fabric";
    config.approvals = {...config.approvals, read: "allow", write: "allow", execute: "allow", agent: "allow", network: "deny"};
    return config;
  }
  async close(): Promise<void> {
    const providers = new Set([...this.#providers.values(), ...this.#retired]);
    this.#providers.clear(); this.#retired.clear();
    await Promise.all([...providers].map((provider) => provider.close?.()));
  }
}
