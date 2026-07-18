import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  FabricExecutionTraceRecorder,
  executionOutcomeFromError,
  type FabricExecutionTraceV1,
} from "./audit/trace.js";
import { FabricActivityStore } from "./activity/store.js";
import type {
  FabricActivityEventInput,
  FabricActivityItemInput,
  FabricPhaseInput,
  FabricRunDisplay,
} from "./activity/types.js";
import {
  MAX_SUBAGENT_TIMEOUT_MS,
  MIN_SUBAGENT_TIMEOUT_MS,
  type FabricConfig,
} from "./config.js";
import {
  ActionRegistry,
  type FabricCallAudit,
  type FabricRegistryActivityEvent,
} from "./core/action-registry.js";
import { ApprovalController } from "./core/approval-controller.js";
import { guestTypeDeclarations } from "./runtime/guest-types.js";
import {
  codeUsesOrchestration,
  isBlockingOrchestrationRef,
} from "./runtime/orchestration.js";
import { QuickJsRuntime, type FabricSandboxResult } from "./runtime/quickjs-runtime.js";
import { typeCheckFabricCode, type FabricTypeError } from "./runtime/type-checker.js";

export interface FabricExecutionResult {
  success: boolean;
  value: unknown;
  logs: string[];
  audits: FabricCallAudit[];
  phases: string[];
  trace: FabricExecutionTraceV1;
  elapsedMs: number;
  typeErrors?: FabricTypeError[];
  error?: string;
}

interface FabricExecutionPartial {
  audits: FabricCallAudit[];
  phases: string[];
  progress?: string | undefined;
}

export interface FabricExecutionOptions {
  code: string;
  strings?: Record<string, string>;
  signal: AbortSignal | undefined;
  parentToolCallId: string;
  context: ExtensionContext;
  tokenBudget?: number;
  maxAgentCalls?: number;
  display?: FabricRunDisplay;
  onPartial(snapshot: FabricExecutionPartial): void;
}

export class FabricExecutionService {
  readonly #runtime = new QuickJsRuntime();

  constructor(
    readonly registry: ActionRegistry,
    readonly config: FabricConfig,
    readonly activity?: FabricActivityStore,
  ) {}

