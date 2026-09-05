import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, KeyId, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
  CURSOR_MARKER,
  Editor,
  fuzzyFilter,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
} from "@earendil-works/pi-tui";
import { FabricConversationTranscriptRenderer, type FabricConversationTranscriptRendererOptions } from "./conversation-render.js";
import { conversationFooter, type FabricConversationAppearance } from "./conversation-chrome.js";
import type { AgentUsage } from "../agents/types.js";
import { safeText } from "./format.js";
import type { CodePreviewSettings } from "./code-preview.js";
import type { NativeConversationTranscript } from "./conversation-native-reader.js";
import { defaultConversationTarget } from "./conversation-targets.js";
import { ConversationQueueStore } from "./conversation-queue-store.js";
import type { ConversationQueue } from "./conversation-queue.js";
import { isActiveStatus } from "./types.js";

export type FabricConversationDelivery = "steer" | "followUp";

export interface FabricConversationTarget {
  id: string;
  name: string;
  kind: "main" | "peer" | "agent" | "actor";
  parentId?: string;
  status: string;
  runner?: string;
  model?: string;
  thinking?: string;
  cwd?: string;
  branch?: string;
  usage?: AgentUsage;
  contextWindow?: number;
  canSteer: boolean;
  canFollowUp: boolean;
  canStop: boolean;
  readOnlyReason?: string;
  stale?: boolean;
  /** Latest activity timestamp; enables an unread marker in the target picker. */
  updatedAt?: number;
}

export interface FabricConversationStateEntry {
  draft: string;
  following: boolean;
  scroll: number;
  pageAnchor: "start" | "end" | "prepend" | undefined;
  anchorLength?: number | undefined;
  toolsExpanded: boolean;
  hideThinking?: boolean;
  lastSeenUpdatedAt: number;
}

const STATE_ENTRY_LIMIT = 128;

/** Session-owned in-flight send; survives view close/reopen, cleared on clear(). */
export interface FabricConversationPendingSend {
  id: string;
  message: string;
  delivery: FabricConversationDelivery;
}

/**
 * Per-target view state owned by the parent controller. Created once and
 * reused across overlay opens so drafts, scroll/following, and the selected
 * target survive close/reopen; clear() on session shutdown (and bumps epoch
 * so in-flight sends from a previous session never mutate new state).
 */
export class FabricConversationState {
  readonly queues = new ConversationQueueStore();
  selectedId: string | undefined;
  private epochCounter = 0;
  private readonly entries = new Map<string, FabricConversationStateEntry>();
  private readonly pendingSends = new Set<FabricConversationPendingSend>();

  get epoch(): number {
    return this.epochCounter;
  }

  hasPendingSend(id: string, message: string): boolean {
    for (const pending of this.pendingSends) {
      if (pending.id === id && pending.message === message) return true;
    }
    return false;
  }

  addPendingSend(pending: FabricConversationPendingSend): void {
    this.pendingSends.add(pending);
  }

  /** Acknowledged: drop the pending marker and clear only the exact accepted draft. */
  resolvePendingSend(id: string, message: string): void {
    for (const pending of this.pendingSends) {
      if (pending.id !== id || pending.message !== message) continue;
      this.pendingSends.delete(pending);
      const entry = this.entries.get(id);
      if (entry && entry.draft === message) entry.draft = "";
      return;
    }
  }

  /** Rejected: drop the pending marker; the raw draft stays untouched. */
  failPendingSend(id: string, message: string): void {
    for (const pending of this.pendingSends) {
      if (pending.id !== id || pending.message !== message) continue;
      this.pendingSends.delete(pending);
      return;
    }
  }

  /** Live view state for a target; creates (and may evict empty) entries. */
  view(id: string): FabricConversationStateEntry {
    const existing = this.entries.get(id);
    if (existing) {
      this.entries.delete(id);
      this.entries.set(id, existing);
      return existing;
    }
    const created: FabricConversationStateEntry = {
      draft: "",
      following: true,
      scroll: 0,
      pageAnchor: undefined,
      toolsExpanded: false,
      lastSeenUpdatedAt: 0,
    };
    this.entries.set(id, created);
    this.enforceLimit();
    return created;
  }

  /** Non-mutating lookup; unread checks must never create or evict drafts. */
  peek(id: string): FabricConversationStateEntry | undefined {
    return this.entries.get(id);
  }

  clear(): void {
    this.queues.clear();
    this.entries.clear();
    this.pendingSends.clear();
    this.selectedId = undefined;
    this.epochCounter++;
  }

  private enforceLimit(): void {
    while (this.entries.size > STATE_ENTRY_LIMIT) {
      let evicted = false;
      for (const key of this.entries.keys()) {
        if (key === this.selectedId) continue;
        const entry = this.entries.get(key);
        // Never evict non-empty drafts just because many targets were viewed.
        if (entry && entry.draft === "") {
          this.entries.delete(key);
          evicted = true;
          break;
        }
      }
      if (!evicted) break;
    }
  }
}

