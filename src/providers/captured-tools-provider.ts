import path from "node:path";
import { readChildToolAllowlist } from "../core/child-tool-allowlist.js";
import { runAbortable, throwIfAborted } from "../async-settlement.js";
import type { AgentToolResult, SourceInfo } from "@earendil-works/pi-coding-agent";
import { CapturedToolCatalog, type CapturedToolEntry } from "../capture/catalog.js";
import { classifyPiBashError, piBashResultError } from "../core/pi-bash-error.js";
import { isPiShellToolName } from "../core/pi-tools.js";
import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";

export interface CapturedToolInvocationResult {
  content: AgentToolResult<unknown>["content"];
  text: string;
  details?: unknown;
  isError: boolean;
  terminate?: boolean;
  source: SourceInfo;
}

const textFromContent = (content: AgentToolResult<unknown>["content"]): string =>
  content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const sourceLabel = (sourceInfo: SourceInfo): string => {
  if (sourceInfo.path.startsWith("<")) return sourceInfo.source;
  const segments = sourceInfo.path.split(/[\\/]/);
  const packageSegment = [...segments].reverse().find((segment) => segment.startsWith("pi-"));
  if (packageSegment) return packageSegment;
  const filename = path.basename(sourceInfo.path).replace(/\.[^.]+$/, "");
  if (filename && filename !== "index") return filename;
  return path.basename(path.dirname(sourceInfo.path)) || sourceInfo.source;
};

const capturedToolNamespace = (entry: CapturedToolEntry): string =>
  `extension:${sourceLabel(entry.sourceInfo)}`;

const descriptorFrom = (entry: CapturedToolEntry): FabricActionDescriptor => ({
  name: entry.name,
  description: `${entry.definition.description} (captured from ${sourceLabel(entry.sourceInfo)})`,
  inputSchema: entry.definition.parameters as Record<string, unknown>,
  risk: entry.risk,
  namespace: capturedToolNamespace(entry),
});

const asInvocationResult = (
  entry: CapturedToolEntry,
  result: AgentToolResult<unknown>,
  isError: boolean,
): CapturedToolInvocationResult => ({
  content: result.content,
  text: textFromContent(result.content),
  ...(result.details !== undefined ? { details: result.details } : {}),
  isError,
  ...(result.terminate !== undefined ? { terminate: result.terminate } : {}),
  source: entry.sourceInfo,
});

class CapturedToolScheduler {
  #sequentialTail: Promise<void> = Promise.resolve();
  readonly #parallel = new Set<Promise<unknown>>();

