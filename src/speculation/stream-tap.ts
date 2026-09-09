import type {
  ExtensionContext,
  MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";
import { PartialCodeFieldExtractor } from "./partial-json.js";
import type { FabricSpeculationCandidate } from "./types.js";

interface CallScanner { push(code: string): FabricSpeculationCandidate[]; }

interface StreamState {
  toolCallId: string;
  isFabricExec: boolean;
  extractor: PartialCodeFieldExtractor;
  scanner?: CallScanner;
}

export interface FabricSpeculationTapOptions {
  enabled(): boolean;
  maxBufferBytes(): number;
  /** Static cheap gate (Tier-A set / MCP allowlist) before the registry re-validates. */
  isEligible(ref: string): boolean;
  launch(
    toolCallId: string,
    candidate: FabricSpeculationCandidate,
    context: ExtensionContext,
  ): void;
}

const toolCallBlock = (
  partial: unknown,
  contentIndex: number,
): { name?: string; id?: string } => {
  const content = (partial as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return {};
  const block = content[contentIndex];
  if (!block || typeof block !== "object") return {};
  const record = block as { type?: unknown; name?: unknown; id?: unknown };
  if (record.type !== "toolCall") return {};
  return {
    ...(typeof record.name === "string" && record.name ? { name: record.name } : {}),
    ...(typeof record.id === "string" && record.id ? { id: record.id } : {}),
  };
};

// Floor between full-AST reparses of one stream. The scanner's own ")" gate
// means most deltas never schedule a parse at all.
const PARSE_INTERVAL_MS = 50;

/**
 * Watches assistant message streaming for fabric_exec tool calls, incrementally
 * decodes the `code` argument, and launches speculative executions for
 * literal-argument calls as soon as they complete in the stream. Never throws
 * into the event pipeline: every failure mode degrades to no speculation.
 */
export class FabricSpeculationStreamTap {
  readonly #options: FabricSpeculationTapOptions;
  readonly #streams = new Map<number, StreamState>();
  // Language parsers are lazy; the selected scanner factory arrives through
  // a lazy dynamic import so session startup never pays for it. Streams opened
  // before the factory lands are caught up in full (extractors buffer the
  // whole decoded prefix, so no candidate is lost, only delayed).
  #createScanner: (() => CallScanner) | undefined;
  #lastParseAt = 0;

  constructor(options: FabricSpeculationTapOptions) {
    this.#options = options;
  }

  setScannerFactory(factory: () => CallScanner): void {
    this.#createScanner = factory;
    if (!this.#options.enabled()) {
      this.reset();
      return;
    }
    for (const stream of this.#streams.values()) {
      if (stream.scanner) continue;
      stream.scanner = factory();
      const code = stream.extractor.code;
      if (!stream.isFabricExec || code === undefined) continue;
      try {
        for (const candidate of stream.scanner.push(code)) {
          if (this.#options.isEligible(candidate.ref)) {
            this.#pendingCatchUp.push({ stream, candidate });
          }
        }
      } catch {
        // Catch-up scanning degrades to skipped candidates only.
      }
    }
  }

  readonly #pendingCatchUp: { stream: StreamState; candidate: FabricSpeculationCandidate }[] = [];

  /** Drain candidates recovered while the scanner module loaded. */
  flushCatchUp(context: Parameters<FabricSpeculationTapOptions["launch"]>[2]): void {
    const pending = this.#pendingCatchUp.splice(0);
    if (!this.#options.enabled()) {
      this.reset();
      return;
    }
    for (const { stream, candidate } of pending) {
      this.#options.launch(stream.toolCallId, candidate, context);
    }
  }

  /** New assistant message: content indices restart. */
  reset(): void {
    this.#streams.clear();
    this.#pendingCatchUp.length = 0;
    this.#lastParseAt = 0;
  }

  handleMessageUpdate(event: MessageUpdateEvent, context: ExtensionContext): void {
    try {
      if (!this.#options.enabled()) {
        this.reset();
        return;
      }
      if (this.#pendingCatchUp.length > 0) this.flushCatchUp(context);
      const assistantEvent = event.assistantMessageEvent;
      if (assistantEvent.type === "toolcall_start") {
        const block = toolCallBlock(assistantEvent.partial, assistantEvent.contentIndex);
        this.#streams.set(assistantEvent.contentIndex, {
          toolCallId: block.id ?? `index-${assistantEvent.contentIndex}`,
          isFabricExec: block.name !== undefined ? block.name === "fabric_exec" : true,
          extractor: new PartialCodeFieldExtractor(this.#options.maxBufferBytes()),
          ...(this.#createScanner ? { scanner: this.#createScanner() } : {}),
        });
        return;
      }
      if (assistantEvent.type === "toolcall_delta") {
        const stream = this.#streams.get(assistantEvent.contentIndex);
        if (!stream) return;
        const block = toolCallBlock(assistantEvent.partial, assistantEvent.contentIndex);
        if (block.id) stream.toolCallId = block.id;
        if (block.name !== undefined) stream.isFabricExec = block.name === "fabric_exec";
        stream.extractor.push(assistantEvent.delta);
        const code = stream.extractor.code;
        if (!stream.isFabricExec || code === undefined) return;
        this.#scan(stream, code, context, false);
        return;
      }
      if (assistantEvent.type === "toolcall_end") {
        const stream = this.#streams.get(assistantEvent.contentIndex);
        if (!stream) return;
        this.#streams.delete(assistantEvent.contentIndex);
        const block = toolCallBlock(assistantEvent.toolCall, assistantEvent.contentIndex);
        if (block.id) stream.toolCallId = block.id;
        if (block.name !== undefined) stream.isFabricExec = block.name === "fabric_exec";
        const code = stream.extractor.code;
        if (stream.isFabricExec && code !== undefined) {
          this.#scan(stream, code, context, true);
        }
      }
    } catch {
      // Speculation is opportunistic; a tap failure must never surface.
    }
  }

  #scan(stream: StreamState, code: string, context: ExtensionContext, force: boolean): void {
    const now = Date.now();
    if (!force && now - this.#lastParseAt < PARSE_INTERVAL_MS) return;
    this.#lastParseAt = now;
    if (!stream.scanner) return;
    const candidates = stream.scanner.push(code);
    for (const candidate of candidates) {
      if (this.#options.isEligible(candidate.ref)) {
        this.#options.launch(stream.toolCallId, candidate, context);
      }
    }
  }
}
