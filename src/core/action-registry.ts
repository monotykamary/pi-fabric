import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import {
  executionOutcomeFromError,
  type FabricExecutionTraceOperationHandle,
  type FabricExecutionTraceRecorder,
} from "../audit/trace.js";
import type {
  FabricActionDescriptor,
  FabricInvocationActivityUpdate,
  FabricInvocationContext,
  FabricMediaBlock,
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
  tool?: string;
  provider?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  media?: FabricMediaBlock[];
  mediaNote?: string;
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
      type: "call_end";
      callId: string;
      success: boolean;
      result?: unknown;
      error?: string;
    };

export interface FabricRegistryInvocationContext extends FabricInvocationContext {
  authorize?(action: ResolvedFabricAction): Promise<void>;
  approve(action: ResolvedFabricAction): Promise<void>;
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
export const NESTED_TOOL_CALL_ID_PREFIX = "fabric_";

const providerNamePattern = /^[a-z][a-z0-9_-]*$/;

const PREVIEW_ARG_CHARS = 2_000;
const PREVIEW_ARG_KEYS = 32;
const PREVIEW_RESULT_CHARS = 16_000;
const MAX_VALIDATION_MESSAGE_CHARS = 2_000;

const truncateString = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}…`;

const previewArgs = (args: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(args)) {
    if (count++ >= PREVIEW_ARG_KEYS) break;
    out[key] = typeof value === "string" ? truncateString(value, PREVIEW_ARG_CHARS) : value;
  }
  return out;
};

const previewResult = (value: unknown): unknown => {
  if (typeof value === "string") return truncateString(value, PREVIEW_RESULT_CHARS);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = typeof val === "string" ? truncateString(val, PREVIEW_RESULT_CHARS) : val;
    }
    return out;
  }
  return value;
};

const failedResultError = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (status !== "failed" && status !== "stopped" && status !== "timed_out") return undefined;
  const error = typeof record.error === "string" ? record.error.trim() : "";
  return error ? truncateString(error, PREVIEW_RESULT_CHARS) : `Fabric action returned ${status}`;
};

const failedResultOutcome = (value: unknown): "failed" | "aborted" | "timed_out" => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "failed";
  const status = (value as Record<string, unknown>).status;
  return status === "timed_out" ? "timed_out" : status === "stopped" ? "aborted" : "failed";
};

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
    const message = [...Value.Errors(schema, value)]
      .slice(0, 5)
      .map((error) => error.message)
      .join("; ");
    return truncateString(message || "Schema validation failed", MAX_VALIDATION_MESSAGE_CHARS);
  } catch {
    return "Schema validator failed";
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
      .sort(
        (left, right) =>
          right.score - left.score || left.action.ref.localeCompare(right.action.ref),
      )
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
    const traceOperation = context.traceOperation ?? context.trace?.issueCall(ref, args);
    let failureStage: "resolve" | "guard" | "prepare" | "validate" | "approve" | "invoke" = "resolve";
    let audit: FabricCallAudit | undefined;
    try {
      const { provider, actionName } = this.#parseRef(ref);
      const descriptor = await provider.describe(actionName, context);
      if (!descriptor) throw new Error(`Unknown Fabric action: ${ref}`);
      const action = resolveDescriptor(provider, descriptor);
      traceOperation?.resolved(action.provider, action.name);

      failureStage = "guard";
      await context.authorize?.(action);

      failureStage = "prepare";
      const preparedArgs = provider.prepareArguments
        ? await provider.prepareArguments(actionName, args, context)
        : args;
      if (typeof preparedArgs !== "object" || preparedArgs === null || Array.isArray(preparedArgs)) {
        throw new Error(`Argument preparation for ${ref} did not return an object`);
      }
      traceOperation?.prepared(preparedArgs);

      failureStage = "validate";
      const invalid = validationMessage(action.inputSchema, preparedArgs);
      if (invalid) throw new Error(`Invalid arguments for ${ref}: ${invalid}`);

      failureStage = "approve";
      await context.approve(action);

      failureStage = "invoke";
      const nestedToolCallId = `${NESTED_TOOL_CALL_ID_PREFIX}${randomUUID()}`;
      const activeAudit: FabricCallAudit = {
        ref,
        nestedToolCallId,
        startedAt: Date.now(),
        tool: action.name,
        provider: action.provider,
        args: previewArgs(preparedArgs),
      };
      audit = activeAudit;
      context.audits.push(activeAudit);
      context.observeInvocation?.({
        type: "call_start",
        callId: nestedToolCallId,
        ref,
        args: preparedArgs,
      });
      context.update(`Calling ${ref}`);
      const value = await provider.invoke(actionName, preparedArgs, {
        ...context,
        nestedToolCallId,
        update(message) {
          context.update(message);
          context.observeInvocation?.({
            type: "call_update",
            callId: nestedToolCallId,
            update: { type: "progress", message },
          });
        },
        activity(update) {
          context.activity?.(update);
          context.observeInvocation?.({
            type: "call_update",
            callId: nestedToolCallId,
            update,
          });
        },
        attachMedia(blocks, note) {
          if (!activeAudit.media) activeAudit.media = [];
          for (const block of blocks) activeAudit.media.push(block);
          if (note) activeAudit.mediaNote = note;
        },
      });
      const bounded = boundedResult(value, context.maxResultChars);
      const resultError = failedResultError(value);
      activeAudit.success = resultError === undefined;
      if (resultError) activeAudit.error = resultError;
      activeAudit.resultChars = bounded.chars;
      activeAudit.resultTruncated = bounded.truncated;
      activeAudit.result = previewResult(bounded.value);
      context.observeInvocation?.({
        type: "call_end",
        callId: nestedToolCallId,
        success: resultError === undefined,
        result: value,
        ...(resultError ? { error: resultError } : {}),
      });
      if (resultError) {
        traceOperation?.fail("invoke", resultError, failedResultOutcome(value), bounded.value);
      } else {
        traceOperation?.succeed(bounded.value);
      }
      return bounded.value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      traceOperation?.fail(failureStage, error, executionOutcomeFromError(error, context.signal));
      if (audit) {
        audit.success = false;
        audit.error = message;
        context.observeInvocation?.({
          type: "call_end",
          callId: audit.nestedToolCallId,
          success: false,
          error: audit.error,
        });
      }
      throw error;
    } finally {
      if (audit) audit.endedAt = Date.now();
    }
  }

  async endInvocation(parentToolCallId: string): Promise<void> {
    await Promise.allSettled(
      [...this.#providers.values()].map((provider) =>
        provider.invocationEnded?.(parentToolCallId),
      ),
    );
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
