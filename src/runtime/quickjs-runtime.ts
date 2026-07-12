import releaseSyncVariant from "@jitl/quickjs-singlefile-mjs-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten-core";
import ts from "typescript";

export interface FabricSandboxResult {
  value: unknown;
  logs: string[];
  error?: string;
}

export interface FabricSandboxOptions {
  timeoutMs: number;
  memoryLimitBytes: number;
  maxLogChars?: number;
  strings?: Record<string, string>;
  signal?: AbortSignal;
}

export type FabricHostCall = (
  ref: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

type QuickJsModule = Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>>;

let quickJsModulePromise: Promise<QuickJsModule> | undefined;

const quickJsModule = (): Promise<QuickJsModule> => {
  quickJsModulePromise ??= newQuickJSWASMModuleFromVariant(releaseSyncVariant);
  return quickJsModulePromise;
};

const guestSetup = `
const __call = (ref, args) => globalThis.__fabricHostCall(ref, args ?? {});
globalThis.tools = Object.freeze({
  providers: () => __call("fabric.$providers", {}),
  list: (args = {}) => __call("fabric.$list", args),
  search: (args) => __call("fabric.$search", args),
  describe: (args) => __call("fabric.$describe", args),
  call: (args) => __call("fabric.$call", args),
  progress: (args) => __call("fabric.$progress", args),
});
globalThis.pi = new Proxy({}, {
  get(_target, property) {
    if (property === "then") return undefined;
    return (args = {}) => __call("pi." + String(property), args);
  },
});
globalThis.agents = Object.freeze({
  run: (args) => __call("agents.run", args),
  spawn: (args) => __call("agents.spawn", args),
  wait: (args) => __call("agents.wait", args),
  status: (args) => __call("agents.status", args),
  list: () => __call("agents.list", {}),
  stop: (args) => __call("agents.stop", args),
  cleanup: (args) => __call("agents.cleanup", args),
});
globalThis.mcp = new Proxy({}, {
  get(_target, server) {
    if (server === "then") return undefined;
    if (server === "servers") return () => __call("mcp.$servers", {});
    if (server === "reload") return () => __call("mcp.$reload", {});
    if (server === "register") return (args) => __call("mcp.$register", args);
    if (server === "call") return (args) => __call("mcp.$call", args);
    return new Proxy({}, {
      get(_serverTarget, tool) {
        if (tool === "then") return undefined;
        return (args = {}) => __call("mcp." + String(server) + "." + String(tool), args);
      },
    });
  },
});
globalThis.rlm = Object.freeze({
  query: (args) => agents.run({ ...args, recursive: true }),
});
globalThis.council = Object.freeze({
  async run(args) {
    const { task, roles, synthesize = true, ...agentOptions } = args;
    const results = await Promise.all(roles.map((role) => agents.run({
      ...agentOptions,
      name: role,
      task: "Act as the " + role + " council member. Independently analyze this task:\\n\\n" + task,
    })));
    if (!synthesize) return results;
    return agents.run({
      ...agentOptions,
      name: "council-synthesizer",
      task: "Synthesize the council's independent reports into one decision. Preserve disagreements and cite which role raised each concern.\\n\\nTask:\\n" + task + "\\n\\nReports:\\n" + JSON.stringify(results),
    });
  },
});
globalThis.console = Object.freeze({ log: print, info: print, warn: print, error: print });
`;

const transpile = (code: string): string =>
  ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;

const formatValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const jsonText = (value: unknown): string => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return "null";
  return serialized;
};

const jsonHandle = (context: any, value: unknown): any => {
  if (value === undefined) return context.undefined;
  const result = context.evalCode(`JSON.parse(${JSON.stringify(jsonText(value))})`);
  return context.unwrapResult(result);
};

