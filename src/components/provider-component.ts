import type { ActionRegistry } from "../core/action-registry.js";
import type { FabricProvider } from "../protocol.js";
import type { FabricComponentCatalog } from "./catalog.js";
import type { FabricComponentLoader } from "./loader.js";
import type {
  FabricComponentContext,
  FabricComponentDefinition,
  FabricComponentEntry,
} from "./types.js";

export const FABRIC_PROVIDER_COMPONENT_PREFIX = "fabric.provider.";

export const FABRIC_COMPONENT_PROVIDER_NAMES = [
  "pi",
  "extensions",
  "mcp",
  "mesh",
  "state",
  "schema",
  "compact",
  "cache",
  "prewalk",
  "agents",
  "memory",
  "jev",
] as const;

export interface FabricProviderComponentSpec<TProvider extends FabricProvider> {
  provider: string;
  description: string;
  requires?: FabricComponentDefinition["requires"];
  create(context: FabricComponentContext): TProvider | Promise<TProvider>;
  mounted?(provider: TProvider): void;
  unmounted?(provider: TProvider): void;
  start?(provider: TProvider): void | Promise<void>;
}

export interface FabricProviderComponent {
  entry: FabricComponentEntry;
  definition: FabricComponentDefinition;
}

export class FabricProviderComponentManifest {
  readonly #entries: FabricComponentEntry[] = [];

  constructor(
    readonly catalog: FabricComponentCatalog,
    readonly loader: FabricComponentLoader,
  ) {}

  entries(): FabricComponentEntry[] {
    return this.#entries.map((entry) => structuredClone(entry));
  }

  async install(component: FabricProviderComponent): Promise<void> {
    const definitionName = component.definition.name;
    const provider = definitionName.startsWith(FABRIC_PROVIDER_COMPONENT_PREFIX)
      ? definitionName.slice(FABRIC_PROVIDER_COMPONENT_PREFIX.length)
      : undefined;
    if (
      !provider ||
      component.entry.id !== definitionName ||
      component.entry.component !== definitionName ||
      component.definition.provides?.length !== 1 ||
      component.definition.provides[0] !== provider
    ) {
      throw new Error(`Invalid Fabric provider component manifest entry: ${definitionName}`);
    }
    if (this.#entries.some((entry) => entry.id === component.entry.id)) {
      throw new Error(`Duplicate Fabric provider component: ${component.entry.id}`);
    }
    const previousDefinition = this.catalog.get(component.definition.name)?.definition;
    this.catalog.register(component.definition, {
      overwrite: previousDefinition !== undefined,
    });
    this.#entries.push(structuredClone(component.entry));
    try {
      await this.loader.installPinned(this.#entries);
    } catch (error) {
      this.#entries.pop();
      if (previousDefinition) {
        this.catalog.register(previousDefinition, { overwrite: true });
      } else {
        this.catalog.unregister(component.definition.name);
      }
      throw error;
    }
  }

  assertActive(expectedProviders: Iterable<string>, registry: ActionRegistry): void {
    const expected = new Set(expectedProviders);
    const installed = new Set(
      this.#entries.map((entry) =>
        entry.component.slice(FABRIC_PROVIDER_COMPONENT_PREFIX.length)
      ),
    );
    const missing = [...expected].filter((name) =>
      !installed.has(name) || !registry.has(name)
    );
    const unexpected = [...installed].filter((name) => !expected.has(name));
    if (missing.length > 0 || unexpected.length > 0) {
      throw new Error(
        `Fabric provider component manifest mismatch. Missing: ${missing.join(",") || "none"}. Unexpected: ${unexpected.join(",") || "none"}.`,
      );
    }
  }
}

const providerComponentName = (provider: string): string =>
  `${FABRIC_PROVIDER_COMPONENT_PREFIX}${provider}`;

export const createProviderComponent = <TProvider extends FabricProvider>(
  spec: FabricProviderComponentSpec<TProvider>,
): FabricProviderComponent => {
  const name = providerComponentName(spec.provider);
  const definition: FabricComponentDefinition = {
    name,
    description: spec.description,
    ...(spec.requires ? { requires: spec.requires } : {}),
    provides: [spec.provider],
    guarantee: "managed",
    async activate(context) {
      const provider = await spec.create(context);
      if (provider.name !== spec.provider) {
        await provider.close?.();
        throw new Error(
          `Fabric provider component ${name} created ${provider.name}, expected ${spec.provider}`,
        );
      }
      try {
        context.provide(provider);
      } catch (error) {
        await provider.close?.();
        throw error;
      }
      if (spec.mounted) {
        try {
          spec.mounted(provider);
        } catch (error) {
          spec.unmounted?.(provider);
          throw error;
        }
        context.defer(
          () => spec.unmounted?.(provider),
          {
            label: `provider-component:${spec.provider}:holder`,
            kind: "transactional",
            resources: [`fabric:provider:${spec.provider}:holder`],
            ordering: "ordered",
          },
        );
      }
      await spec.start?.(provider);
    },
  };
  return {
    entry: { id: name, component: name },
    definition,
  };
};