export interface FabricConversationOptions {
  targets: () => FabricConversationTarget[];
  initialTargetId?: string;
  state: FabricConversationState;
  transcript: (id: string, followLatest: boolean) => NativeConversationTranscript;
  loadOlder: (id: string) => boolean;
  loadNewer: (id: string) => boolean;
  loadLatest: (id: string) => boolean;
  send: (id: string, message: string, delivery: FabricConversationDelivery) => Promise<unknown>;
  stop: (id: string) => Promise<unknown>;
  close: () => void;
  keybindings?: Pick<KeybindingsManager, "matches" | "getKeys">;
  codePreviewSettings?: CodePreviewSettings;
  appearance?: FabricConversationAppearance;
  rendererOptions?: FabricConversationTranscriptRendererOptions | undefined;
  queueEvents?: { emit(channel: string, data: unknown): void } | undefined;
}

interface Feedback {
  text: string;
  kind: "info" | "error";
  at: number;
}

const FEEDBACK_TTL_MS = 8_000;
const FOLLOW_UP_FALLBACK: KeyId[] = ["alt+enter", "ctrl+q"];
const TOOLS_EXPAND_FALLBACK: KeyId[] = ["ctrl+o"];

const conversationEditorTheme = (theme: Theme, thinking: () => string | undefined): EditorTheme => ({
  borderColor: (value: string) => {
    const level = thinking();
    const color = level === "minimal" ? "thinkingMinimal" : level === "low" ? "thinkingLow"
      : level === "medium" ? "thinkingMedium" : level === "high" ? "thinkingHigh"
      : level === "xhigh" ? "thinkingXhigh" : level === "max" ? "thinkingMax" : "borderMuted";
    return theme.fg(color, value);
  },
  selectList: {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("muted", text),
    noMatch: (text: string) => theme.fg("muted", text),
  },
});

const errorText = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error ?? "");
};

const isMainTarget = (target: FabricConversationTarget | undefined): boolean =>
  target?.kind === "main";

interface PickerRow {
  target: FabricConversationTarget;
  depth: number;
}

export class FabricConversationView implements Component, Focusable {
  private focusState = true;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly options: FabricConversationOptions;
  private readonly state: FabricConversationState;
  private readonly renderer: FabricConversationTranscriptRenderer;
  private editor: Editor | undefined;
  private pickerInput: Input | undefined;
  private pickerRows: PickerRow[] = [];
  private pickerSelectedId: string | undefined;
  private mode: "conversation" | "picker" = "conversation";
  private currentId: string | undefined;
  private feedback: Feedback | undefined;
  private stopConfirmId: string | undefined;
  private disposed = false;
  private lastBodyLength = 0;
  private lastBody: string[] = [];
  private lastBodyBudget = 1;
  private editorTop = 0;
  private editorHeight = 0;
  private ownsMouseMode = false;

  constructor(
    tui: TUI,
    theme: Theme,
    options: FabricConversationOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.options = options;
    this.state = options.state;
    this.renderer = new FabricConversationTranscriptRenderer(tui, theme, {
      ...options.rendererOptions,
      imageWidthCells: options.appearance?.imageWidthCells,
    });
    this.editor = new Editor(tui, conversationEditorTheme(theme, () => this.currentTarget()?.thinking), {
      paddingX: options.appearance?.editorPaddingX ?? 0,
    });
    this.editor.focused = true;
    this.editor.onChange = (text) => {
      if (this.currentId && !this.state.queues.get(this.currentId)?.editingActive) this.state.view(this.currentId).draft = text;
    };
    // An explicit initialTargetId must win over state.selectedId so reissuing
    // "/fabric chat B" focuses B instead of reopening the previously selected A.
    const nonMain = this.nonMainTargets();
    const requested = options.initialTargetId ?? defaultConversationTarget(nonMain, options.state.selectedId)?.id;
    const requestedTarget = requested
      ? this.currentTargets().find((candidate) => candidate.id === requested)
      : undefined;
    const resolved =
      requested && requestedTarget && !isMainTarget(requestedTarget)
        ? requested
        : nonMain[0]?.id;
    if (resolved) this.applySelection(resolved, false);
    if (!this.currentId) this.currentId = nonMain[0]?.id;
    // Regular Pi leaves mouse input to terminal scrollback. This preview owns
    // a separate viewport; capture its wheel input and restore on close.
    if (tui.mode === "regular") {
      tui.terminal.write("\x1b[?1000h\x1b[?1006h");
      this.ownsMouseMode = true;
    }
  }

  get focused(): boolean {
    return this.focusState;
  }

  set focused(value: boolean) {
    this.focusState = value;
    if (this.mode === "picker") {
      if (this.pickerInput) this.pickerInput.focused = value;
      if (this.editor) this.editor.focused = false;
      return;
    }
    if (this.editor) this.editor.focused = value;
  }