const resolveQuickJsPromise = async (
  context: any,
  runtime: any,
  promiseHandle: any,
): Promise<any> => {
  const resolution = context.resolvePromise(promiseHandle);
  let settled = false;
  void resolution.finally(() => {
    settled = true;
  });
  while (!settled) {
    runtime.executePendingJobs();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return resolution;
};

export class QuickJsRuntime {
  async execute(
    code: string,
    hostCall: FabricHostCall,
    options: FabricSandboxOptions,
  ): Promise<FabricSandboxResult> {
    if (options.signal?.aborted) {
      return { value: undefined, logs: [], error: "Execution cancelled" };
    }
    const module = await quickJsModule();
    const context = module.newContext();
    const runtime = context.runtime;
    runtime.setMemoryLimit(options.memoryLimitBytes);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + options.timeoutMs));
    const logs: string[] = [];
    const maxLogChars = options.maxLogChars ?? 100_000;
    let logChars = 0;
    let logsTruncated = false;
    const pendingHostPromises = new Set<any>();
    const hostTasks = new Set<Promise<void>>();
    let closing = false;
    let cancelled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    let activePromiseHandle: any;
    let executionGate: any;
    let pendingResolution: Promise<any> | undefined;

    const rejectExecutionGate = (message: string): void => {
      if (!executionGate || executionGate.alive === false) return;
      const errorHandle = context.newError(message);
      executionGate.reject(errorHandle);
      errorHandle.dispose();
      runtime.executePendingJobs();
    };

    try {
      const hostFunction = context.newFunction(
        "__fabricHostCall",
        (referenceHandle: any, argsHandle: any) => {
          const reference = context.getString(referenceHandle);
          const dumpedArgs = context.dump(argsHandle);
          const args =
            typeof dumpedArgs === "object" && dumpedArgs !== null && !Array.isArray(dumpedArgs)
              ? (dumpedArgs as Record<string, unknown>)
              : {};
          const promise = context.newPromise();
          pendingHostPromises.add(promise);
          void promise.settled.then(() => pendingHostPromises.delete(promise));
          const task = hostCall(reference, args)
            .then((value) => {
              if (closing || promise.alive === false) return;
              const handle = jsonHandle(context, value);
              promise.resolve(handle);
              handle.dispose();
            })
            .catch((error) => {
              if (closing || promise.alive === false) return;
              const errorHandle = context.newError(
                error instanceof Error ? error.message : String(error),
              );
              promise.reject(errorHandle);
              errorHandle.dispose();
            })
            .finally(() => {
              if (!closing) runtime.executePendingJobs();
            });
          hostTasks.add(task);
          void task.finally(() => hostTasks.delete(task));
          return promise.handle;
        },
      );
      context.setProp(context.global, "__fabricHostCall", hostFunction);
      hostFunction.dispose();

      const printFunction = context.newFunction("print", (...handles: any[]) => {
        if (logsTruncated) return;
        const line = handles.map((handle) => formatValue(context.dump(handle))).join(" ");
        const remaining = maxLogChars - logChars;
        if (line.length > remaining) {
          if (remaining > 0) logs.push(line.slice(0, remaining));
          logs.push("[Pi Fabric log output truncated]");
          logsTruncated = true;
          return;
        }
        logs.push(line);
        logChars += line.length;
      });
      context.setProp(context.global, "print", printFunction);
      printFunction.dispose();

      const strings = jsonHandle(context, options.strings ?? {});
      context.setProp(context.global, "π", strings);
      strings.dispose();

      const setupResult = context.evalCode(guestSetup, "pi-fabric-setup.js");
      if (setupResult.error) {
        const error = formatValue(context.dump(setupResult.error));
        setupResult.error.dispose();
        return { value: undefined, logs, error };
      }
      setupResult.value.dispose();

      executionGate = context.newPromise();
      context.setProp(context.global, "__fabricExecutionGate", executionGate.handle);
      const wrappedCode = `Promise.race([(async function __piFabricMain() {\n${transpile(code)}\n})(), globalThis.__fabricExecutionGate])`;
      const evaluation = context.evalCode(wrappedCode, "pi-fabric-guest.js");
      runtime.executePendingJobs();
      if (evaluation.error) {
        const error = formatValue(context.dump(evaluation.error));
        evaluation.error.dispose();
        return { value: undefined, logs, error };
      }

      activePromiseHandle = evaluation.value;
      const cancellation = new Promise<never>((_resolve, reject) => {
        abortHandler = () => {
          cancelled = true;
          rejectExecutionGate("Execution cancelled");
          reject(new Error("Execution cancelled"));
        };
        options.signal?.addEventListener("abort", abortHandler, { once: true });
      });
      void cancellation.catch(() => undefined);
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          const message = `Execution timed out after ${options.timeoutMs}ms`;
          rejectExecutionGate(message);
          reject(new Error(message));
        }, options.timeoutMs);
      });
      pendingResolution = resolveQuickJsPromise(context, runtime, activePromiseHandle);
      const resolution = await Promise.race([pendingResolution, deadline, cancellation]);
      activePromiseHandle.dispose();
      activePromiseHandle = undefined;
      if (resolution.error) {
        const error = formatValue(context.dump(resolution.error));
        resolution.error.dispose();
        return { value: undefined, logs, error };
      }
      const value = context.dump(resolution.value);
      resolution.value.dispose();
      return { value, logs };
    } catch (error) {
      return {
        value: undefined,
        logs,
        error: cancelled
          ? "Execution cancelled"
          : error instanceof Error
            ? error.message
            : String(error),
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
      if (!timedOut && !cancelled && hostTasks.size > 0) {
        await Promise.allSettled(hostTasks);
        runtime.executePendingJobs();
      }
      closing = true;
      if (timedOut || cancelled) {
        rejectExecutionGate(
          cancelled ? "Execution cancelled" : `Execution timed out after ${options.timeoutMs}ms`,
        );
        const errorHandle = context.newError(
          cancelled ? "Execution cancelled" : `Execution timed out after ${options.timeoutMs}ms`,
        );
        for (const promise of pendingHostPromises) promise.reject(errorHandle);
        errorHandle.dispose();
        runtime.executePendingJobs();
        await new Promise((resolve) => setImmediate(resolve));
        const settled = await pendingResolution?.catch(() => undefined);
        if (settled?.error) settled.error.dispose();
        if (settled?.value) settled.value.dispose();
        for (const promise of pendingHostPromises) {
          if (promise.alive !== false) promise.dispose();
        }
      }
      if (activePromiseHandle?.alive !== false) activePromiseHandle?.dispose();
      if (executionGate?.alive !== false) executionGate?.dispose();
      runtime.executePendingJobs();
      context.dispose();
    }
  }
}
