import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  type AgentToolResult,
  type ExtensionRunner,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { CapturedToolCatalog } from "../capture/catalog.js";
import { PI_CORE_TOOL_NAMES, type PiCoreToolName } from "../core/pi-tools.js";
import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricMediaBlock,
  FabricProvider,
  FabricProviderListRequest,
  FabricRisk,
} from "../protocol.js";
import { countContentLines } from "../ui/preview-lines.js";
import { CapturedToolsProvider } from "./captured-tools-provider.js";
import {
  createPreviewWriteToolDefinition,
  writeContentForPreview,
} from "./write-preview.js";

const MAX_RENDERER_ARGUMENT_CHARS = 200_000;

const readTools = new Set<PiCoreToolName>(["read", "grep", "find", "ls"]);
const writeTools = new Set<PiCoreToolName>(["edit", "write"]);

// The content array every pi core tool returns: text and/or image blocks.
type ToolContent = AgentToolResult<unknown>["content"];

const riskForTool = (name: PiCoreToolName): FabricRisk => {
  if (readTools.has(name)) return "read";
  if (writeTools.has(name)) return "write";
  return "execute";
};

const textContent = (content: ToolContent): string =>
  content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const imageBlocks = (content: unknown): FabricMediaBlock[] => {
  if (!Array.isArray(content)) return [];
  const blocks: FabricMediaBlock[] = [];
  for (const part of content) {
    if (
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "image" &&
      typeof (part as { data?: unknown }).data === "string" &&
      typeof (part as { mimeType?: unknown }).mimeType === "string"
    ) {
      blocks.push({
        type: "image",
        data: (part as { data: string }).data,
        mimeType: (part as { mimeType: string }).mimeType,
      });
    }
  }
  return blocks;
};

const normalizeResult = (
  name: PiCoreToolName,
  result: { content: ToolContent; details?: unknown; isError?: boolean },
): unknown => {
  const text = textContent(result.content);
  if (result.isError) throw new Error(text || `${name} failed`);
  if (name === "read" || name === "grep" || name === "find" || name === "ls") {
    return text;
  }
  let details = result.details;
  if (name === "write" && details && typeof details === "object" && !Array.isArray(details)) {
    const { codePreviewBeforeWrite: _before, ...publicDetails } = details as Record<string, unknown>;
    details = Object.keys(publicDetails).length > 0 ? publicDetails : undefined;
  }
  return {
    ok: true,
    output: text,
    details: details ?? null,
  };
};

// Shape of a pi core tool's execute() result. AgentToolResult<unknown> is
// { content, details, terminate? }; pi core tools throw on error rather than
// returning isError, so isError is tracked separately in #invokeWithEvents.
interface PiToolResult {
  content: ToolContent;
  details: unknown;
  terminate?: boolean;
}

export class PiToolsProvider implements FabricProvider {
  readonly name = "pi";
  readonly description = "Pi's built-in coding tools";
  readonly #tools: Record<PiCoreToolName, ToolDefinition<any, any, any>>;
  readonly #catalog: CapturedToolCatalog | undefined;
  readonly #capturedTools: CapturedToolsProvider | undefined;