  /** Re-focus a target while the view is open; selecting Main closes to the native session. */
  selectTarget(id: string): void {
    this.applySelection(id, true);
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    // Fullscreen Pi dispatches normalized events; regular mode forwards SGR.
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
    if (mouse) {
      const button = Number(mouse[1]);
      if ((button & 64) !== 0 && mouse[4] === "M") {
        this.handleMouse({ type: "wheel", button: "none", wheelDelta: (button & 1) === 0 ? -3 : 3,
          x: Number(mouse[2]) - 1, y: Number(mouse[3]) - 1, screenX: Number(mouse[2]) - 1, screenY: Number(mouse[3]) - 1,
          width: this.tui.terminal.columns, height: this.terminalRows(), shift: !!(button & 4), alt: !!(button & 8), ctrl: !!(button & 16) });
      }
      return;
    }
    if (this.mode === "picker") {
      this.handlePickerInput(data);
      this.tui.requestRender();
      return;
    }
    this.handleConversationInput(data);
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined;
    if (event.type === "wheel") {
      if (this.mode === "picker") this.movePickerSelection((event.wheelDelta ?? 0) < 0 ? -1 : 1);
      else this.scrollBy(event.wheelDelta ?? 0);
      this.tui.requestRender();
      return { handled: true };
    }
    if (this.mode === "conversation" && event.y >= this.editorTop && event.y < this.editorTop + this.editorHeight) {
      return this.editor?.handleMouse({ ...event, y: event.y - this.editorTop, height: this.editorHeight });
    }
    return undefined;
  }

  render(width: number): string[] {
    if (this.disposed || width <= 0) return [];
    const rows = Math.max(1, this.terminalRows());
    this.markCurrentTargetSeen();
    this.reconcileEditor();
    const target = this.currentTarget();
    const queue = this.mode === "conversation" ? this.currentQueue() : undefined;
    const transcriptLines = this.mode === "conversation" ? this.transcriptLines(width) : [];
    let queueLines = queue?.render(width) ?? [];
    // Native components own their interior padding. Giving them the full width
    // keeps user backgrounds and editor rules flush with both terminal edges.
    let editorLines = this.mode === "conversation" && !(queue?.editingActive && queue.mode === "extension") ? this.renderEditorLines(width) : [];
    const editorBudget = Math.min(editorLines.length, Math.max(1, rows - (rows >= 6 ? 3 : 0)));
    if (editorLines.length > editorBudget) {
      const cursor = Math.max(0, editorLines.findIndex((line) => line.includes(CURSOR_MARKER)));
      const start = Math.max(0, Math.min(cursor - Math.floor(editorBudget / 2), editorLines.length - editorBudget));
      editorLines = editorLines.slice(start, start + editorBudget);
    }
    let remaining = rows - editorLines.length;
    const footer = this.mode === "conversation"
      ? conversationFooter(target, this.theme, width).slice(0, Math.max(0, remaining - 1))
      : [];
    remaining -= footer.length;
    const head: string[] = [];
    if (remaining > 0) {
      head.push(this.breadcrumbLine(width));
      remaining--;
    }
    if (target?.readOnlyReason && remaining > 1) {
      head.push(this.statusLine(width));
      remaining--;
    }
    const feedback = this.currentFeedbackLine(width);
    if (feedback !== undefined && remaining > 1) {
      head.push(feedback);
      remaining--;
    }
    const hints = this.mode === "conversation" && remaining > 2 ? [this.hintsLine(width)] : [];
    remaining -= hints.length;
    const queueBudget = Math.max(0, remaining - 1);
    if (queueLines.length > queueBudget) {
      const cursor = queueLines.findIndex((line) => line.includes(CURSOR_MARKER));
      const start = Math.max(0, Math.min(cursor < 0 ? 0 : cursor - Math.floor(queueBudget / 2), queueLines.length - queueBudget));
      queueLines = queueLines.slice(start, start + queueBudget);
    }
    remaining -= queueLines.length;
    this.editorTop = rows - editorLines.length - footer.length - hints.length;
    this.editorHeight = editorLines.length;
    const body = remaining <= 0 ? [] : this.mode === "picker"
      ? this.pickerLines(width, remaining)
      : this.windowBody(transcriptLines, remaining);
    while (body.length < remaining) body.push("");
    return [...head, ...body.slice(0, remaining), ...queueLines, ...editorLines, ...footer, ...hints]
      .slice(0, rows)
      .map((line) => visibleWidth(line) <= width ? line : truncateToWidth(line, width, ""));
  }

  invalidate(): void {
    this.renderer.invalidate();
    this.editor?.invalidate();
    this.pickerInput?.invalidate();
  }

  dispose(): void {
    if (this.currentId) this.state.queues.detach(this.currentId);
    this.disposed = true;
    this.editor = undefined;
    this.pickerInput = undefined;
    this.renderer.dispose();
    if (this.ownsMouseMode) {
      this.ownsMouseMode = false;
      this.tui.terminal.write("\x1b[?1000l\x1b[?1006l");
    }
  }

  /** Keep the editor in sync with the shared session draft (e.g. after an ack
   * that landed while a previous view instance was disposed). */
  private reconcileEditor(): void {
    if (this.mode !== "conversation" || !this.editor || !this.currentId) return;
    if (this.state.queues.get(this.currentId)?.editingActive) return;
    if (this.state.hasPendingSend(this.currentId, this.editor.getText())) return;
    const draft = this.state.view(this.currentId).draft;
    if (this.editor.getText() !== draft) this.editor.setText(draft);
  }

