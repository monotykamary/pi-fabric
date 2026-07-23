import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  FabricExecutionTraceRecorder,
  executionOutcomeFromError,
  type FabricExecutionFailureStageV1,
  type FabricExecutionTraceOperationHandle,
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
import {
  ApprovalController,
  FabricSessionApprovals,
} from "./core/approval-controller.js";
import {
  codeUsesOrchestration,
  isBlockingOrchestrationRef,
} from "./runtime/orchestration.js";
import type {
  QuickJsRuntime,
  FabricSandboxResult,
  FabricSandboxTerminationReason,
} from "./runtime/quickjs-runtime.js";
import type { NodeProcessRuntime } from "./runtime/node-process-runtime.js";
import type { FabricTypeError } from "./runtime/type-checker.js";

let runtimeDependencies:
  | Promise<{
      QuickJsRuntime: typeof import("./runtime/quickjs-runtime.js").QuickJsRuntime;
      NodeProcessRuntime: typeof import("./runtime/node-process-runtime.js").NodeProcessRuntime;
      typeCheckFabricCode: typeof import("./runtime/type-checker.js").typeCheckFabricCode;
      guestTypeDeclarations: typeof import("./runtime/guest-types.js").guestTypeDeclarations;
    }>
  | undefined;

const loadRuntimeDependencies = () =>
  runtimeDependencies ??= Promise.all([
    import("./runtime/quickjs-runtime.js"),
    import("./runtime/node-process-runtime.js"),
    import("./runtime/type-checker.js"),
    import("./runtime/guest-types.js"),
  ]).then(([quickjs, nodeProcess, checker, guest]) => ({
    QuickJsRuntime: quickjs.QuickJsRuntime,
    NodeProcessRuntime: nodeProcess.NodeProcessRuntime,
    typeCheckFabricCode: checker.typeCheckFabricCode,
    guestTypeDeclarations: guest.guestTypeDeclarations,
  }));

const executionOutcomeFromTermination = (
  reason: FabricSandboxTerminationReason,
): "succeeded" | "failed" | "aborted" | "timed_out" => {
  switch (reason) {
    case "completed":
      return "succeeded";
    case "aborted":
      return "aborted";
    case "timed_out":
      return "timed_out";
    case "runtime_error":
      return "failed";
  }
};

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
  handoffRequest?: Record<string, unknown>;
}

interface FabricExecutionPartial {
  audits: FabricCallAudit[];
  phases: string[];
  progress?: string | undefined;
}

export interface FabricExecutionAuthorizer {
  authorize(ref: string, parentToolCallId: string): Promise<void>;
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
  #runtime: QuickJsRuntime | NodeProcessRuntime | undefined;
  #runtimeKind: FabricConfig["executor"]["runtime"] | undefined;
  readonly #sessionApprovals = new FabricSessionApprovals();

  constructor(
    readonly registry: ActionRegistry,
    readonly config: FabricConfig,
    readonly activity?: FabricActivityStore,
    readonly authorizer?: FabricExecutionAuthorizer,
  ) {}