  constructor(
    cwd: string,
    catalog?: CapturedToolCatalog,
    capturedTools?: CapturedToolsProvider,
  ) {
    this.#tools = {
      read: createReadToolDefinition(cwd),
      bash: createBashToolDefinition(cwd),
      edit: createEditToolDefinition(cwd),
      write: createPreviewWriteToolDefinition(cwd),
      grep: createGrepToolDefinition(cwd),
      find: createFindToolDefinition(cwd),
      ls: createLsToolDefinition(cwd),
    };
    this.#catalog = catalog;
    this.#capturedTools = capturedTools;
  }

  async list(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    const descriptors = await Promise.all(
      PI_CORE_TOOL_NAMES.map((name) => this.describe(name, _context)),
    );
    return descriptors
      .filter((descriptor): descriptor is FabricActionDescriptor => descriptor !== undefined)
      .filter((descriptor) =>
        query ? `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query) : true,
      );
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    if (!(actionName in this.#tools)) return undefined;
    const name = actionName as PiCoreToolName;
    const override = await this.#capturedTools?.describe(name, _context);
    if (override) return { ...override, namespace: "extension-override" };
    const tool = this.#tools[name];
    return this.#descriptor(name, tool);
  }

  prepareArguments(actionName: string, args: Record<string, unknown>): Record<string, unknown> {
    if (this.#catalog?.get(actionName)) {
      return this.#capturedTools!.prepareArguments(actionName, args);
    }
    if (!(actionName in this.#tools)) return args;
    const prepare = this.#tools[actionName as PiCoreToolName].prepareArguments;
    if (!prepare) return args;
    const prepared = prepare(args);
    if (typeof prepared !== "object" || prepared === null || Array.isArray(prepared)) {
      throw new Error(`Pi tool ${actionName} prepared non-object arguments`);
    }
    return prepared as Record<string, unknown>;
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown> {
    if (!(actionName in this.#tools)) throw new Error(`Unknown Pi tool: ${actionName}`);
    const name = actionName as PiCoreToolName;
    // A captured extension override (e.g. an extension that registered a "read"
    // tool) already replays the full event lifecycle itself via
    // CapturedToolsProvider, so delegate to it unchanged.
    if (this.#catalog?.get(name)) {
      const result = await this.#capturedTools!.invoke(name, args, context);
      this.#attachReadMedia(name, result, context);
      this.#attachReadNote(name, result, context);
      this.#attachPreview(name, result, args, context);
      return normalizeResult(name, result);
    }
    const tool = this.#tools[name];
    const runner = this.#catalog?.runner;
    // Without a runner (e.g. before the first tool refresh populated the
    // catalog) fall back to a direct execute — no extension hooks fire, but
    // the call still works. Once tools are refreshed the runner is available.
    if (!runner) {
      const result = await tool.execute(
        context.nestedToolCallId,
        args,
        context.signal,
        undefined,
        context.extensionContext,
      );
      this.#attachReadMedia(name, result, context);
      this.#attachReadNote(name, result, context);
      this.#attachPreview(name, result, args, context);
      return normalizeResult(name, result);
    }
    return this.#invokeWithEvents(name, tool, args, context, runner);
  }

  // Replay the agent-core tool-execution lifecycle for a nested pi.* call, so
  // extensions that hook tool_call / tool_result / tool_execution_* see pi
  // core tools invoked through fabric_exec in full-code mode — exactly as
  // they would for a top-level call in the normal (non-codemode) flow, and
  // exactly as CapturedToolsProvider already does for captured extension
  // tools. tool_result patches (content/details/isError) are applied, so
  // extensions like pi-vision-handoff can replace image blocks with text
  // descriptions before the result returns to the sandbox.
  async #invokeWithEvents(
    name: PiCoreToolName,
    tool: ToolDefinition<any, any, any>,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
    runner: ExtensionRunner,
  ): Promise<unknown> {
    const toolCallId = context.nestedToolCallId;
    await runner.emit({
      type: "tool_execution_start",
      toolCallId,
      toolName: name,
      args,
    });
    let result: PiToolResult;
    let isError = false;
    let thrown: unknown;
    let updateTail: Promise<void> = Promise.resolve();
    try {
      const preflight = await runner.emitToolCall({
        type: "tool_call",
        toolName: name,
        toolCallId,
        input: args,
      });
      if (preflight?.block) {
        throw new Error(preflight.reason || `Pi tool ${name} was blocked`);
      }
      result = (await tool.execute(
        toolCallId,
        args,
        context.signal,
        (partialResult) => {
          const progress = textContent(
            (partialResult as { content: ToolContent }).content,
          ).trim();
          if (progress) context.update(`${name}: ${progress.slice(0, 500)}`);
          updateTail = updateTail
            .then(() =>
              runner.emit({
                type: "tool_execution_update",
                toolCallId,
                toolName: name,
                args,
                partialResult,
              }),
            )
            .catch(() => undefined);
        },
        context.extensionContext,
      )) as PiToolResult;
    } catch (error) {
      thrown = error;
      isError = true;
      result = {
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
        details: undefined,
      };
    }

    await updateTail;

    // Capture the read's image blocks BEFORE any tool_result patch —
    // pi-vision-handoff swaps image→description here, which would leave
    // nothing to re-attach for the kitty preview.
    this.#attachReadMedia(name, result, context);

    const patch = await runner.emitToolResult({
      type: "tool_result",
      toolName: name,
      toolCallId,
      input: args,
      content: result.content,
      details: result.details,
      isError,
    });
    if (patch) {
      result = {
        ...result,
        content: patch.content ?? result.content,
        ...(patch.details !== undefined ? { details: patch.details } : {}),
      };
      isError = patch.isError ?? isError;
    }

    // Capture the read's clean text note AFTER the patch — the handoff strips
    // pi's non-vision note and swaps the image for a description, so the first
    // surviving text block is the short read note (not the verbose description).
    this.#attachReadNote(name, result, context);

    await runner.emit({
      type: "tool_execution_end",
      toolCallId,
      toolName: name,
      result,
      isError,
    });

    if (isError) {
      const text = textContent(result.content).trim();
      throw new Error(text || (thrown instanceof Error ? thrown.message : `Pi tool ${name} failed`));
    }
    this.#attachPreview(name, result, args, context);
    return normalizeResult(name, result);
  }

  #attachPreview(
    name: PiCoreToolName,
    result: { content: ToolContent; details?: unknown; isError?: boolean },
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): void {
    if (result.isError) return;
    const details = result.details;
    const detailRecord =
      typeof details === "object" && details !== null && !Array.isArray(details)
        ? (details as Record<string, unknown>)
        : undefined;
    const bashCommand =
      name === "bash" &&
      typeof args.command === "string" &&
      args.command.length <= MAX_RENDERER_ARGUMENT_CHARS
        ? args.command
        : undefined;
    const writeInput =
      name === "write" && typeof args.content === "string" ? args.content : undefined;
    const writeContent =
      writeInput !== undefined ? writeContentForPreview(writeInput) : undefined;
    const writeByteLength =
      writeInput !== undefined ? Buffer.byteLength(writeInput, "utf8") : undefined;
    const writeLineCount =
      writeInput !== undefined ? countContentLines(writeInput) : undefined;
    const hasWriteBefore =
      name === "write" &&
      detailRecord !== undefined &&
      Object.prototype.hasOwnProperty.call(detailRecord, "codePreviewBeforeWrite");
    context.attachPreview?.({
      result: normalizeResult(name, result),
      ...(bashCommand !== undefined ? { bashCommand } : {}),
      ...(writeContent !== undefined ? { writeContent } : {}),
      ...(writeByteLength !== undefined ? { writeByteLength } : {}),
      ...(writeLineCount !== undefined ? { writeLineCount } : {}),
      ...(details !== undefined ? { details } : {}),
      ...(hasWriteBefore
        ? {
            codePreviewBeforeWrite: detailRecord?.codePreviewBeforeWrite,
            writeBeforeCaptured: true,
          }
        : {}),
    });
  }

  // `pi.read` of an image file returns `{ type: "image" }` content blocks.
  // normalizeResult strips them — the sandbox holds text only and the model
  // return is a string — but the single-call render wants them re-attached so
  // pi core's ToolExecutionComponent renders the kitty image preview, the same
  // path a native `read` takes. Hand them out-of-band via context.attachMedia,
  // which the ActionRegistry stashes on the call audit; this bypasses the
  // result char bound that would otherwise truncate the base64 payload.
  //
  // Must run BEFORE any tool_result patch: pi-vision-handoff SWAPS image blocks
  // for text descriptions here (so the description becomes the sandbox value),
  // which would leave no image to capture. Capturing the original blocks lets
  // the single-call render show the kitty image, and the handoff's `context`
  // hook supplies the description to the model — exactly how a native `read`
  // keeps its image for kitty and swaps it only on the LLM-bound clone.
  #attachReadMedia(
    name: PiCoreToolName,
    result: { content?: unknown },
    context: FabricInvocationContext,
  ): void {
    if (name !== "read") return;
    const blocks = imageBlocks(result?.content);
    if (blocks.length > 0) context.attachMedia?.(blocks);
  }

  // The read tool's own text note (e.g. "Read image file [image/png]"), captured
  // AFTER any tool_result patch — pi-vision-handoff swaps image→description and
  // strips pi's "[Current model does not support images…]" note there, so the
  // first surviving text block is the clean note. Used as the single-call body
  // and content text so the preview shows the kitty image + the clean note
  // instead of the handoff's verbose description; the model still receives the
  // description via the handoff's `context` hook swapping the image block.
  #attachReadNote(
    name: PiCoreToolName,
    result: { content?: unknown },
    context: FabricInvocationContext,
  ): void {
    if (name !== "read") return;
    const content = result?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        context.attachMedia?.([], (block as { text: string }).text);
        return;
      }
    }
  }

  #descriptor(
    name: PiCoreToolName,
    tool: ToolDefinition<any, any, any>,
  ): FabricActionDescriptor {
    return {
      name,
      description: tool.description,
      inputSchema: tool.parameters as unknown as Record<string, unknown>,
      risk: riskForTool(name),
      namespace: "builtin",
    };
  }
}