  private applySelection(id: string, requestRender: boolean): void {
    if (this.currentId && this.currentId !== id) this.state.queues.detach(this.currentId);
    const target = this.currentTargets().find((candidate) => candidate.id === id);
    if (!target) {
      this.feedback = {
        text: `Unknown target ${safeText(id)}`,
        kind: "error",
        at: Date.now(),
      };
      if (requestRender) this.tui.requestRender();
      return;
    }
    if (isMainTarget(target)) {
      this.options.close();
      return;
    }
    this.currentId = id;
    this.state.selectedId = id;
    const entry = this.state.view(id);
    entry.lastSeenUpdatedAt = target.updatedAt ?? Date.now();
    this.stopConfirmId = undefined;
    this.closePicker();
    this.feedback = undefined;
    this.editor?.setText(entry.draft);
    if (requestRender) this.tui.requestRender();
  }

  private markCurrentTargetSeen(): void {
    if (!this.currentId) return;
    const target = this.targetById(this.currentId);
    if (!target?.updatedAt) return;
    const entry = this.state.view(this.currentId);
    if (entry.lastSeenUpdatedAt < target.updatedAt) entry.lastSeenUpdatedAt = target.updatedAt;
  }

  private currentTargets(): FabricConversationTarget[] {
    return this.options.targets();
  }

  private nonMainTargets(): FabricConversationTarget[] {
    return this.currentTargets().filter((target) => !isMainTarget(target));
  }

  private currentTarget(): FabricConversationTarget | undefined {
    return this.currentTargets().find((target) => target.id === this.currentId);
  }

  private mainTarget(): FabricConversationTarget | undefined {
    return this.currentTargets().find((target) => isMainTarget(target));
  }

  private targetById(id: string): FabricConversationTarget | undefined {
    return this.currentTargets().find((target) => target.id === id);
  }

  private terminalRows(): number {
    return this.tui.terminal?.rows ?? process.stdout.rows ?? 28;
  }

  /**
   * Respects a configured binding; when an injected manager reports no keys
   * the binding is unbound (never falls back), and only the default global
   * manager (no injection) falls back to hard-coded keys.
   */
  private bindingMatches(
    data: string,
    binding: "app.message.followUp" | "app.tools.expand" | "app.thinking.toggle",
    fallbackKeys: KeyId[],
  ): boolean {
    if (this.options.keybindings) {
      const keys = this.options.keybindings.getKeys(binding);
      return keys.length > 0 && this.options.keybindings.matches(data, binding);
    }
    const global = getKeybindings();
    const keys = global.getKeys(binding);
    if (keys.length > 0) return global.matches(data, binding);
    return fallbackKeys.some((key) => matchesKey(data, key));
  }

  private bindingHint(
    binding: "app.message.followUp" | "app.tools.expand" | "app.thinking.toggle",
    fallbackLabel: string,
  ): string {
    const manager = this.options.keybindings ?? getKeybindings();
    const keys = manager.getKeys(binding);
    if (keys.length > 0) return keys.join("/");
    return this.options.keybindings ? "unbound" : fallbackLabel;
  }

  private handleConversationInput(data: string): void {
    const editor = this.editor;
    if (!editor) return;
    this.feedback = undefined;
    if (this.stopConfirmId === undefined && this.currentQueue()?.handleInput(data)) return;

    if (this.stopConfirmId !== undefined) {
      if (matchesKey(data, Key.enter)) {
        const target = this.targetById(this.stopConfirmId);
        this.stopConfirmId = undefined;
        if (target) this.dispatchStop(target);
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.stopConfirmId = undefined;
        this.feedback = { text: "Stop cancelled", kind: "info", at: Date.now() };
        return;
      }
      this.stopConfirmId = undefined;
    }

    if (this.bindingMatches(data, "app.message.followUp", FOLLOW_UP_FALLBACK)) {
      this.submit("followUp");
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.submit("steer");
      return;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      if (editor.getText().length > 0) editor.setText("");
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.options.close();
      return;
    }
    if (matchesKey(data, Key.ctrl("n"))) {
      this.openPicker();
      return;
    }
    if (matchesKey(data, "ctrl+tab")) {
      this.cycleTarget(1);
      return;
    }
    if (matchesKey(data, "shift+ctrl+tab")) {
      this.cycleTarget(-1);
      return;
    }
    if (matchesKey(data, "ctrl+shift+left")) {
      this.navigateParent();
      return;
    }
    if (matchesKey(data, "ctrl+shift+right")) {
      this.navigateFirstChild();
      return;
    }
    if (matchesKey(data, "alt+left") && editor.getText().length === 0) {
      this.navigateParent();
      return;
    }
    if (matchesKey(data, "alt+right") && editor.getText().length === 0) {
      this.navigateFirstChild();
      return;
    }
    const viewportKeys = getKeybindings();
    if (viewportKeys.matches(data, "tui.altScreen.previousPrompt")) { this.scrollPrompt(-1); return; }
    if (viewportKeys.matches(data, "tui.altScreen.nextPrompt")) { this.scrollPrompt(1); return; }
    if (viewportKeys.matches(data, "tui.altScreen.lineUp")) { this.scrollBy(-1); return; }
    if (viewportKeys.matches(data, "tui.altScreen.lineDown")) { this.scrollBy(1); return; }
    if (viewportKeys.matches(data, "tui.altScreen.pageUp")) { this.scrollBy(-Math.max(1, this.lastBodyBudget - 2)); return; }
    if (viewportKeys.matches(data, "tui.altScreen.pageDown")) { this.scrollBy(Math.max(1, this.lastBodyBudget - 2)); return; }
    if (viewportKeys.matches(data, "tui.altScreen.halfPageUp")) { this.scrollBy(-Math.max(1, Math.floor(this.lastBodyBudget / 2))); return; }
    if (viewportKeys.matches(data, "tui.altScreen.halfPageDown")) { this.scrollBy(Math.max(1, Math.floor(this.lastBodyBudget / 2))); return; }
    if (viewportKeys.matches(data, "tui.altScreen.top")) { this.scrollToTop(); return; }
    if (viewportKeys.matches(data, "tui.altScreen.bottom")) { this.followLatest(); return; }
    if (this.bindingMatches(data, "app.thinking.toggle", ["ctrl+t"])) {
      if (this.currentId) {
        const entry = this.state.view(this.currentId);
        entry.hideThinking = !(entry.hideThinking ?? this.options.appearance?.hideThinkingBlock ?? false);
      }
      return;
    }
    if (this.bindingMatches(data, "app.tools.expand", TOOLS_EXPAND_FALLBACK)) {
      if (this.currentId) {
        const entry = this.state.view(this.currentId);
        entry.toolsExpanded = !entry.toolsExpanded;
      }
      return;
    }
    editor.handleInput(data);
  }

