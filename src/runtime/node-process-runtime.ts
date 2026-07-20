import { spawn, type ChildProcess } from "node:child_process";
import {
  GUEST_SETUP,
  type FabricHostCall,
  type FabricSandboxOptions,
  type FabricSandboxResult,
} from "./quickjs-runtime.js";
import { NODE_PROCESS_CHILD_SOURCE } from "./node-process-child-source.js";
import { transpileFabricCode } from "./type-checker.js";

interface ChildCallMessage {
  type: "call";
  id: number;
  ref: string;
  args: Record<string, unknown>;
}

interface ChildResultMessage {
  type: "result";
  result: FabricSandboxResult;
}

type ChildMessage = ChildCallMessage | ChildResultMessage;

const send = (child: ChildProcess, message: any): void => {
  if (!child.connected) return;
  child.send(message, () => undefined);
};

export class NodeProcessRuntime {
  async execute(
    code: string,
    hostCall: FabricHostCall,
    options: FabricSandboxOptions,
  ): Promise<FabricSandboxResult> {
    if (options.signal?.aborted) {
      return {
        value: undefined,
        logs: [],
        terminationReason: "aborted",
        error: "Execution cancelled",
      };
    }
    if (!Number.isSafeInteger(options.memoryLimitBytes) || options.memoryLimitBytes < 1) {
      return {
        value: undefined,
        logs: [],
        terminationReason: "runtime_error",
        error: "Node process memory limit must be a positive safe integer",
      };
    }

    const heapLimitMb = Math.max(16, Math.floor(options.memoryLimitBytes / (1024 * 1024)));
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${heapLimitMb}`,
        "--input-type=module",
        "--eval",
        NODE_PROCESS_CHILD_SOURCE,
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const hostAbortController = new AbortController();
    const startedAt = Date.now();
    let effectiveTimeoutMs = options.timeoutMs;
    let deadlineAt = startedAt + effectiveTimeoutMs;
    let deadline: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    let settled = false;
    const hostTasks = new Set<Promise<void>>();

    return new Promise<FabricSandboxResult>((resolve) => {
      const finish = (result: FabricSandboxResult): void => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
        if (!hostAbortController.signal.aborted && result.terminationReason !== "completed") {
          hostAbortController.abort(new Error(result.error ?? "Node process execution stopped"));
        }
        child.removeAllListeners();
        if (child.connected) child.disconnect();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve(result);
      };
      const scheduleDeadline = (): void => {
        if (deadline) clearTimeout(deadline);
        deadline = setTimeout(() => {
          const error = `Execution timed out after ${effectiveTimeoutMs}ms`;
          finish({ value: undefined, logs: [], terminationReason: "timed_out", error });
        }, Math.max(0, deadlineAt - Date.now()));
        deadline.unref?.();
      };
      const extendDeadline = (ref: string, args: Record<string, unknown>): void => {
        const requested = options.minimumTimeoutMsForHostCall?.(ref, args);
        if (typeof requested !== "number" || !Number.isFinite(requested)) return;
        const nextDeadlineAt = Date.now() + Math.max(1, Math.floor(requested));
        if (nextDeadlineAt <= deadlineAt) return;
        deadlineAt = nextDeadlineAt;
        effectiveTimeoutMs = deadlineAt - startedAt;
        scheduleDeadline();
      };

      abortHandler = () => {
        finish({
          value: undefined,
          logs: [],
          terminationReason: "aborted",
          error: "Execution cancelled",
        });
      };
      options.signal?.addEventListener("abort", abortHandler, { once: true });

      child.on("message", (raw: unknown) => {
        if (settled || typeof raw !== "object" || raw === null) return;
        const message = raw as ChildMessage;
        if (message.type === "result") {
          if (message.result.terminationReason !== "completed" && !hostAbortController.signal.aborted) {
            hostAbortController.abort(new Error(message.result.error ?? "Node process execution stopped"));
          }
          void Promise.allSettled([...hostTasks]).then(() => finish(message.result));
          return;
        }
        if (message.type !== "call") return;
        extendDeadline(message.ref, message.args);
        const task = hostCall(message.ref, message.args, hostAbortController.signal).then(
          (value) => send(child, { type: "response", id: message.id, ok: true, value }),
          (error) =>
            send(child, {
              type: "response",
              id: message.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
        );
        hostTasks.add(task);
        void task.finally(() => hostTasks.delete(task));
      });
      child.once("error", (error) => {
        finish({
          value: undefined,
          logs: [],
          terminationReason: "runtime_error",
          error: `Node process executor failed: ${error.message}`,
        });
      });
      child.once("exit", (exitCode, signal) => {
        if (settled) return;
        const detail = signal ? `signal ${signal}` : `exit code ${exitCode ?? "unknown"}`;
        finish({
          value: undefined,
          logs: [],
          terminationReason: "runtime_error",
          error: `Node process executor exited before returning a result (${detail}); it may have exceeded its memory limit`,
        });
      });

      scheduleDeadline();
      send(child, {
        type: "execute",
        setup: GUEST_SETUP,
        code: options.transpiledCode ?? transpileFabricCode(code),
        strings: options.strings ?? {},
        tokenBudget: options.tokenBudget,
        maxLogChars: options.maxLogChars ?? 100_000,
      });
    });
  }
}
