import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FabricConfig } from "./config.js";
import { ActionRegistry, type FabricCallAudit } from "./core/action-registry.js";
import { ApprovalController } from "./core/approval-controller.js";
import { GUEST_TYPE_DECLARATIONS } from "./runtime/guest-types.js";
import { QuickJsRuntime } from "./runtime/quickjs-runtime.js";
import { typeCheckFabricCode, type FabricTypeError } from "./runtime/type-checker.js";

export interface FabricExecutionResult {
  success: boolean;
  value: unknown;
  logs: string[];
  audits: FabricCallAudit[];
  elapsedMs: number;
  typeErrors?: FabricTypeError[];
  error?: string;
}

export interface FabricExecutionOptions {
  code: string;
  strings?: Record<string, string>;
  signal: AbortSignal | undefined;
  parentToolCallId: string;
  context: ExtensionContext;
  update(message: string): void;
}

export class FabricExecutionService {
  readonly #runtime = new QuickJsRuntime();

  constructor(
    readonly registry: ActionRegistry,
    readonly config: FabricConfig,
  ) {}

  async execute(options: FabricExecutionOptions): Promise<FabricExecutionResult> {
    const startedAt = performance.now();
    const checked = typeCheckFabricCode(options.code, GUEST_TYPE_DECLARATIONS);
    if (checked.errors.length > 0) {
      return {
        success: false,
        value: undefined,
        logs: [],
        audits: [],
        elapsedMs: performance.now() - startedAt,
        typeErrors: checked.errors,
      };
    }

    const approval = new ApprovalController(this.config.approvals, options.context);
    const audits: FabricCallAudit[] = [];
    const baseContext = {
      cwd: options.context.cwd,
      signal: options.signal,
      parentToolCallId: options.parentToolCallId,
      nestedToolCallId: `${options.parentToolCallId}_metadata`,
      extensionContext: options.context,
      update: options.update,
    };
    const sandboxResult = await this.#runtime.execute(
      options.code,
      async (ref, args) => {
        switch (ref) {
          case "fabric.$providers":
            return this.registry.providers();
          case "fabric.$list":
            return this.registry.list(
              {
                ...(typeof args.provider === "string" ? { provider: args.provider } : {}),
                ...(typeof args.namespace === "string" ? { namespace: args.namespace } : {}),
                ...(typeof args.query === "string" ? { query: args.query } : {}),
                ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
              },
              baseContext,
            );
          case "fabric.$search":
            return this.registry.search(
              String(args.query ?? ""),
              baseContext,
              typeof args.limit === "number" ? args.limit : undefined,
            );
          case "fabric.$describe":
            return this.registry.describe(String(args.ref ?? ""), baseContext);
          case "fabric.$call": {
            const callArgs =
              typeof args.args === "object" && args.args !== null && !Array.isArray(args.args)
                ? (args.args as Record<string, unknown>)
                : {};
            return this.registry.invoke(String(args.ref ?? ""), callArgs, {
              ...baseContext,
              approve: (action) => approval.approve(action),
              audits,
              maxResultChars: this.config.executor.maxNestedResultChars,
            });
          }
          case "fabric.$progress":
            options.update(String(args.message ?? "Working"));
            return undefined;
          default:
            return this.registry.invoke(ref, args, {
              ...baseContext,
              approve: (action) => approval.approve(action),
              audits,
              maxResultChars: this.config.executor.maxNestedResultChars,
            });
        }
      },
      {
        timeoutMs: this.config.executor.timeoutMs,
        memoryLimitBytes: this.config.executor.memoryLimitBytes,
        maxLogChars: this.config.executor.maxOutputChars,
        ...(options.strings ? { strings: options.strings } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );

    return {
      success: !sandboxResult.error,
      value: sandboxResult.value,
      logs: sandboxResult.logs,
      audits,
      elapsedMs: performance.now() - startedAt,
      ...(sandboxResult.error ? { error: sandboxResult.error } : {}),
    };
  }
}