  private submit(delivery: FabricConversationDelivery): void {
    const editor = this.editor;
    const target = this.currentTarget();
    if (!editor || !target || isMainTarget(target)) return;
    const raw = editor.getText();
    if (!raw.trim()) return;

    if (raw.trim() === "/back") {
      this.options.close();
      return;
    }
    if (raw.trim() === "/agents") {
      this.openPicker();
      return;
    }
    if (raw.trim() === "/stop") {
      if (!target.canStop) {
        this.feedback = {
          text: safeText(
            `Stop unavailable for ${target.name}: the selected target cannot be stopped from here.`,
          ),
          kind: "error",
          at: Date.now(),
        };
        return;
      }
      this.stopConfirmId = target.id;
      this.feedback = {
        text: safeText(`Press enter again to stop ${target.name} · esc cancels`),
        kind: "info",
        at: Date.now(),
      };
      return;
    }
    if (raw.trim().startsWith("/") || raw.trim().startsWith("!")) {
      this.feedback = {
        text: safeText(
          `Unsupported command "${raw.trim()}" is not forwarded from this view. Supported: /stop /back /agents.`,
        ),
        kind: "error",
        at: Date.now(),
      };
      return;
    }
    if (target.readOnlyReason) {
      this.feedback = {
        text: safeText(`${target.name} is read-only: ${target.readOnlyReason}`),
        kind: "error",
        at: Date.now(),
      };
      return;
    }
    if (delivery === "steer" && !target.canSteer) {
      this.feedback = {
        text: safeText(`${target.name} does not accept steering messages right now.`),
        kind: "error",
        at: Date.now(),
      };
      return;
    }
    if (delivery === "followUp" && !target.canFollowUp) {
      this.feedback = {
        text: safeText(`${target.name} does not accept follow-up messages right now.`),
        kind: "error",
        at: Date.now(),
      };
      return;
    }
    const queue = this.currentQueue();
    if (!queue) return;
    this.state.queues.sync(target.id, this.options.transcript(target.id, true));
    if (queue.mode === "extension" && delivery === "followUp" && !isActiveStatus(target.status)) {
      const parked = queue.park(raw, delivery);
      if (parked.ok) { this.state.view(target.id).draft = ""; editor.setText(""); }
      return;
    }
    // Session-owned pending marker: blocks duplicate submission of the same
    // raw draft for the same target across view close/reopen.
    if (this.state.hasPendingSend(target.id, raw)) return;
    const pending: FabricConversationPendingSend = { id: target.id, message: raw, delivery };
    this.state.addPendingSend(pending);
    const epoch = this.state.epoch;
    this.feedback = {
      text: safeText(`Sending ${delivery} → ${target.name}…`),
      kind: "info",
      at: Date.now(),
    };
    void Promise.resolve()
      .then(() => queue.dispatch(raw, delivery))
      .then(() => {
        // Same-session acks mutate shared state even if this view was closed;
        // only a session clear (epoch change) invalidates the result.
        if (this.state.epoch !== epoch) return;
        this.state.resolvePendingSend(target.id, raw);
        if (this.disposed) return;
        if (this.currentId === target.id && this.editor?.getText() === raw) {
          this.editor.setText("");
        }
        this.feedback = {
          text: safeText(`Queued ${delivery} → ${target.name}`),
          kind: "info",
          at: Date.now(),
        };
        this.tui.requestRender();
      })
      .catch((error: unknown) => {
        if (this.state.epoch !== epoch) return;
        this.state.failPendingSend(target.id, raw);
        if (this.disposed) return;
        // Keep the raw draft including whitespace and any newer editing; never merge.
        this.feedback = {
          text: safeText(
            `Send failed for ${target.name} (${delivery}): ${errorText(error)}`,
          ),
          kind: "error",
          at: Date.now(),
        };
        this.tui.requestRender();
      });
  }