  run<T>(mode: "sequential" | "parallel" | undefined, operation: () => Promise<T>): Promise<T> {
    if (mode === "sequential") {
      const precedingParallel = [...this.#parallel];
      const result = this.#sequentialTail
        .then(() => Promise.allSettled(precedingParallel))
        .then(operation);
      this.#sequentialTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }

    const result = this.#sequentialTail.then(operation);
    this.#parallel.add(result);
    void result.then(
      () => this.#parallel.delete(result),
      () => this.#parallel.delete(result),
    );
    return result;
  }
}

export class CapturedToolsProvider implements FabricProvider {
  readonly name = "extensions";
  readonly description =
    "Tools captured from other Pi extensions and invoked lazily through Fabric";

  readonly #scheduler = new CapturedToolScheduler();
  readonly #allowedTools = readChildToolAllowlist();

  constructor(readonly catalog: CapturedToolCatalog) {}

  async list(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    const query = request.query?.trim().toLowerCase();
    const descriptors = this.catalog.list().filter((entry) => !this.#allowedTools || this.#allowedTools.has(entry.name)).map(descriptorFrom);
    if (!query) return descriptors;
    return descriptors.filter((descriptor) =>
      `${descriptor.name} ${descriptor.description} ${descriptor.namespace ?? ""}`
        .toLowerCase()
        .includes(query),
    );
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    if (this.#allowedTools && !this.#allowedTools.has(actionName)) return undefined;
    const entry = this.catalog.get(actionName);
    return entry ? descriptorFrom(entry) : undefined;
  }

  prepareArguments(actionName: string, args: Record<string, unknown>): Record<string, unknown> {
    this.#assertAllowed(actionName);
    const prepare = this.catalog.require(actionName).wrappedTool.prepareArguments;
    if (!prepare) return args;
    const prepared = prepare(args);
    if (typeof prepared !== "object" || prepared === null || Array.isArray(prepared)) {
      throw new Error(`Captured tool ${actionName} prepared non-object arguments`);
    }
    return prepared as Record<string, unknown>;
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<CapturedToolInvocationResult> {
    this.#assertAllowed(actionName);
    const entry = this.catalog.require(actionName);
    return this.#scheduler.run(entry.definition.executionMode, () =>
      runAbortable(context.signal, () => this.#invokeCaptured(entry, args, context)),
    );
  }

  #assertAllowed(name: string): void {
    if (this.#allowedTools && !this.#allowedTools.has(name)) {
      throw new Error(`Extension tool ${name} is not permitted by this child's tool allowlist`);
    }
  }

  async #invokeCaptured(
    entry: CapturedToolEntry,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<CapturedToolInvocationResult> {
    const { runner, wrappedTool } = entry;
    const toolCallId = context.nestedToolCallId;
    await runAbortable(context.signal, () => runner.emit({
      type: "tool_execution_start",
      toolCallId,
      toolName: entry.name,
      args,
    }));

    let result: AgentToolResult<unknown>;
    let isError = false;
    let thrown: unknown;
    let executionStarted = false;
    let updateTail: Promise<void> = Promise.resolve();
    try {
      const preflight = await runAbortable(context.signal, () => runner.emitToolCall({
        type: "tool_call",
        toolName: entry.name,
        toolCallId,
        input: args,
      }));
      context.updateArguments?.(args);
      if (preflight?.block) {
        throw new Error(preflight.reason || `Captured tool ${entry.name} was blocked`);
      }
      executionStarted = true;
      const requestedCwd = args.cwd;
      const executionContext = isPiShellToolName(entry.name) && typeof requestedCwd === "string"
        ? { ...runner.createContext(), cwd: requestedCwd }
        : undefined;
      result = await runAbortable(context.signal, () =>
        wrappedTool.execute(toolCallId, args, context.signal, (partialResult) => {
        const progress = textFromContent(partialResult.content).trim();
        if (progress) context.update(`${entry.name}: ${progress.slice(0, 500)}`);
        updateTail = updateTail
          .then(() =>
            runAbortable(context.signal, () => runner.emit({
              type: "tool_execution_update",
              toolCallId,
              toolName: entry.name,
              args,
              partialResult,
            })),
          )
          .catch(() => undefined);
        }, executionContext),
      );
    } catch (error) {
      thrown = isPiShellToolName(entry.name) && executionStarted ? classifyPiBashError(error) : error;
      isError = true;
      result = {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        details: { capturedToolError: true },
      };
    }

    await updateTail;
    throwIfAborted(context.signal);
    const patch = await runAbortable(context.signal, () => runner.emitToolResult({
      type: "tool_result",
      toolName: entry.name,
      toolCallId,
      input: args,
      content: result.content,
      details: result.details,
      isError,
    }));
    if (patch) {
      result = {
        ...result,
        content: patch.content ?? result.content,
        ...(patch.details !== undefined ? { details: patch.details } : {}),
      };
      isError = patch.isError ?? isError;
    }

    await runAbortable(context.signal, () => runner.emit({
      type: "tool_execution_end",
      toolCallId,
      toolName: entry.name,
      result,
      isError,
    }));

    if (isError) {
      if (isPiShellToolName(entry.name)) {
        throw piBashResultError(thrown, textFromContent(result.content));
      }
      const text = textFromContent(result.content).trim();
      throw new Error(
        text || (thrown instanceof Error ? thrown.message : `Captured tool ${entry.name} failed`),
      );
    }
    return asInvocationResult(entry, result, false);
  }
}
