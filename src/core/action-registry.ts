import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";

export interface ResolvedFabricAction extends FabricActionDescriptor {
  ref: string;
  provider: string;
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
}

export interface FabricRegistryInvocationContext extends FabricInvocationContext {
  approve(action: ResolvedFabricAction): Promise<void>;
  audits: FabricCallAudit[];
  maxResultChars: number;
}

const providerNamePattern = /^[a-z][a-z0-9_-]*$/;

const boundedResult = (
  value: unknown,
  maxChars: number,
): { value: unknown; chars: number; truncated: boolean } => {
  let serialized: string;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined && value !== undefined) {
      throw new Error(`unsupported result type: ${typeof value}`);
    }
    serialized = encoded ?? "null";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Fabric action returned a non-JSON-serializable value: ${message}`);
  }
  if (serialized.length <= maxChars) {
    return { value, chars: serialized.length, truncated: false };
  }
  const previewChars = Math.max(1, maxChars - 200);
  return {
    value: {
      fabricTruncated: true,
      originalChars: serialized.length,
      preview: serialized.slice(0, previewChars),
    },
    chars: serialized.length,
    truncated: true,
  };
};

const resolveDescriptor = (
  provider: FabricProvider,
  descriptor: FabricActionDescriptor,
): ResolvedFabricAction => ({
  ...descriptor,
  provider: provider.name,
  ref: `${provider.name}.${descriptor.name}`,
});

const validationMessage = (
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
): string | undefined => {
  try {
    if (Value.Check(schema, value)) return undefined;
    return [...Value.Errors(schema, value)]
      .slice(0, 5)
      .map((error) => error.message)
      .join("; ");
  } catch {
    return undefined;
  }
};

export class ActionRegistry {
  readonly #providers = new Map<string, FabricProvider>();

  register(provider: FabricProvider, options: { overwrite?: boolean } = {}): void {
    if (!providerNamePattern.test(provider.name)) {
      throw new Error(`Invalid Fabric provider name: ${provider.name}`);
    }
    if (this.#providers.has(provider.name) && !options.overwrite) {
      throw new Error(`Fabric provider already registered: ${provider.name}`);
    }
    this.#providers.set(provider.name, provider);
  }

  has(name: string): boolean {
    return this.#providers.has(name);
  }

  unregister(name: string): FabricProvider | undefined {
    const provider = this.#providers.get(name);
    this.#providers.delete(name);
    return provider;
  }

  providers(): Array<{ name: string; description: string }> {
    return [...this.#providers.values()]
      .map((provider) => ({ name: provider.name, description: provider.description }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async list(
    request: FabricProviderListRequest & { provider?: string },
    context: FabricInvocationContext,
  ): Promise<ResolvedFabricAction[]> {
    const providers = request.provider
      ? [this.#requireProvider(request.provider)]
      : [...this.#providers.values()];
    const lists = await Promise.all(
      providers.map(async (provider) => {
        const descriptors = await provider.list(request, context);
        return descriptors.map((descriptor) => resolveDescriptor(provider, descriptor));
      }),
    );
    const limit = Math.max(1, Math.min(request.limit ?? 100, 1_000));
    return lists.flat().slice(0, limit);
  }

  async search(
    query: string,
    context: FabricInvocationContext,
    limit = 30,
  ): Promise<ResolvedFabricAction[]> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return [];
    const listed = await this.list({ query: normalizedQuery, limit: 1_000 }, context);
    return listed
      .map((action) => {
        const haystack = [
          action.ref,
          action.description,
          action.namespace ?? "",
          JSON.stringify(action.inputSchema),
        ]
          .join(" ")
          .toLowerCase();
        const exactName = action.ref.toLowerCase() === normalizedQuery ? 100 : 0;
        const startsName = action.ref.toLowerCase().startsWith(normalizedQuery) ? 30 : 0;
        const includesName = action.ref.toLowerCase().includes(normalizedQuery) ? 10 : 0;
        const includesBody = haystack.includes(normalizedQuery) ? 1 : 0;
        return { action, score: exactName + startsName + includesName + includesBody };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.action.ref.localeCompare(right.action.ref))
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map((entry) => entry.action);
  }

  async describe(ref: string, context: FabricInvocationContext): Promise<ResolvedFabricAction> {
    const { provider, actionName } = this.#parseRef(ref);
    const descriptor = await provider.describe(actionName, context);
    if (!descriptor) throw new Error(`Unknown Fabric action: ${ref}`);
    return resolveDescriptor(provider, descriptor);
  }

  async invoke(
    ref: string,
    args: Record<string, unknown>,
    context: FabricRegistryInvocationContext,
  ): Promise<unknown> {
    const { provider, actionName } = this.#parseRef(ref);
    const descriptor = await provider.describe(actionName, context);
    if (!descriptor) throw new Error(`Unknown Fabric action: ${ref}`);
    const action = resolveDescriptor(provider, descriptor);
    const invalid = validationMessage(action.inputSchema, args);
    if (invalid) throw new Error(`Invalid arguments for ${ref}: ${invalid}`);
    await context.approve(action);

    const nestedToolCallId = `fabric_${randomUUID()}`;
    const audit: FabricCallAudit = {
      ref,
      nestedToolCallId,
      startedAt: Date.now(),
    };
    context.audits.push(audit);
    context.update(`Calling ${ref}`);
    try {
      const value = await provider.invoke(actionName, args, {
        ...context,
        nestedToolCallId,
      });
      const bounded = boundedResult(value, context.maxResultChars);
      audit.success = true;
      audit.resultChars = bounded.chars;
      audit.resultTruncated = bounded.truncated;
      return bounded.value;
    } catch (error) {
      audit.success = false;
      audit.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      audit.endedAt = Date.now();
    }
  }

  async close(excludedProviderNames: Set<string> = new Set()): Promise<void> {
    await Promise.allSettled(
      [...this.#providers.values()]
        .filter((provider) => !excludedProviderNames.has(provider.name))
        .map((provider) => provider.close?.()),
    );
    this.#providers.clear();
  }

  #parseRef(ref: string): { provider: FabricProvider; actionName: string } {
    const separator = ref.indexOf(".");
    if (separator <= 0 || separator === ref.length - 1) {
      throw new Error(`Fabric action references must use provider.action: ${ref}`);
    }
    const providerName = ref.slice(0, separator);
    return {
      provider: this.#requireProvider(providerName),
      actionName: ref.slice(separator + 1),
    };
  }

  #requireProvider(name: string): FabricProvider {
    const provider = this.#providers.get(name);
    if (!provider) throw new Error(`Unknown Fabric provider: ${name}`);
    return provider;
  }
}