  async execute(options: FabricExecutionOptions): Promise<FabricExecutionResult> {
    const startedAt = performance.now();
    const traceRecorder = new FabricExecutionTraceRecorder();
    this.activity?.start(options.parentToolCallId, options.display);
    const checked = typeCheckFabricCode(
      options.code,
      guestTypeDeclarations(this.config.fullCodeMode),
    );
    if (checked.errors.length > 0) {
      this.activity?.finish(options.parentToolCallId, false, "Type checking failed");
      return {
        success: false,
        value: undefined,
        logs: [],
        audits: [],
        phases: [],
        trace: traceRecorder.seal("failed", [], "Type checking failed"),
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
    const fullCodeProvider = (value: string): "pi" | "extensions" | undefined => {
      const separator = value.indexOf(".");
      const provider = separator > 0 ? value.slice(0, separator) : value;
      return provider === "pi" || provider === "extensions" ? provider : undefined;
    };
    const guardFullCodeRef = (ref: string): void => {
      if (this.config.fullCodeMode) return;
      const provider = fullCodeProvider(ref);
      if (!provider) return;
      throw new Error(
        `Fabric full code mode is disabled; call ${provider === "pi" ? "Pi core" : "registered extension"} tools directly outside fabric_exec`,
      );
    };
    let currentProgress: string | undefined;
    const emit = (): void => {
      options.onPartial({
        audits: audits.slice(),
        phases: phases.slice(),
        progress: currentProgress,
      });
    };
    const update = (message: string): void => {
      currentProgress = message;
      emit();
    };
    const observeInvocation = (event: FabricRegistryActivityEvent): void => {
      if (this.activity) {
        if (event.type === "call_start") {
          this.activity.beginCall(options.parentToolCallId, event);
        } else if (event.type === "call_update") {
          this.activity.updateCall(options.parentToolCallId, event.callId, event.update);
        } else {
          this.activity.finishCall(options.parentToolCallId, event.callId, event);
        }
      }
      if (event.type === "call_end") emit();
    };
    const baseContext = {
      cwd: options.context.cwd,
      signal: options.signal,
      parentToolCallId: options.parentToolCallId,
      nestedToolCallId: `${options.parentToolCallId}_metadata`,
      extensionContext: options.context,
      update,
    };
    // Start known orchestration programs with the longer deadline. Calls
    // reached through generic or computed refs are classified again at the
    // host bridge and can extend the active sandbox deadline before they run.
    const orchestrationTimeoutMs = Math.max(
      this.config.executor.timeoutMs,
      this.config.subagents.timeoutMs,
    );
    const effectiveTimeoutMs = codeUsesOrchestration(options.code)
      ? orchestrationTimeoutMs
      : this.config.executor.timeoutMs;
    const minimumTimeoutMsForHostCall = (
      ref: string,
      args: Record<string, unknown>,
    ): number | undefined => {
      const targetRef =
        ref === "fabric.$call" && typeof args.ref === "string" ? args.ref : ref;
      if (!isBlockingOrchestrationRef(targetRef)) return undefined;
      const targetArgs =
        ref === "fabric.$call" &&
        typeof args.args === "object" &&
        args.args !== null &&
        !Array.isArray(args.args)
          ? (args.args as Record<string, unknown>)
          : args;
      const requestedTimeoutMs =
        targetRef === "agents.run" &&
        typeof targetArgs.timeoutMs === "number" &&
        Number.isFinite(targetArgs.timeoutMs)
          ? Math.max(
              MIN_SUBAGENT_TIMEOUT_MS,
              Math.min(Math.floor(targetArgs.timeoutMs), MAX_SUBAGENT_TIMEOUT_MS),
            )
          : 0;
      return Math.max(orchestrationTimeoutMs, requestedTimeoutMs);
    };
    const invokeAction = async (
      ref: string,
      args: Record<string, unknown>,
      callContext: typeof baseContext & { signal: AbortSignal },
    ): Promise<unknown> => {
      const traceOperation = traceRecorder.issueCall(ref, args);
      try {
        guardFullCodeRef(ref);
        guardAgentCall(ref);
      } catch (error) {
        traceOperation.fail(
          "guard",
          error,
          executionOutcomeFromError(String(error), callContext.signal),
        );
        throw error;
      }
      return this.registry.invoke(ref, args, {
        ...callContext,
        approve: (action) => approval.approve(action),
        audits,
        maxResultChars: this.config.executor.maxNestedResultChars,
        traceOperation,
        observeInvocation,
      });
    };
    let sandboxResult: FabricSandboxResult;
    try {
      sandboxResult = await this.#runtime.execute(
        options.code,
        async (ref, args, runtimeSignal) => {
          const callContext = { ...baseContext, signal: runtimeSignal };
          switch (ref) {
            case "fabric.$providers":
              return this.registry
                .providers()
                .filter(
                  (provider) => this.config.fullCodeMode || !fullCodeProvider(provider.name),
                );
            case "fabric.$models": {
              const registry = options.context.modelRegistry;
              let models: Array<{ provider: string; id: string; name: string; key: string }> = [];
              try {
                const available =
                  typeof registry?.getAvailable === "function" ? registry.getAvailable() : [];
                models = available.map((model) => ({
                  provider: String(model.provider),
                  id: String(model.id),
                  name: String(model.name ?? model.id),
                  key: `${model.provider}/${model.id}`,
                }));
              } catch {
                models = [];
              }
              return models;
            }
            case "fabric.$list": {
              if (typeof args.provider === "string") guardFullCodeRef(`${args.provider}.*`);
              const actions = await this.registry.list(
                {
                  ...(typeof args.provider === "string" ? { provider: args.provider } : {}),
                  ...(typeof args.namespace === "string" ? { namespace: args.namespace } : {}),
                  ...(typeof args.query === "string" ? { query: args.query } : {}),
                  ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
                },
                callContext,
              );
              return actions.filter(
                (action) => this.config.fullCodeMode || !fullCodeProvider(action.provider),
              );
            }
            case "fabric.$search": {
              const actions = await this.registry.search(
                String(args.query ?? ""),
                callContext,
                typeof args.limit === "number" ? args.limit : undefined,
              );
              return actions.filter(
                (action) => this.config.fullCodeMode || !fullCodeProvider(action.provider),
              );
            }
            case "fabric.$describe": {
              const targetRef = String(args.ref ?? "");
              guardFullCodeRef(targetRef);
              return this.registry.describe(targetRef, callContext);
            }
            case "fabric.$call": {
              const callArgs =
                typeof args.args === "object" && args.args !== null && !Array.isArray(args.args)
                  ? (args.args as Record<string, unknown>)
                  : {};
              const targetRef = String(args.ref ?? "");
              return invokeAction(targetRef, callArgs, callContext);
            }
            case "fabric.$progress":
              update(String(args.message ?? "Working"));
              return undefined;
            case "fabric.$configure": {
              const display: FabricRunDisplay = {
                ...(typeof args.name === "string" ? { name: args.name } : {}),
                ...(typeof args.description === "string" ? { description: args.description } : {}),
              };
              return this.activity?.configure(options.parentToolCallId, display) ?? display;
            }
            case "fabric.$phase": {
              const name = String(args.name ?? "").trim();
              if (!name) throw new Error("Workflow phase name must not be empty");
              if (!phases.includes(name)) phases.push(name);
              const phaseInput: FabricPhaseInput = {
                name,
                ...(typeof args.id === "string" ? { id: args.id } : {}),
                ...(typeof args.description === "string" ? { description: args.description } : {}),
                ...(typeof args.total === "number" ? { total: args.total } : {}),
              };
              const activityPhase = this.activity?.phase(options.parentToolCallId, phaseInput);
              update(`Phase: ${name}`);
              return {
                name,
                index: phases.indexOf(name),
                ...(activityPhase ? { id: activityPhase.id } : {}),
              };
            }
            case "fabric.$item": {
              const item = args as unknown as FabricActivityItemInput;
              return this.activity?.upsertItem(options.parentToolCallId, item) ?? item;
            }
            case "fabric.$event": {
              const event = args as unknown as FabricActivityEventInput;
              this.activity?.event(options.parentToolCallId, event);
              return undefined;
            }
            default:
              return invokeAction(ref, args, callContext);
          }
        },
        {
          timeoutMs: effectiveTimeoutMs,
          memoryLimitBytes: this.config.executor.memoryLimitBytes,
          maxLogChars: this.config.executor.maxOutputChars,
          minimumTimeoutMsForHostCall,
          ...(options.strings ? { strings: options.strings } : {}),
          ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.activity?.finish(options.parentToolCallId, false, message);
      throw error;
    }

    this.activity?.finish(options.parentToolCallId, !sandboxResult.error, sandboxResult.error);
    const runOutcome = executionOutcomeFromError(sandboxResult.error, options.signal);
    return {
      success: !sandboxResult.error,
      value: sandboxResult.value,
      logs: sandboxResult.logs,
      audits,
      phases,
      trace: traceRecorder.seal(runOutcome, phases, sandboxResult.error),
      elapsedMs: performance.now() - startedAt,
      ...(sandboxResult.error ? { error: sandboxResult.error } : {}),
    };
  }
}