  async execute(options: FabricExecutionOptions): Promise<FabricExecutionResult> {
    const startedAt = performance.now();
    const traceRecorder = new FabricExecutionTraceRecorder();
    this.activity?.start(options.parentToolCallId, options.display);
    const dependencies = await loadRuntimeDependencies();
    const effectiveFullCodeMode =
      this.config.fullCodeMode || this.config.schema.mode === "enforce";
    const checked = dependencies.typeCheckFabricCode(
      options.code,
      dependencies.guestTypeDeclarations(effectiveFullCodeMode),
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

    const approval = new ApprovalController(
      this.config.approvals,
      options.context,
      this.#sessionApprovals,
    );
    const audits: FabricCallAudit[] = [];
    const phases: string[] = [];
    const workflowSpans = new Map<
      string,
      { kind: "parallel" | "pipeline"; operation: FabricExecutionTraceOperationHandle }
    >();
    let agentCalls = 0;
    let handoffRequest: Record<string, unknown> | undefined;
    const maxAgentCalls = Math.max(
      1,
      Math.min(
        options.maxAgentCalls ?? this.config.subagents.maxPerExecution,
        this.config.subagents.maxPerExecution,
      ),
    );
    const guardAgentCall = (ref: string): void => {
      if (
        ref !== "agents.run" &&
        ref !== "agents.handoff" &&
        ref !== "agents.spawn" &&
        ref !== "agents.create"
      ) return;
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
      if (effectiveFullCodeMode) return;
      const provider = fullCodeProvider(ref);
      if (!provider) return;
      throw new Error(
        `Fabric full code mode is disabled; call ${provider === "pi" ? "Pi core" : "registered extension"} tools directly outside fabric_exec`,
      );
    };
    let currentProgress: string | undefined;
    let emitPending = false;
    let emitTimer: NodeJS.Timeout | undefined;
    const emitNow = (): void => {
      emitPending = false;
      options.onPartial({
        audits: audits.slice(),
        phases: phases.slice(),
        progress: currentProgress,
      });
    };
    const flushEmit = (): void => {
      if (emitTimer) clearTimeout(emitTimer);
      emitTimer = undefined;
      if (emitPending) emitNow();
    };
    // One execution-wide timer coalesces updates from every parallel nested
    // call. Keeping this global to the Fabric program prevents each call from
    // independently churning rows while preserving a trailing final snapshot.
    const emit = (): void => {
      emitPending = true;
      const debounceMs = this.config.ui.nestedToolDebounceMs;
      if (debounceMs <= 0) {
        flushEmit();
        return;
      }
      if (emitTimer) clearTimeout(emitTimer);
      emitTimer = setTimeout(() => {
        emitTimer = undefined;
        if (emitPending) emitNow();
      }, debounceMs);
      emitTimer.unref?.();
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
    const traceAttempt = async <T>(
      ref: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
      run: (setStage: (stage: FabricExecutionFailureStageV1) => void) => T | Promise<T>,
    ): Promise<T> => {
      const operation = traceRecorder.issueCall(ref, args);
      let stage: FabricExecutionFailureStageV1 = "invoke";
      try {
        const value = await run((nextStage) => {
          stage = nextStage;
        });
        operation.succeed(undefined);
        return value;
      } catch (error) {
        operation.fail(stage, error, executionOutcomeFromError(error, signal));
        throw error;
      }
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
          executionOutcomeFromError(error, callContext.signal),
        );
        throw error;
      }
      return this.registry.invoke(ref, args, {
        ...callContext,
        ...(ref === "agents.handoff"
          ? {
              deferHandoff(request: Record<string, unknown>) {
                if (handoffRequest) {
                  throw new Error(
                    "Only one agents.handoff request is allowed per fabric_exec invocation",
                  );
                }
                handoffRequest = structuredClone(request);
                return {
                  scheduled: true,
                  status: "deferred",
                  boundary: "fabric_exec_end",
                };
              },
            }
          : {}),
        ...(this.authorizer
          ? {
              authorize: (action) =>
                this.authorizer!.authorize(action.ref, options.parentToolCallId),
            }
          : {}),
        approve: async (action) => {
          if (action.ref === "schema.commit") {
            await approval.approve({ ...action, risk: "write" });
            await approval.approve({ ...action, risk: "execute" });
            return;
          }
          await approval.approve(action);
        },
        audits,
        maxResultChars: this.config.executor.maxNestedResultChars,
        traceOperation,
        observeInvocation,
      });
    };
    let sandboxResult: FabricSandboxResult;
    try {
      const runtimeKind = this.config.executor.runtime;
      if (!this.#runtime || this.#runtimeKind !== runtimeKind) {
        this.#runtime = runtimeKind === "node-process"
          ? new dependencies.NodeProcessRuntime()
          : new dependencies.QuickJsRuntime();
        this.#runtimeKind = runtimeKind;
      }
      sandboxResult = await this.#runtime.execute(
        options.code,
        async (ref, args, runtimeSignal) => {
          const callContext = { ...baseContext, signal: runtimeSignal };
          switch (ref) {
            case "fabric.$providers":
              return traceAttempt(
                "fabric.discovery.providers",
                args,
                runtimeSignal,
                () =>
                  this.registry
                    .providers()
                    .filter(
                      (provider) => effectiveFullCodeMode || !fullCodeProvider(provider.name),
                    ),
              );
            case "fabric.$catalog":
              return traceAttempt(
                "fabric.discovery.catalog",
                args,
                runtimeSignal,
                async (setStage) => {
                  const provider = typeof args.provider === "string" ? args.provider : undefined;
                  setStage("guard");
                  if (provider) guardFullCodeRef(`${provider}.*`);
                  setStage(provider && !this.registry.has(provider) ? "resolve" : "invoke");
                  return this.registry.catalog(callContext, {
                    ...(provider ? { provider } : {}),
                    ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
                    includeProvider: (name) => effectiveFullCodeMode || !fullCodeProvider(name),
                  });
                },
              );
            case "fabric.$catalog":
              return traceAttempt(
                "fabric.discovery.catalog",
                args,
                runtimeSignal,
                async (setStage) => {
                  const provider = typeof args.provider === "string" ? args.provider : undefined;
                  setStage("guard");
                  if (provider) guardFullCodeRef(`${provider}.*`);
                  setStage(provider && !this.registry.has(provider) ? "resolve" : "invoke");
                  return this.registry.catalog(callContext, {
                    ...(provider ? { provider } : {}),
                    ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
                    includeProvider: (name) => effectiveFullCodeMode || !fullCodeProvider(name),
                  });
                },
              );
            case "fabric.$models": {
              const operation = traceRecorder.issueCall("fabric.discovery.models", args);
              const registry = options.context.modelRegistry;
              try {
                const available =
                  typeof registry?.getAvailable === "function" ? registry.getAvailable() : [];
                const models = available.map((model) => ({
                  provider: String(model.provider),
                  id: String(model.id),
                  name: String(model.name ?? model.id),
                  key: `${model.provider}/${model.id}`,
                }));
                operation.succeed(undefined);
                return models;
              } catch (error) {
                operation.fail(
                  "invoke",
                  error,
                  executionOutcomeFromError(error, runtimeSignal),
                );
                return [];
              }
            }
            case "fabric.$list":
              return traceAttempt(
                "fabric.discovery.list",
                args,
                runtimeSignal,
                async (setStage) => {
                  setStage("guard");
                  if (typeof args.provider === "string") {
                    guardFullCodeRef(`${args.provider}.*`);
                  }
                  setStage(
                    typeof args.provider === "string" && !this.registry.has(args.provider)
                      ? "resolve"
                      : "invoke",
                  );
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
                    (action) => effectiveFullCodeMode || !fullCodeProvider(action.provider),
                  );
                },
              );
            case "fabric.$search":
              return traceAttempt(
                "fabric.discovery.search",
                args,
                runtimeSignal,
                async () => {
                  const actions = await this.registry.search(
                    String(args.query ?? ""),
                    callContext,
                    typeof args.limit === "number" ? args.limit : undefined,
                  );
                  return actions.filter(
                    (action) => effectiveFullCodeMode || !fullCodeProvider(action.provider),
                  );
                },
              );
            case "fabric.$describe":
              return traceAttempt(
                "fabric.discovery.describe",
                args,
                runtimeSignal,
                async (setStage) => {
                  const targetRef = String(args.ref ?? "");
                  setStage("guard");
                  guardFullCodeRef(targetRef);
                  setStage("resolve");
                  return this.registry.describe(targetRef, callContext);
                },
              );
            case "fabric.$call": {
              const callArgs =
                typeof args.args === "object" && args.args !== null && !Array.isArray(args.args)
                  ? (args.args as Record<string, unknown>)
                  : {};
              const targetRef = String(args.ref ?? "");
              return invokeAction(targetRef, callArgs, callContext);
            }
            case "fabric.$progress":
              return traceAttempt(
                "fabric.workflow.progress",
                args,
                runtimeSignal,
                () => update(String(args.message ?? "Working")),
              );
            case "fabric.$configure":
              return traceAttempt(
                "fabric.workflow.configure",
                args,
                runtimeSignal,
                () => {
                  const display: FabricRunDisplay = {
                    ...(typeof args.name === "string" ? { name: args.name } : {}),
                    ...(typeof args.description === "string" ? { description: args.description } : {}),
                  };
                  return this.activity?.configure(options.parentToolCallId, display) ?? display;
                },
              );
            case "fabric.$phase":
              return traceAttempt(
                "fabric.workflow.phase",
                args,
                runtimeSignal,
                (setStage) => {
                  setStage("validate");
                  const name =
                    typeof args.name === "string" ? args.name.trim() : "";
                  if (!name) throw new Error("Workflow phase name must be a non-empty string");
                  phases.push(name);
                  const phaseIndex = phases.length - 1;
                  const phaseInput: FabricPhaseInput = {
                    name,
                    ...(typeof args.id === "string" ? { id: args.id } : {}),
                    ...(typeof args.description === "string" ? { description: args.description } : {}),
                    ...(typeof args.total === "number" ? { total: args.total } : {}),
                  };
                  setStage("invoke");
                  const activityPhase = this.activity?.phase(options.parentToolCallId, phaseInput);
                  update(`Phase: ${name}`);
                  return {
                    name,
                    index: phaseIndex,
                    ...(activityPhase ? { id: activityPhase.id } : {}),
                  };
                },
              );
            case "fabric.$item":
              return traceAttempt(
                "fabric.workflow.item",
                args,
                runtimeSignal,
                () => {
                  const item = args as unknown as FabricActivityItemInput;
                  return this.activity?.upsertItem(options.parentToolCallId, item) ?? item;
                },
              );
            case "fabric.$event":
              return traceAttempt(
                "fabric.workflow.event",
                args,
                runtimeSignal,
                () => {
                  const event = args as unknown as FabricActivityEventInput;
                  this.activity?.event(options.parentToolCallId, event);
                },
              );
            case "fabric.$spanStart": {
              const id = typeof args.id === "string" ? args.id : "";
              const kind = args.kind;
              if (!id || (kind !== "parallel" && kind !== "pipeline")) {
                throw new Error("Invalid internal workflow span start");
              }
              if (workflowSpans.has(id)) throw new Error("Duplicate internal workflow span");
              const operation = traceRecorder.issueCall(`fabric.workflow.${kind}`, args);
              workflowSpans.set(id, { kind, operation });
              return undefined;
            }
            case "fabric.$spanEnd": {
              const id = typeof args.id === "string" ? args.id : "";
              const span = workflowSpans.get(id);
              if (!span) throw new Error("Unknown internal workflow span");
              workflowSpans.delete(id);
              if (args.outcome === "succeeded") span.operation.succeed(undefined);
              else {
                span.operation.fail(
                  "invoke",
                  undefined,
                  executionOutcomeFromError(new Error("Workflow span failed"), runtimeSignal),
                );
              }
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
          ...(checked.javascript ? { transpiledCode: checked.javascript } : {}),
          ...(options.strings ? { strings: options.strings } : {}),
          ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.activity?.finish(options.parentToolCallId, false, message);
      throw error;
    } finally {
      await this.registry.endInvocation(options.parentToolCallId);
      flushEmit();
    }

    const runOutcome = executionOutcomeFromTermination(sandboxResult.terminationReason);
    const succeeded = runOutcome === "succeeded";
    this.activity?.finish(options.parentToolCallId, succeeded, sandboxResult.error);
    return {
      success: succeeded,
      value: sandboxResult.value,
      logs: sandboxResult.logs,
      audits,
      phases,
      trace: traceRecorder.seal(runOutcome, phases, sandboxResult.error),
      elapsedMs: performance.now() - startedAt,
      ...(sandboxResult.error ? { error: sandboxResult.error } : {}),
      ...(handoffRequest ? { handoffRequest } : {}),
    };
  }
}
