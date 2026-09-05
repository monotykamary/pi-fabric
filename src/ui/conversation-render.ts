import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  parseSkillBlock,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  type MarkdownTransformer,
  type MessageRenderer,
  type Theme,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme, TUI } from "@earendil-works/pi-tui";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CodePreviewSettings } from "./code-preview.js";
import { highlightCode } from "./highlight.js";
import { terminalSafe } from "./transcript-sanitization.js";
import type { FabricConversationTarget } from "./conversation.js";
import { unwrapActorEnvelopeText } from "./conversation-transcript.js";
import type {
  NativeAgentMessage,
  NativeConversationTranscript,
  NativeToolExecution,
} from "./conversation-native-reader.js";

export type {
  NativeAgentMessage,
  NativeConversationTranscript,
  NativeToolExecution,
} from "./conversation-native-reader.js";

type UserAgentMessage = Extract<NativeAgentMessage, { role: "user" }>;
type ToolResultAgentMessage = Extract<NativeAgentMessage, { role: "toolResult" }>;
type BashExecutionAgentMessage = Extract<NativeAgentMessage, { role: "bashExecution" }>;
type CustomAgentMessage = Extract<NativeAgentMessage, { role: "custom" }>;
type CompactionSummaryAgentMessage = Extract<NativeAgentMessage, { role: "compactionSummary" }>;
type BranchSummaryAgentMessage = Extract<NativeAgentMessage, { role: "branchSummary" }>;

/** Exactly what ToolExecutionComponent accepts as its tool definition. */
export type FabricToolDefinitionLike = ConstructorParameters<typeof ToolExecutionComponent>[4];
export type FabricGetToolDefinition = (toolName: string) => FabricToolDefinitionLike;

export interface FabricConversationTranscriptRendererOptions {
  /**
   * Registered tool definitions (Main wires the actual fabricTool and
   * capturedTools.get(name).definition). Undefined falls back to the native
   * generic tool card, exactly like interactive-mode getRegisteredToolDefinition.
   */
  getToolDefinition?: FabricGetToolDefinition | undefined;
  /** Extension message renderers (capturedTools.runner.getMessageRenderer). */
  getMessageRenderer?: ((customType: string) => MessageRenderer | undefined) | undefined;
  /** Native markdown transformers (capturedTools.runner.getMarkdownTransformers). */
  markdownTransformers?: readonly MarkdownTransformer[] | undefined;
  hiddenThinkingLabel?: string | undefined;
  imageWidthCells?: number | undefined;
}

export interface FabricConversationTranscriptRenderOptions {
  target: FabricConversationTarget;
  toolsExpanded: boolean;
  outputPad?: 0 | 1;
  codeBlockIndent?: string;
  codePreviewSettings?: CodePreviewSettings | undefined;
  hideThinking?: boolean;
  showImages?: boolean;
}

type NativeToolResultContent = { type: string; text?: string; data?: string; mimeType?: string };

const TOOL_CACHE_LIMIT = 128;
const MESSAGE_CACHE_LIMIT = 192;
const DEFAULT_IMAGE_WIDTH_CELLS = 60;

const stableKey = (value: unknown): string => {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return `unserializable:${String(value)}`;
  }
};

interface ToolCacheRecord {
  component: ToolExecutionComponent;
  started: boolean;
  argsComplete: boolean;
  argsKey: string;
  resultKey: string | undefined;
  partialKey: string | undefined;
}

interface MessageCacheRecord {
  component: BashExecutionComponent | CustomMessageComponent | CompactionSummaryMessageComponent
    | BranchSummaryMessageComponent | SkillInvocationMessageComponent;
}

interface AssistantCacheRecord {
  hideThinking: boolean;
  component: AssistantMessageComponent;
}

/**
 * Renders a conversation-native transcript with the exact registered Pi
 * components (UserMessageComponent, AssistantMessageComponent,
 * ToolExecutionComponent, BashExecutionComponent, compaction/branch/custom
 * summaries), dispatched the way interactive-mode addMessageToChat and
 * renderSessionItems do. Native component rows are preserved verbatim — no
 * dashboard normalization, no per-line re-truncation, no extra background or
 * glyph decoration — so full-width backgrounds and native spacing survive.
 */