  private dispatchStop(target: FabricConversationTarget): void {
    const epoch = this.state.epoch;
    this.feedback = {
      text: safeText(`Stopping ${target.name}…`),
      kind: "info",
      at: Date.now(),
    };
    void Promise.resolve()
      .then(() => this.options.stop(target.id))
      .then(() => {
        if (this.disposed || epoch !== this.state.epoch) return;
        this.feedback = {
          text: safeText(`Stop requested for ${target.name}`),
          kind: "info",
          at: Date.now(),
        };
        this.tui.requestRender();
      })
      .catch((error: unknown) => {
        if (this.disposed || epoch !== this.state.epoch) return;
        this.feedback = {
          text: safeText(`Stop failed for ${target.name}: ${errorText(error)}`),
          kind: "error",
          at: Date.now(),
        };
        this.tui.requestRender();
      });
  }

  private navigateParent(): void {
    const target = this.currentTarget();
    if (!target) return;
    const parent = target.parentId ? this.targetById(target.parentId) : undefined;
    if (parent && !isMainTarget(parent)) {
      this.applySelection(parent.id, true);
      return;
    }
    this.options.close();
  }

  private navigateFirstChild(): void {
    const target = this.currentTarget();
    if (!target) return;
    const child = this.currentTargets().find((candidate) => candidate.parentId === target.id);
    if (child && !isMainTarget(child)) this.applySelection(child.id, true);
  }

  private cycleTarget(direction: 1 | -1): void {
    const targets = this.nonMainTargets();
    if (targets.length === 0) return;
    const index = targets.findIndex((target) => target.id === this.currentId);
    const nextIndex = index < 0
      ? 0
      : (index + direction + targets.length) % targets.length;
    const next = targets[nextIndex];
    if (next) this.applySelection(next.id, true);
  }

  private scrollBy(delta: number): void {
    if (!this.currentId || !Number.isFinite(delta) || delta === 0) return;
    const entry = this.state.view(this.currentId);
    const maxScroll = Math.max(0, this.lastBodyLength - this.lastBodyBudget);
    const position = entry.following ? maxScroll : entry.scroll;
    const next = position + Math.trunc(delta);
    entry.following = false;
    if (next < 0 && this.options.loadOlder(this.currentId)) {
      // Native history pages prepend records instead of replacing the tail.
      // Preserve the old viewport anchor, then apply the requested movement.
      entry.pageAnchor = "prepend";
      entry.anchorLength = this.lastBodyLength;
      entry.scroll = next;
      return;
    }
    if (next > maxScroll && this.options.loadNewer(this.currentId)) {
      entry.scroll = next;
      return;
    }
    entry.scroll = Math.max(0, Math.min(next, maxScroll));
    if (delta > 0 && entry.scroll === maxScroll) entry.following = true;
  }

  private scrollPrompt(direction: -1 | 1): void {
    if (!this.currentId) return;
    const entry = this.state.view(this.currentId);
    const position = entry.following ? Math.max(0, this.lastBodyLength - this.lastBodyBudget) : entry.scroll;
    const prompts = this.lastBody.flatMap((line, index) => line.includes("\x1b]133;A") ? [index] : []);
    const target = direction < 0 ? prompts.filter((row) => row < position).at(-1) : prompts.find((row) => row > position);
    this.scrollBy(target === undefined ? direction * Math.max(1, this.lastBodyBudget) : target - position);
  }

  private scrollToTop(): void {
    if (!this.currentId) return;
    const entry = this.state.view(this.currentId);
    entry.following = false;
    entry.scroll = 0;
    if (this.options.loadOlder(this.currentId)) entry.pageAnchor = "start";
  }

  private followLatest(): void {
    if (!this.currentId) return;
    this.options.loadLatest(this.currentId);
    const entry = this.state.view(this.currentId);
    entry.following = true;
    entry.pageAnchor = undefined;
    entry.anchorLength = undefined;
  }

  private openPicker(): void {
    this.mode = "picker";
    this.pickerInput = new Input({ prompt: "search targets: " });
    this.pickerInput.focused = this.focusState;
    this.pickerInput.onSubmit = () => this.pickSelected();
    if (this.editor) this.editor.focused = false;
    this.pickerSelectedId = this.currentId ?? this.nonMainTargets()[0]?.id;
    this.refreshPicker();
  }

  private closePicker(): void {
    this.mode = "conversation";
    this.pickerInput = undefined;
    this.pickerRows = [];
    this.pickerSelectedId = undefined;
    if (this.editor) this.editor.focused = this.focusState;
  }

  private refreshPicker(): void {
    const search = this.pickerInput?.getValue() ?? "";
    const rows: PickerRow[] = [];
    const targets = this.currentTargets();
    const byId = new Map(targets.map((target) => [target.id, target]));
    const roots = targets.filter(
      (target) => !target.parentId || !byId.has(target.parentId),
    );
    roots.sort((left, right) =>
      Number(isMainTarget(right)) - Number(isMainTarget(left)),
    );
    const visited = new Set<string>();
    const pushTree = (target: FabricConversationTarget, depth: number): void => {
      if (visited.has(target.id)) return;
      visited.add(target.id);
      rows.push({ target, depth });
      for (const child of targets) {
        if (child.parentId === target.id) pushTree(child, depth + 1);
      }
    };
    for (const root of roots) pushTree(root, 0);
    for (const orphan of targets) {
      if (!visited.has(orphan.id)) rows.push({ target: orphan, depth: 0 });
    }
    const filtered = search.trim()
      ? fuzzyFilter(rows, search, (row) => `${row.target.kind} ${row.target.name} ${row.target.id}`)
      : rows;
    this.pickerRows = filtered;
    // Selection identity is the target id, stable across roster updates.
    if (!filtered.some((row) => row.target.id === this.pickerSelectedId)) {
      this.pickerSelectedId = filtered[0]?.target.id;
    }
  }

