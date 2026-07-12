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
  phases: string[];
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
  tokenBudget?: number;
  maxAgentCalls?: number;
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
        phases: [],
        elapsedMs: performance.now() - startedAt,
        typeErrors: checked.errors,
      };
    }

    const approval = new ApprovalController(this.config.approvals, options.context);
    const audits: FabricCallAudit[] = [];
    const phases: string[] = [];
    let agentCalls = 0;
    const maxAgentCalls = Math.max(
      1,
      Math.min(
        options.maxAgentCalls ?? this.config.subagents.maxPerExecution,
        this.config.subagents.maxPerExecution,
      ),
    );
    const guardAgentCall = (ref: string): void => {
      if (ref !== "agents.run" && ref !== "agents.spawn" && ref !== "agents.create") return;
      agentCalls++;
      if (agentCalls > maxAgentCalls) {
        throw new Error(`Fabric agent budget exhausted (${maxAgentCalls} per execution)`);
      }
    };
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
      async (ref, args, runtimeSignal) => {
        const callContext = { ...baseContext, signal: runtimeSignal };
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
              callContext,
            );
          case "fabric.$search":
            return this.registry.search(
              String(args.query ?? ""),
              callContext,
              typeof args.limit === "number" ? args.limit : undefined,
            );
          case "fabric.$describe":
            return this.registry.describe(String(args.ref ?? ""), callContext);
          case "fabric.$call": {
            const callArgs =
              typeof args.args === "object" && args.args !== null && !Array.isArray(args.args)
                ? (args.args as Record<string, unknown>)
                : {};
            const targetRef = String(args.ref ?? "");
            guardAgentCall(targetRef);
            return this.registry.invoke(targetRef, callArgs, {
              ...callContext,
              approve: (action) => approval.approve(action),
              audits,
              maxResultChars: this.config.executor.maxNestedResultChars,
            });
          }
          case "fabric.$progress":
            options.update(String(args.message ?? "Working"));
            return undefined;
          case "fabric.$phase": {
            const name = String(args.name ?? "").trim();
            if (!name) throw new Error("Workflow phase name must not be empty");
            if (!phases.includes(name)) phases.push(name);
            options.update(`Phase: ${name}`);
            return { name, index: phases.indexOf(name) };
          }
          default:
            guardAgentCall(ref);
            return this.registry.invoke(ref, args, {
              ...callContext,
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
        ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );

    return {
      success: !sandboxResult.error,
      value: sandboxResult.value,
      logs: sandboxResult.logs,
      audits,
      phases,
      elapsedMs: performance.now() - startedAt,
      ...(sandboxResult.error ? { error: sandboxResult.error } : {}),
    };
  }
}