export class FabricConversationTranscriptRenderer {
  private readonly toolComponents = new Map<string, ToolCacheRecord>();
  private readonly messageComponents = new Map<string, MessageCacheRecord>();
  private readonly assistantComponents = new Map<string, AssistantCacheRecord>();
  private readonly markdownThemeCache = new Map<string, MarkdownTheme>();
  private readonly highlightInvalidate: () => void;
  private disposed = false;
  private currentTargetId = "";
  private readonly rendererStates = new Map<string, Set<Record<string, unknown>>>();
  private readonly liveStates = new WeakSet<object>();
  private lastToolsExpanded: boolean | undefined;
  private lastShowImages: boolean | undefined;
  private lastHideThinking: boolean | undefined;
  private lastCodeBlockIndent: string | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly rendererOptions: FabricConversationTranscriptRendererOptions = {},
  ) {
    this.highlightInvalidate = (): void => {
      if (this.disposed) return;
      this.assistantComponents.clear();
      this.messageComponents.clear();
      this.tui.requestRender();
    };
  }

  /** Drop cached components; stray renderer timers/invalidations become no-ops. */
  invalidate(): void {
    for (const key of this.rendererStates.keys()) this.releaseRendererStates(key);
    this.toolComponents.clear();
    this.messageComponents.clear();
    this.assistantComponents.clear();
    this.markdownThemeCache.clear();
  }

  /** Finalize: live spinner/timing intervals may still fire once; guarded. */
  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  render(
    transcript: NativeConversationTranscript,
    width: number,
    options: FabricConversationTranscriptRenderOptions,
  ): string[] {
    if (this.disposed || width <= 0) return [];
    this.currentTargetId = options.target.id;
    this.syncOptionCaches(options);
    const lines: string[] = [];
    const renderWidth = Math.max(1, width);
    const streaming = transcript.streaming;
    if (
      transcript.messages.length === 0 &&
      !streaming.partialAssistant &&
      streaming.tools.length === 0
    ) {
      lines.push(
        this.theme.fg(
          "dim",
          "No retained transcript yet; new agent activity will appear here.",
        ),
      );
      return lines;
    }
    if (transcript.hasMore) {
      lines.push(this.theme.fg("dim", "↑ older activity available · ctrl+↑ past the top to load"));
    }
    const frameTools = new Set<string>();
    for (const message of transcript.messages) {
      this.renderMessage(message, renderWidth, options, lines, frameTools);
    }
    this.renderPartialAssistant(
      streaming.partialAssistant,
      renderWidth,
      options,
      lines,
      frameTools,
      new Set(streaming.tools.map((tool) => tool.toolCallId)),
    );
    this.renderStreamingTools(streaming.tools, renderWidth, options, lines, frameTools);
    if (transcript.hasNewer) {
      lines.push(this.theme.fg("dim", "↓ newer activity available · ctrl+↓ past the bottom to load"));
    }
    return lines;
  }

  private syncOptionCaches(options: FabricConversationTranscriptRenderOptions): void {
    if (options.codeBlockIndent !== this.lastCodeBlockIndent) {
      this.lastCodeBlockIndent = options.codeBlockIndent;
      this.markdownThemeCache.clear();
      this.assistantComponents.clear();
      this.messageComponents.clear();
    }
    if (options.toolsExpanded !== this.lastToolsExpanded) {
      this.lastToolsExpanded = options.toolsExpanded;
      this.toolComponents.clear();
      this.messageComponents.clear();
    }
    if (options.showImages !== this.lastShowImages) {
      this.lastShowImages = options.showImages;
      this.toolComponents.clear();
    }
    if (options.hideThinking !== this.lastHideThinking) {
      this.lastHideThinking = options.hideThinking;
      this.assistantComponents.clear();
    }
  }

  private markdownTheme(options: FabricConversationTranscriptRenderOptions): MarkdownTheme {
    const key = options.codeBlockIndent ?? "";
    let markdownTheme = this.markdownThemeCache.get(key);
    if (!markdownTheme) {
      markdownTheme = {
        ...(options.codeBlockIndent !== undefined ? { codeBlockIndent: options.codeBlockIndent } : {}),
        heading: (text) => this.theme.fg("mdHeading", text),
        link: (text) => this.theme.fg("mdLink", text),
        linkUrl: (text) => this.theme.fg("mdLinkUrl", text),
        code: (text) => this.theme.fg("mdCode", text),
        codeBlock: (text) => this.theme.fg("mdCodeBlock", text),
        codeBlockBorder: (text) => this.theme.fg("mdCodeBlockBorder", text),
        quote: (text) => this.theme.fg("mdQuote", text),
        quoteBorder: (text) => this.theme.fg("mdQuoteBorder", text),
        hr: (text) => this.theme.fg("mdHr", text),
        listBullet: (text) => this.theme.fg("mdListBullet", text),
        bold: (text) => this.theme.bold(text),
        italic: (text) => this.theme.italic(text),
        underline: (text) => this.theme.underline(text),
        strikethrough: (text) => this.theme.strikethrough(text),
        highlightCode: (code, lang) =>
          highlightCode(code, lang ?? "", this.highlightInvalidate) ??
          code.split("\n").map((line) => this.theme.fg("mdCodeBlock", line)),
      };
      this.markdownThemeCache.set(key, markdownTheme);
    }
    return markdownTheme;
  }

  private renderMessage(
    message: NativeAgentMessage,
    width: number,
    options: FabricConversationTranscriptRenderOptions,
    lines: string[],
    frameTools: Set<string>,
  ): void {
    switch (message.role) {
      case "user":
        this.renderUserMessage(message, width, options, lines);
        return;
      case "assistant":
        this.renderAssistantMessage(message, width, options, lines, frameTools);
        return;
      case "toolResult": {
        if (typeof message.toolCallId !== "string") return;
        const record = this.toolRecord(
          message.toolCallId, message.toolName ?? "tool", options,
          () => new ToolExecutionComponent(
            message.toolName ?? "tool", message.toolCallId, undefined,
            { showImages: options.showImages ?? true, imageWidthCells: this.imageWidthCells() },
            this.definitionFor(message.toolName ?? "tool"),
            this.tui,
            options.target.cwd ?? process.cwd(),
          ),
        );
        record.component.setExpanded(options.toolsExpanded);
        record.component.updateResult(message, false);
        return;
      }
      case "bashExecution":
        this.pushSpacer(lines);
        this.renderBashExecution(message, width, options, lines);
        return;
      case "custom":
        if (!message.display) return;
        this.pushSpacer(lines);
        this.renderCustomMessage(message, width, options, lines);
        return;
      case "compactionSummary":
        this.pushSpacer(lines);
        this.renderBoxedMessage(`compaction:${message.timestamp}`, message, CompactionSummaryMessageComponent, width, options, lines);
        return;
      case "branchSummary":
        this.pushSpacer(lines);
        this.renderBoxedMessage(`branch:${message.timestamp}`, message, BranchSummaryMessageComponent, width, options, lines);
        return;
      default:
        return;
    }
  }

  private renderUserMessage(
    message: UserAgentMessage,
    width: number,
    options: FabricConversationTranscriptRenderOptions,
    lines: string[],
  ): void {
    const text = userMessageText(message);
    if (!text) return;
    this.pushSpacer(lines);
    const skillBlock = parseSkillBlock(text);
    if (skillBlock) {
      const record = this.messageRecord(`skill:${stableKey(text)}`, options, () =>
        new SkillInvocationMessageComponent(skillBlock, this.markdownTheme(options)));
      record.component.setExpanded(options.toolsExpanded);
      lines.push(...safeRender(record.component, width, () => this.plainTextFallback(text, width)));
      if (skillBlock.userMessage) {
        this.pushSpacer(lines);
        lines.push(...this.userComponentLines(skillBlock.userMessage, width, options));
      }
      return;
    }
    lines.push(...this.userComponentLines(text, width, options));
  }

  private userComponentLines(
    text: string,
    width: number,
    options: FabricConversationTranscriptRenderOptions,
  ): string[] {
    const component = new UserMessageComponent(
      terminalSafe(text, false),
      this.markdownTheme(options),
      options.outputPad ?? 1,
      this.rendererOptions.markdownTransformers,
    );
    return safeRender(component, width, () => this.plainTextFallback(text, width));
  }

  private renderAssistantMessage(
    message: Extract<NativeAgentMessage, { role: "assistant" }>,
    width: number,
    options: FabricConversationTranscriptRenderOptions,
    lines: string[],
    frameTools: Set<string>,
  ): void {
    const record = this.assistantRecord(`assistant:${message.timestamp}`, options);
    record.component.updateContent(message, false);
    lines.push(...safeRender(record.component, width, () => this.plainTextFallback(assistantText(message), width)));
    const errored = message.stopReason === "aborted" || message.stopReason === "error";
    for (const content of message.content) {
      if (content.type !== "toolCall") continue;
      const component = this.toolRecord(content.id, content.name, options, () =>
        new ToolExecutionComponent(
          content.name, content.id, content.arguments,
          { showImages: options.showImages ?? true, imageWidthCells: this.imageWidthCells() },
          this.definitionFor(content.name),
          this.tui,
          options.target.cwd ?? process.cwd(),
        )).component;
      component.setExpanded(options.toolsExpanded);
      frameTools.add(content.id);
      if (errored) {
        component.updateResult(
          { content: [{ type: "text", text: message.errorMessage || "Error" }], isError: true },
          false,
        );
      }
      lines.push(...safeRender(component, width, () => this.plainTextFallback(content.name, width)));
    }
  }

  private renderPartialAssistant(
    message: NativeConversationTranscript["streaming"]["partialAssistant"],
    width: number,
    options: FabricConversationTranscriptRenderOptions,
    lines: string[],
    frameTools: Set<string>,
    streamingToolIds: Set<string>,
  ): void {
    if (!message) return;
    const hideThinking = options.hideThinking ?? false;
    let record = this.assistantComponents.get(":streaming");
    if (!record || record.hideThinking !== hideThinking) {
      record = {
        hideThinking,
        component: new AssistantMessageComponent(
          undefined,
          hideThinking,
          this.markdownTheme(options),
          this.rendererOptions.hiddenThinkingLabel,
          options.outputPad ?? 1,
          this.rendererOptions.markdownTransformers,
        ),
      };
      this.assistantComponents.set(":streaming", record);
      this.boundCache(this.assistantComponents, MESSAGE_CACHE_LIMIT);
    }
    record.component.updateContent(message, true);
    lines.push(...safeRender(record.component, width, () => this.plainTextFallback(assistantText(message), width)));
    for (const content of message.content) {
      if (content.type !== "toolCall" || frameTools.has(content.id)) continue;
      // A toolCall whose tool_execution_start has not arrived yet still renders
      // immediately, like native pendingTools; once streaming.tools covers the
      // id, that path owns creation, state, and row emission to avoid duplicates.
      if (streamingToolIds.has(content.id)) continue;
      const component = this.toolRecord(content.id, content.name, options, () =>
        new ToolExecutionComponent(
          content.name, content.id, content.arguments,
          { showImages: options.showImages ?? true, imageWidthCells: this.imageWidthCells() },
          this.definitionFor(content.name),
          this.tui,
          options.target.cwd ?? process.cwd(),
        )).component;
      component.setExpanded(options.toolsExpanded);
      frameTools.add(content.id);
      lines.push(...safeRender(component, width, () => this.plainTextFallback(content.name, width)));
    }
  }

  private renderStreamingTools(
    tools: readonly NativeToolExecution[],
    width: number,
    options: FabricConversationTranscriptRenderOptions,
    lines: string[],
    frameTools: Set<string>,
  ): void {
    for (const tool of tools) {
      if (frameTools.has(tool.toolCallId)) continue;
      frameTools.add(tool.toolCallId);
      const record = this.toolRecord(tool.toolCallId, tool.toolName, options, () =>
        new ToolExecutionComponent(
          tool.toolName, tool.toolCallId, tool.args,
          { showImages: options.showImages ?? true, imageWidthCells: this.imageWidthCells() },
          this.definitionFor(tool.toolName),
          this.tui,
          options.target.cwd ?? process.cwd(),
        ));
      const { component } = record;
      component.setExpanded(options.toolsExpanded);
      if (!record.started) {
        record.started = true;
        component.markExecutionStarted();
      }
      const argsKey = stableKey(tool.args);
      if (argsKey !== record.argsKey) {
        record.argsKey = argsKey;
        component.updateArgs(tool.args);
      }
      if (tool.result !== undefined) {
        if (!record.argsComplete) {
          record.argsComplete = true;
          component.setArgsComplete();
        }
        const resultKey = stableKey(tool.result);
        if (resultKey !== record.resultKey) {
          record.resultKey = resultKey;
          record.partialKey = undefined;
          component.updateResult(
            {
              content: (tool.result.content ?? []) as NativeToolResultContent[],
              ...(tool.result.details !== undefined ? { details: tool.result.details } : {}),
              isError: tool.isError ?? false,
            },
            false,
          );
        }
      } else if (tool.partial !== undefined) {
        const partialKey = stableKey(tool.partial);
        if (partialKey !== record.partialKey) {
          record.partialKey = partialKey;
          component.updateResult(
            {
              content: (tool.partial.content ?? []) as NativeToolResultContent[],
              ...(tool.partial.details !== undefined ? { details: tool.partial.details } : {}),
              isError: false,
            },
            true,
          );
        }
      }
      lines.push(...safeRender(component, width, () => this.plainTextFallback(tool.toolName, width)));
    }
  }

  private renderBashExecution(
    message: BashExecutionAgentMessage,
    width: number,
    options: FabricConversationTranscriptRenderOptions,
    lines: string[],
  ): void {
    const key = `bash:${message.timestamp}:${(message.output ?? "").length}`;
    const record = this.messageRecord(key, options, () => {
      const component = new BashExecutionComponent(message.command, this.tui, message.excludeFromContext);
      component.appendOutput(terminalSafe(message.output ?? "", false));
      // Mirrors interactive-mode: only the truncated flag is known at this point.
      const truncation = message.truncated ? ({ truncated: true } as TruncationResult) : undefined;
      component.setComplete(message.exitCode, message.cancelled, truncation, message.fullOutputPath);
      return component;
    });
    record.component.setExpanded(options.toolsExpanded);
    lines.push(...safeRender(record.component, width, () => this.plainTextFallback(message.command, width)));
  }

  private renderCustomMessage(
    message: CustomAgentMessage,
    width: number,
    options: FabricConversationTranscriptRenderOptions,
    lines: string[],
  ): void {
    const record = this.messageRecord(`custom:${message.timestamp}:${stableKey(message.content)}`, options, () =>
      new CustomMessageComponent(
        message,
        this.rendererOptions.getMessageRenderer?.(message.customType),
        this.markdownTheme(options),
        options.outputPad ?? 1,
      ));
    record.component.setExpanded(options.toolsExpanded);
    lines.push(...safeRender(record.component, width, () => this.plainTextFallback(customText(message), width)));
  }

  private renderBoxedMessage<M extends CompactionSummaryAgentMessage | BranchSummaryAgentMessage>(
    key: string,
    message: M,
    create: new (message: M, markdownTheme?: MarkdownTheme) => MessageCacheRecord["component"],
    width: number,
    options: FabricConversationTranscriptRenderOptions,
    lines: string[],
  ): void {
    const record = this.messageRecord(key, options, () => new create(message, this.markdownTheme(options)));
    record.component.setExpanded(options.toolsExpanded);
    lines.push(...safeRender(record.component, width, () => this.plainTextFallback(message.summary, width)));
  }

  /**
   * Registered definition with wrapped renderer callbacks: the render context
   * invalidate becomes a no-op once disposed, so a live spinner/timing timer
   * firing after dispose cannot touch the TUI. ToolExecutionComponent has no
   * dispose; this finalizes its renderer subscriptions instead.
   */
  private definitionFor(toolName: string): FabricToolDefinitionLike {
    const definition = this.rendererOptions.getToolDefinition?.(toolName);
    if (!definition) return definition;
    const targetId = this.currentTargetId;
    const guard = <T extends { invalidate: () => void; toolCallId: string; state: Record<string, unknown> }>(context: T): T => {
      const key = `${targetId}\u0000${context.toolCallId}`;
      const states = this.rendererStates.get(key) ?? new Set<Record<string, unknown>>();
      states.add(context.state);
      this.rendererStates.set(key, states);
      this.liveStates.add(context.state);
      return {
        ...context,
        invalidate: (): void => {
          if (this.disposed || !this.liveStates.has(context.state)) return;
          context.invalidate();
        },
      };
    };
    return {
      ...definition,
      ...(definition.renderCall
        ? { renderCall: (args: any, theme: Theme, context: any) => definition.renderCall!(args, theme, guard(context)) }
        : {}),
      ...(definition.renderResult
        ? {
          renderResult: (result: any, renderOptions: any, theme: Theme, context: any) =>
            definition.renderResult!(result, renderOptions, theme, guard(context)),
        }
        : {}),
    };
  }

  private toolRecord(
    toolCallId: string,
    toolName: string,
    options: FabricConversationTranscriptRenderOptions,
    create: () => ToolExecutionComponent,
  ): ToolCacheRecord {
    const key = `${options.target.id}\u0000${toolCallId}`;
    let record = this.toolComponents.get(key);
    if (!record) {
      record = {
        component: create(),
        started: false,
        argsComplete: false,
        argsKey: stableKey(undefined),
        resultKey: undefined,
        partialKey: undefined,
      };
      this.toolComponents.set(key, record);
      this.boundCache(this.toolComponents, TOOL_CACHE_LIMIT, (key) => this.releaseRendererStates(key));
    }
    return record;
  }

  private assistantRecord(
    key: string,
    options: FabricConversationTranscriptRenderOptions,
  ): AssistantCacheRecord {
    const cacheKey = `${options.target.id}\u0000${key}`;
    const hideThinking = options.hideThinking ?? false;
    let record = this.assistantComponents.get(cacheKey);
    if (!record || record.hideThinking !== hideThinking) {
      record = {
        hideThinking,
        component: new AssistantMessageComponent(
          undefined,
          hideThinking,
          this.markdownTheme(options),
          this.rendererOptions.hiddenThinkingLabel,
          options.outputPad ?? 1,
          this.rendererOptions.markdownTransformers,
        ),
      };
      this.assistantComponents.set(cacheKey, record);
      this.boundCache(this.assistantComponents, MESSAGE_CACHE_LIMIT);
    }
    return record;
  }

  private messageRecord(
    key: string,
    options: FabricConversationTranscriptRenderOptions,
    create: () => MessageCacheRecord["component"],
  ): MessageCacheRecord {
    const cacheKey = `${options.target.id}\u0000${key}`;
    let record = this.messageComponents.get(cacheKey);
    if (!record) {
      record = { component: create() };
      this.messageComponents.set(cacheKey, record);
      this.boundCache(this.messageComponents, MESSAGE_CACHE_LIMIT);
    }
    return record;
  }

  private releaseRendererStates(key: string): void {
    for (const state of this.rendererStates.get(key) ?? []) {
      this.liveStates.delete(state);
      if (state.codePreviewTimingInterval) {
        clearInterval(state.codePreviewTimingInterval as ReturnType<typeof setInterval>);
        delete state.codePreviewTimingInterval;
      }
      const spinner = state.fabricSpinner as { timer?: ReturnType<typeof setTimeout> } | undefined;
      if (spinner?.timer) { clearTimeout(spinner.timer); delete spinner.timer; }
    }
    this.rendererStates.delete(key);
  }

  private boundCache<K, V>(cache: Map<K, V>, limit: number, release?: (key: K) => void): void {
    while (cache.size > limit) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      release?.(oldest);
      cache.delete(oldest);
    }
  }

  private imageWidthCells(): number {
    return Math.max(1, Math.floor(this.rendererOptions.imageWidthCells ?? DEFAULT_IMAGE_WIDTH_CELLS));
  }

  private plainTextFallback(text: string, width: number): string[] {
    const safe = terminalSafe(text, false);
    return safe.split("\n").flatMap((paragraph) =>
      wrapTextWithAnsi(paragraph, Math.max(1, width)).map((line) => this.theme.fg("text", line)),
    );
  }

  private pushSpacer(lines: string[]): void {
    if (lines.length > 0) lines.push("");
  }
}

const userMessageText = (message: UserAgentMessage): string => {
  const blocks = typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content.filter((block): block is { type: "text"; text: string } => block.type === "text");
  const text = blocks.map((block) => block.text).join("");
  return unwrapActorEnvelopeText(text) ?? text;
};

const assistantText = (message: { content: unknown }): string =>
  Array.isArray(message.content)
    ? message.content
      .filter((block): block is { type: "text"; text: string } =>
        typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text")
      .map((block) => block.text)
      .join("\n")
    : "";

const customText = (message: CustomAgentMessage): string =>
  typeof message.content === "string"
    ? message.content
    : message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");

const safeRender = (
  component: { render(width: number): string[] },
  width: number,
  fallback: () => string[],
): string[] => {
  try {
    // Native rows are preserved verbatim: components already wrap and pad to
    // width, so re-truncating would clip the trailing background cell.
    return component.render(width);
  } catch {
    return fallback();
  }
};