  private pickerSelectedIndex(): number {
    const index = this.pickerRows.findIndex((row) => row.target.id === this.pickerSelectedId);
    return index >= 0 ? index : 0;
  }

  private movePickerSelection(direction: 1 | -1): void {
    if (this.pickerRows.length === 0) return;
    const index = this.pickerSelectedIndex();
    const next = (index + direction + this.pickerRows.length) % this.pickerRows.length;
    this.pickerSelectedId = this.pickerRows[next]?.target.id;
  }

  private pickSelected(): void {
    const row = this.pickerRows.find((candidate) => candidate.target.id === this.pickerSelectedId) ??
      this.pickerRows[0];
    if (!row) {
      this.closePicker();
      return;
    }
    if (isMainTarget(row.target)) {
      this.options.close();
      return;
    }
    this.applySelection(row.target.id, true);
  }

  private handlePickerInput(data: string): void {
    const input = this.pickerInput;
    if (!input) {
      this.closePicker();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.closePicker();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.movePickerSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.movePickerSelection(1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.pickSelected();
      return;
    }
    input.handleInput(data);
    this.refreshPicker();
  }

  private isUnread(target: FabricConversationTarget): boolean {
    if (target.updatedAt === undefined || target.id === this.currentId) return false;
    // peek() only: listing targets must never create or evict drafts.
    const seen = this.state.peek(target.id)?.lastSeenUpdatedAt ?? 0;
    return target.updatedAt > seen;
  }

  private breadcrumbLine(width: number): string {
    const chain: FabricConversationTarget[] = [];
    let cursor = this.currentTarget();
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor.id)) {
      guard.add(cursor.id);
      chain.unshift(cursor);
      cursor = cursor.parentId ? this.targetById(cursor.parentId) : undefined;
    }
    if (chain.length === 0) {
      const main = this.mainTarget();
      if (main) chain.push(main);
    }
    if (chain.length === 0) return truncateToWidth(this.theme.fg("dim", "Fabric"), width, "");
    const last = chain[chain.length - 1];
    const parts = chain.map((target, index) => {
      const isCurrent = target.id === this.currentId;
      const name = isMainTarget(target) ? "Main" : safeText(target.name) || target.id;
      const styled = isCurrent
        ? this.theme.fg("accent", name)
        : this.theme.fg("muted", name);
      return last && index === chain.length - 1 && this.isUnread(last)
        ? `${styled} ●`
        : styled;
    });
    return truncateToWidth(parts.join(this.theme.fg("dim", " > ")), width, "");
  }

  private statusLine(width: number): string {
    const target = this.currentTarget();
    if (!target) return "";
    const parts = [
      this.theme.fg("muted", target.kind),
      colorizeStatus(this.theme, target.status),
    ];
    if (target.runner) parts.push(this.theme.fg("muted", safeText(target.runner)));
    if (target.model) parts.push(this.theme.fg("muted", safeText(target.model)));
    if (target.thinking) parts.push(this.theme.fg("muted", `thinking:${safeText(target.thinking)}`));
    if (target.readOnlyReason) {
      parts.push(this.theme.fg("warning", safeText(`read-only: ${target.readOnlyReason}`)));
    }
    return truncateToWidth(parts.join(this.theme.fg("dim", " · ")), width, "");
  }

  private currentFeedbackLine(width: number): string | undefined {
    if (this.mode === "picker") return undefined;
    if (!this.feedback) return undefined;
    if (Date.now() - this.feedback.at > FEEDBACK_TTL_MS) return undefined;
    const color = this.feedback.kind === "error" ? "error" : "accent";
    return truncateToWidth(this.theme.fg(color, this.feedback.text), width, "");
  }

  private hintsLine(width: number): string {
    const followUpKeys = this.bindingHint("app.message.followUp", "alt+enter");
    const toolsKeys = this.bindingHint("app.tools.expand", "ctrl+o");
    const hints = this.stopConfirmId !== undefined
      ? [this.theme.fg("warning", safeText("enter confirms stop · esc cancels"))]
      : [
          this.theme.fg("dim", "enter"),
          "steer",
          this.theme.fg("dim", followUpKeys),
          "follow-up",
          this.theme.fg("dim", "ctrl+n"),
          "targets",
          this.theme.fg("dim", "pgup/pgdn"),
          "scroll",
          this.theme.fg("dim", "esc"),
          "close",
        ];
    const full = [...hints, this.theme.fg("dim", toolsKeys), "tools"].join(" ");
    return truncateToWidth(full, width, "");
  }

  private renderEditorLines(innerWidth: number): string[] {
    const editor = this.editor;
    if (!editor) return [];
    return editor.render(innerWidth);
  }

  private currentQueue(): ConversationQueue | undefined {
    const target = this.currentTarget();
    if (!target || target.kind === "main" || !this.editor || this.disposed) return undefined;
    return this.state.queues.attach({
      targetId: target.id, targetName: target.name,
      piEvents: this.options.queueEvents ?? { emit() {} }, theme: this.theme,
      send: (message, delivery) => this.options.send(target.id, message, delivery),
      editor: {
        getText: () => this.editor?.getText() ?? "",
        setText: (text) => this.editor?.setText(text),
        handleInput: (data) => this.editor?.handleInput(data),
        render: (width) => this.editor?.render(width) ?? [],
        paddingX: this.options.appearance?.editorPaddingX ?? 0,
      },
      ...(this.options.keybindings ? { keybindings: this.options.keybindings } : {}),
      isIdle: () => !isActiveStatus(this.targetById(target.id)?.status ?? "stopped"),
      onNotify: (text, kind) => {
        if (kind === "error" && !this.disposed && this.currentId === target.id) this.feedback = { text: safeText(text), kind, at: Date.now() };
      },
      requestRender: () => { if (!this.disposed && this.currentId === target.id) this.tui.requestRender(); },
    });
  }

  private transcriptLines(innerWidth: number): string[] {
    const target = this.currentTarget();
    if (!target || !this.currentId) return [this.theme.fg("dim", "No target selected.")];
    const entry = this.state.view(this.currentId);
    const transcript = this.options.transcript(this.currentId, entry.following);
    this.state.queues.sync(this.currentId, transcript);
    return this.renderer.render(transcript, innerWidth, {
      target,
      toolsExpanded: entry.toolsExpanded,
      hideThinking: entry.hideThinking ?? this.options.appearance?.hideThinkingBlock ?? false,
      showImages: this.options.appearance?.showImages ?? true,
      outputPad: this.options.appearance?.outputPad ?? 1,
      ...(this.options.appearance?.codeBlockIndent !== undefined ? { codeBlockIndent: this.options.appearance.codeBlockIndent } : {}),
      codePreviewSettings: this.options.codePreviewSettings,
    });
  }

  private windowBody(body: string[], budget: number): string[] {
    this.lastBodyLength = body.length;
    this.lastBody = body;
    this.lastBodyBudget = budget;
    const entry = this.currentId ? this.state.view(this.currentId) : undefined;
    if (!entry) return body.slice(0, Math.max(0, budget));
    const maxScroll = Math.max(0, body.length - budget);
    if (entry.following) {
      entry.scroll = maxScroll;
    } else if (entry.pageAnchor) {
      entry.scroll = entry.pageAnchor === "prepend"
        ? entry.scroll + Math.max(0, body.length - (entry.anchorLength ?? body.length))
        : entry.pageAnchor === "end" ? maxScroll : 0;
      entry.pageAnchor = undefined;
      entry.anchorLength = undefined;
    }
    entry.scroll = Math.max(0, Math.min(entry.scroll, maxScroll));
    return body.slice(entry.scroll, entry.scroll + budget);
  }

  private pickerLines(innerWidth: number, budget: number): string[] {
    // Independent viewport: the picker never reads or writes the selected
    // target's transcript scroll/follow state.
    this.refreshPicker();
    const lines = [this.theme.fg("accent", "Targets · enter select · esc cancel")];
    const input = this.pickerInput;
    if (input) {
      for (const line of input.render(innerWidth)) lines.push(line);
    }
    const rows = this.pickerRows;
    const selectedIndex = this.pickerSelectedIndex();
    const listBudget = Math.max(1, budget - lines.length - 1);
    const startIndex = Math.max(
      0,
      Math.min(selectedIndex - Math.floor(listBudget / 2), rows.length - listBudget),
    );
    const endIndex = Math.min(startIndex + listBudget, rows.length);
    if (rows.length === 0) lines.push(this.theme.fg("muted", "  no matching targets"));
    for (let i = startIndex; i < endIndex; i++) {
      const row = rows[i];
      if (!row) continue;
      const selected = row.target.id === this.pickerSelectedId;
      const indent = "  ".repeat(row.depth + 1);
      const marker = selected ? this.theme.fg("accent", "→ ") : "  ";
      const unread = this.isUnread(row.target) ? this.theme.fg("accent", " ●") : "";
      const label = isMainTarget(row.target)
        ? "Main (native session)"
        : `${safeText(row.target.name)} ${this.theme.fg("muted", `(${row.target.kind} · ${row.target.status})`)}`;
      lines.push(
        truncateToWidth(
          `${indent}${marker}${selected ? this.theme.fg("accent", label) : label}${unread}`,
          innerWidth,
          "",
        ),
      );
    }
    if (rows.length > listBudget) {
      lines.push(this.theme.fg("muted", `  (${selectedIndex + 1}/${rows.length})`));
    }
    return lines.slice(0, budget);
  }
}

const colorizeStatus = (theme: Theme, status: string): string => {
  if (status === "completed" || status === "done") return theme.fg("success", status);
  if (status === "failed" || status === "error" || status === "timed_out") {
    return theme.fg("error", status);
  }
  if (status === "running" || status === "in_progress" || status === "active") {
    return theme.fg("accent", status);
  }
  return theme.fg("muted", status);
};
