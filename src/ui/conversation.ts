import { getConversationHost } from "./conversation-host.js";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, KeyId, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
  CURSOR_MARKER,
  Editor,
  fuzzyFilter,
  getKeybindings,
  Input,
  Key,
  Loader,
  Text,
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
import { ConversationTextSelection } from "./conversation-selection.js";
import { appendConversationPrompt, conversationPromptHistory } from "./conversation-history.js";
import { conversationAssistantText, conversationCommandCompletion, CONVERSATION_COMMAND_HELP } from "./conversation-commands.js";
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
  /** Session-local composer history, oldest first; lazily seeded, like Pi. */
  promptHistory?: string[];
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
        // Only discard untouched lightweight navigation state. Pinned scroll,
        // loaded-page anchors, queues and in-flight sends outlive reader suspension.
        if (entry && entry.draft === "" && entry.following && !entry.pageAnchor &&
          !entry.toolsExpanded && entry.hideThinking === undefined &&
          !this.queues.get(key) && ![...this.pendingSends].some((pending) => pending.id === key)) {
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
  copyToClipboard?: (text: string) => Promise<void>;
  onTargetChange?: (id: string) => void;
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
  private suspendedEditor: Editor | undefined;
  private editorEpoch = -1;
  private pickerInput: Input | undefined;
  private pickerRows: PickerRow[] = [];
  private pickerSelectedId: string | undefined;
  private mode: "conversation" | "picker" = "conversation";
  private currentId: string | undefined;
  private feedback: Feedback | undefined;
  private commandNotification: { component: Text; epoch: number; pendingResult?: Text } | undefined;
  private notificationScope = 0;
  private stopConfirmId: string | undefined;
  private disposed = false;
  private lastBodyLength = 0;
  private lastBody: string[] = [];
  private lastBodyBudget = 1;
  private editorTop = 0;
  private editorHeight = 0;
  private ownsMouseMode = false;
  private targets: FabricConversationTarget[] = [];
  private targetsKey = "";
  private readonly targetsById = new Map<string, FabricConversationTarget>();
  private nonMain: FabricConversationTarget[] = [];
  private main: FabricConversationTarget | undefined;
  private observationKey = "";
  private observedTranscript: NativeConversationTranscript | undefined;
  private pickerKey = "";
  private working: Loader | undefined;
  private workingTargetId: string | undefined;
  private readonly textSelection = new ConversationTextSelection();
  private selectionWidth = 0;
  private selectionWasFollowing = false;
  private bodyTop = 0;
  private bodyHeight = 0;
  private copyVersion = 0;
  private copyTask: Promise<void> = Promise.resolve();

  constructor(
    tui: TUI,
    theme: Theme,
    options: FabricConversationOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.options = options;
    this.state = options.state;
    this.updateTargets();
    this.renderer = new FabricConversationTranscriptRenderer(tui, theme, {
      ...options.rendererOptions,
      imageWidthCells: options.appearance?.imageWidthCells,
    });
    this.editor = this.createEditor();
    this.editorEpoch = this.state.epoch;
    // An explicit initialTargetId must win over state.selectedId so reissuing
    // "/fabric chat B" focuses B instead of reopening the previously selected A.
    const nonMain = this.nonMainTargets();
    const requested = options.initialTargetId ?? defaultConversationTarget(nonMain, options.state.selectedId)?.id;
    const requestedTarget = requested
      ? this.targetById(requested)
      : undefined;
    const resolved =
      requested && requestedTarget && !isMainTarget(requestedTarget)
        ? requested
        : nonMain[0]?.id;
    if (resolved) this.applySelection(resolved, false);
    if (!this.currentId) this.currentId = nonMain[0]?.id;
    // Regular Pi leaves mouse input to terminal scrollback. This preview owns
    // a separate viewport; capture wheel and drag input and restore on close.
    if (tui.mode === "regular") {
      tui.terminal.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
      this.ownsMouseMode = true;
    }
  }

  private createEditor(withHistory = true): Editor {
    // Own method only: assignment through Pi's live proxy would mutate Main.
    const editorTui = Object.create(this.tui, { requestRender: { value: () => {
      if (!this.disposed && this.editor === editor) this.tui.requestRender();
    } } }) as TUI;
    const editor = new Editor(editorTui, conversationEditorTheme(this.theme, () => this.currentTarget()?.thinking), {
      paddingX: this.options.appearance?.editorPaddingX ?? 0,
    });
    editor.focused = this.focusState && this.mode === "conversation";
    if (!withHistory) return editor;
    editor.setAutocompleteProvider(conversationCommandCompletion(() =>
      !this.disposed && this.editor === editor && this.mode === "conversation" && !this.state.queues.get(this.currentId ?? "")?.editingActive));
    editor.onSubmit = (text) => {
      if (this.disposed || this.editor !== editor) return;
      // Native completion submits after clearing the editor; restore for routing.
      editor.setText(text);
      this.submit("steer");
    };
    editor.onChange = (text) => {
      if (this.editor === editor && this.currentId && !this.state.queues.get(this.currentId)?.editingActive) this.state.view(this.currentId).draft = text;
    };
    for (const text of this.currentId ? this.state.peek(this.currentId)?.promptHistory ?? [] : []) editor.addToHistory(text);
    return editor;
  }

  private releaseEditor(editor: Editor | undefined): void {
    if (!editor) return;
    editor.setAutocompleteProvider(conversationCommandCompletion(() => false));
    editor.focused = false;
    delete editor.onSubmit;
    delete editor.onChange;
  }

  private resetEditor(): void {
    this.releaseEditor(this.editor);
    this.releaseEditor(this.suspendedEditor);
    this.suspendedEditor = undefined;
    this.editor = this.createEditor();
    this.editorEpoch = this.state.epoch;
  }

  private ensureEditorEpoch(): void {
    if (this.editorEpoch === this.state.epoch) return;
    this.observedTranscript = undefined;
    this.observationKey = "";
    this.resetEditor();
    if (this.currentId) this.editor?.setText(this.state.view(this.currentId).draft);
  }

  private initializePromptHistory(): void {
    if (!this.currentId || !this.editor || this.suspendedEditor) return;
    const entry = this.state.view(this.currentId);
    if (entry.promptHistory !== undefined) return;
    const transcript = this.observedTranscript ?? this.options.transcript(this.currentId, entry.following);
    // A worker may not have written its initial transcript yet; retry later.
    if (transcript.unavailable) return;
    entry.promptHistory = conversationPromptHistory(transcript);
    for (const text of entry.promptHistory) this.editor.addToHistory(text);
  }

  private rememberPrompt(text: string): void {
    if (!this.currentId) return;
    this.initializePromptHistory();
    const entry = this.state.view(this.currentId);
    appendConversationPrompt(entry.promptHistory ??= [], text);
    this.editor?.addToHistory(text);
  }

  private setQueueEditorText(text: string): void {
    let restoredText = text;
    const editing = this.currentId && this.state.queues.get(this.currentId)?.editingActive;
    if (editing && !this.suspendedEditor) {
      // Preserve the composer's native history/draft; queued rows never browse it.
      this.suspendedEditor = this.editor;
      if (this.suspendedEditor) this.suspendedEditor.focused = false;
      this.editor = this.createEditor(false);
    } else if (!editing && this.suspendedEditor) {
      this.releaseEditor(this.editor);
      this.editor = this.suspendedEditor;
      this.suspendedEditor = undefined;
      this.editor.focused = this.focusState && this.mode === "conversation";
      // An acknowledgement may have cleared the composer while a row was open.
      restoredText = this.currentId ? this.state.view(this.currentId).draft : text;
    }
    this.editor?.setText(restoredText);
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
    this.updateTargets();
    this.applySelection(id, true);
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    this.ensureEditorEpoch();
    this.updateTargets();
    // Fullscreen Pi dispatches normalized events; regular mode forwards SGR.
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
    if (mouse) {
      const button = Number(mouse[1]);
      const wheel = (button & 64) !== 0;
      const release = mouse[4] === "m" || (!wheel && (button & 3) === 3 && !(button & 32));
      this.handleMouse({ type: wheel ? "wheel" : release ? "release" : (button & 32) ? "drag" : "press",
        button: wheel ? "none" : (button & 3) === 0 ? "left" : (button & 3) === 1 ? "middle" : (button & 3) === 2 ? "right" : "none",
        ...(wheel ? { wheelDelta: (button & 1) === 0 ? -3 : 3 } : {}),
        x: Number(mouse[2]) - 1, y: Number(mouse[3]) - 1, screenX: Number(mouse[2]) - 1, screenY: Number(mouse[3]) - 1,
        width: this.tui.terminal.columns, height: this.terminalRows(), shift: !!(button & 4), alt: !!(button & 8), ctrl: !!(button & 16) });
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
    this.ensureEditorEpoch();
    this.updateTargets();
    if (event.type === "wheel") {
      if (this.mode === "picker") this.movePickerSelection((event.wheelDelta ?? 0) < 0 ? -1 : 1);
      else this.scrollBy(event.wheelDelta ?? 0);
      this.tui.requestRender();
      return { handled: true };
    }
    if (this.mode !== "conversation" || !this.currentId) return { handled: true };
    const entry = this.state.view(this.currentId);
    const inBody = event.y >= this.bodyTop && event.y < this.bodyTop + this.bodyHeight;
    const row = entry.scroll + Math.max(0, Math.min(this.bodyHeight - 1, event.y - this.bodyTop));
    if (event.type === "press" && event.button === "left" && inBody) {
      this.selectionWasFollowing = entry.following;
      entry.following = false;
      this.textSelection.start(this.lastBody, row, event.x);
      this.tui.requestRender();
      return { handled: true, capture: true };
    }
    if (this.textSelection.dragging && (event.type === "drag" || event.type === "release")) {
      if (event.type === "drag") this.textSelection.move(row, event.x);
      else {
        this.textSelection.finish(row, event.x);
        if (!this.textSelection.active && this.selectionWasFollowing) entry.following = true;
        if (this.textSelection.active && (this.options.appearance?.copyOnSelect ?? true)) this.copySelection();
      }
      this.tui.requestRender();
      return { handled: true, render: true };
    }
    if (event.type === "press") this.textSelection.clear();
    if (event.y >= this.editorTop && event.y < this.editorTop + this.editorHeight) {
      return this.editor?.handleMouse({ ...event, y: event.y - this.editorTop, height: this.editorHeight }) ?? { handled: true };
    }
    // Never fall back to the host's selection or paste handlers behind an overlay.
    return { handled: true };
  }

  render(width: number): string[] {
    if (this.disposed || width <= 0) return [];
    this.updateTargets();
    if (width !== this.selectionWidth) {
      this.textSelection.clear();
      this.selectionWidth = width;
    }
    const rows = Math.max(1, this.terminalRows());
    this.markCurrentTargetSeen();
    this.reconcileEditor();
    const target = this.currentTarget();
    const queue = this.mode === "conversation" ? this.currentQueue() : undefined;
    this.observe();
    const liveTranscriptLines = this.mode === "conversation" ? this.transcriptLines(width) : [];
    const transcriptLines = this.textSelection.source ?? liveTranscriptLines;
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
      : this.windowBody(transcriptLines, remaining, this.transcriptTail(width, remaining));
    this.bodyTop = head.length;
    const scroll = this.currentId ? this.state.view(this.currentId).scroll : 0;
    this.bodyHeight = this.mode === "conversation" ? Math.max(0, Math.min(remaining, this.lastBody.length - scroll)) : 0;
    if (this.textSelection.active) {
      for (let row = 0; row < this.bodyHeight; row++) body[row] = this.textSelection.highlight(body[row]!, scroll + row, this.theme);
    }
    while (body.length < remaining) body.push("");
    return [...head, ...body.slice(0, remaining), ...queueLines, ...editorLines, ...footer, ...hints]
      .slice(0, rows)
      .map((line) => visibleWidth(line) <= width ? line : truncateToWidth(line, width, ""));
  }

  /** Observe files without rendering native history; true means a visible change
   * or a live animation still needs the normal TUI render path. */
  refresh(): boolean {
    if (this.disposed) return false;
    this.updateTargets();
    const changed = this.observe();
    return changed || (this.mode === "conversation" && this.selectedTargetIsWorking());
  }

  private observe(): boolean {
    const entry = this.currentId ? this.state.view(this.currentId) : undefined;
    const transcript = this.mode === "conversation" && this.currentTarget() && this.currentId && entry
      ? this.options.transcript(this.currentId, entry.following) : undefined;
    if (transcript && this.currentId) this.state.queues.sync(this.currentId, transcript);
    const key = JSON.stringify([this.targetsKey, this.currentId, this.mode, entry?.draft,
      this.feedback && Date.now() - this.feedback.at <= FEEDBACK_TTL_MS ? this.feedback : undefined,
      transcript && [transcript.sourceId, transcript.sessionId, transcript.sessionFile, transcript.eventsFile,
        transcript.revision, transcript.status, transcript.leafId, transcript.historyComplete, transcript.hasMore,
        transcript.hasNewer, transcript.unavailable, transcript.error, transcript.pendingMessages]]);
    const previous = this.observedTranscript;
    const changed = key !== this.observationKey || previous?.messages !== transcript?.messages ||
      previous?.entries !== transcript?.entries || previous?.streaming !== transcript?.streaming;
    this.observationKey = key;
    this.observedTranscript = transcript;
    this.syncWorkingIndicator();
    return changed;
  }

  private selectedTargetIsWorking(): boolean {
    const target = this.currentTarget();
    if (!target || target.stale) return false;
    // A killed worker can leave a partial message/tool in its log forever.
    // That retained tail must not override terminal or unavailable ownership.
    return isActiveStatus(target.status);
  }

  private syncWorkingIndicator(): void {
    const active = !this.disposed && this.mode === "conversation" && this.currentId && this.selectedTargetIsWorking();
    if (!active) {
      this.stopWorkingIndicator();
      return;
    }
    if (this.working && this.workingTargetId === this.currentId) return;
    this.stopWorkingIndicator();
    const id = this.currentId;
    this.workingTargetId = id;
    // Pi's standalone WorkingStatusIndicator delegates to this public Loader.
    this.working = new Loader({ requestRender: () => {
      if (!this.disposed && this.mode === "conversation" && this.currentId === id) this.tui.requestRender();
    } } as TUI, (text) => this.theme.fg("accent", text), (text) => this.theme.fg("muted", text), "Working");
  }

  private stopWorkingIndicator(): void {
    this.working?.stop();
    this.working = undefined;
    this.workingTargetId = undefined;
  }

  invalidate(): void {
    this.working?.invalidate();
    this.commandNotification?.component.invalidate();
    this.commandNotification?.pendingResult?.invalidate();
    this.renderer.invalidate();
    this.editor?.invalidate();
    this.pickerInput?.invalidate();
  }

  dispose(): void {
    if (this.currentId) this.state.queues.detach(this.currentId);
    this.disposed = true;
    this.clearCommandNotification();
    this.copyVersion++;
    this.textSelection.clear();
    this.stopWorkingIndicator();
    this.releaseEditor(this.editor);
    this.releaseEditor(this.suspendedEditor);
    this.suspendedEditor = undefined;
    this.editor = undefined;
    this.pickerInput = undefined;
    this.observedTranscript = undefined;
    this.lastBody = [];
    this.renderer.dispose();
    if (this.ownsMouseMode) {
      this.ownsMouseMode = false;
      this.tui.terminal.write("\x1b[?1002l\x1b[?1000l\x1b[?1006l");
    }
  }

  /** Keep the editor in sync with the shared session draft (e.g. after an ack
   * that landed while a previous view instance was disposed). */
  private reconcileEditor(): void {
    this.ensureEditorEpoch();
    if (this.mode !== "conversation" || !this.editor || !this.currentId) return;
    if (this.state.queues.get(this.currentId)?.editingActive) return;
    if (this.state.hasPendingSend(this.currentId, this.editor.getText())) return;
    const draft = this.state.view(this.currentId).draft;
    if (this.editor.getText() !== draft) this.editor.setText(draft);
  }

  private applySelection(id: string, requestRender: boolean): void {
    if (this.currentId && this.currentId !== id) this.state.queues.detach(this.currentId);
    const target = this.targetById(id);
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
    const changed = this.currentId !== id;
    if (changed) {
      this.clearCommandNotification();
      this.copyVersion++;
      this.textSelection.clear();
      this.stopWorkingIndicator();
      this.observedTranscript = undefined;
      this.observationKey = "";
      this.lastBody = [];
      this.lastBodyLength = 0;
      this.renderer.invalidate();
      this.options.onTargetChange?.(id);
    }
    this.currentId = id;
    this.state.selectedId = id;
    if (changed) this.resetEditor();
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

  private updateTargets(): void {
    // One provider observation per frame/input, including providers that mutate
    // their roster in place. The fingerprint contains metadata, never history.
    const targets = this.options.targets();
    const key = JSON.stringify(targets);
    if (key === this.targetsKey) return;
    this.targetsKey = key;
    this.targets = targets;
    this.targetsById.clear();
    for (const target of targets) {
      if (!this.targetsById.has(target.id)) this.targetsById.set(target.id, target);
    }
    this.nonMain = targets.filter((target) => !isMainTarget(target));
    this.main = targets.find(isMainTarget);
  }

  private currentTargets(): FabricConversationTarget[] {
    return this.targets;
  }

  private nonMainTargets(): FabricConversationTarget[] {
    return this.nonMain;
  }

  private currentTarget(): FabricConversationTarget | undefined {
    return this.currentId ? this.targetById(this.currentId) : undefined;
  }

  private mainTarget(): FabricConversationTarget | undefined {
    return this.main;
  }

  private targetById(id: string): FabricConversationTarget | undefined {
    return this.targetsById.get(id);
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
    binding: "app.message.followUp" | "app.message.copy" | "app.tools.expand" | "app.thinking.toggle",
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
    binding: "app.message.followUp" | "app.message.copy" | "app.tools.expand" | "app.thinking.toggle",
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
    if (this.stopConfirmId === undefined && this.bindingMatches(data, "app.message.copy", ["ctrl+shift+c"])) {
      this.copyResponse(undefined, true);
      return;
    }
    if (this.stopConfirmId === undefined && this.textSelection.active && matchesKey(data, Key.ctrl("c"))) {
      this.copySelection();
      return;
    }
    if (this.stopConfirmId === undefined && this.textSelection.source && matchesKey(data, Key.escape)) {
      this.textSelection.clear();
      return;
    }
    const queue = this.currentQueue();
    if (this.stopConfirmId === undefined && !queue?.editingActive && editor.isShowingAutocomplete() &&
        [Key.enter, Key.tab, Key.up, Key.down, Key.escape].some((key) => matchesKey(data, key))) {
      editor.handleInput(data);
      return;
    }
    if (this.stopConfirmId === undefined && queue?.handleInput(data)) return;

    if (this.stopConfirmId !== undefined) {
      if (matchesKey(data, Key.enter)) {
        const target = this.targetById(this.stopConfirmId);
        this.stopConfirmId = undefined;
        if (target) this.dispatchStop(target);
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.stopConfirmId = undefined;
        this.notifyCommand("Stop cancelled");
        return;
      }
      this.stopConfirmId = undefined;
      this.notifyCommand("Stop cancelled");
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
      this.textSelection.clear();
      if (this.currentId) {
        const entry = this.state.view(this.currentId);
        entry.hideThinking = !(entry.hideThinking ?? this.options.appearance?.hideThinkingBlock ?? false);
      }
      return;
    }
    if (this.bindingMatches(data, "app.tools.expand", TOOLS_EXPAND_FALLBACK)) {
      this.textSelection.clear();
      if (this.currentId) {
        const entry = this.state.view(this.currentId);
        entry.toolsExpanded = !entry.toolsExpanded;
      }
      return;
    }
    if (viewportKeys.matches(data, "tui.editor.cursorUp") || viewportKeys.matches(data, "tui.editor.cursorDown") ||
        viewportKeys.matches(data, "tui.editor.historyPrevious") || viewportKeys.matches(data, "tui.editor.historyNext")) this.initializePromptHistory();
    editor.handleInput(data);
  }

  private clearCommandNotification(): void {
    this.commandNotification = undefined;
    this.notificationScope++;
  }

  private notifyCommand(message: string, kind: Feedback["kind"] = "info",
    options: { reserve?: string; reveal?: boolean } = {}): void {
    if (this.disposed || this.mode !== "conversation" || !this.currentId || !this.currentTarget()) return;
    this.feedback = undefined;
    // Pi showStatus/showError use Spacer(1) + Text, not the input/status dock.
    // Retain one local result, rather than implement a full notification history.
    const text = safeText(message).slice(0, 4096);
    this.commandNotification = {
      component: new Text(this.theme.fg(kind === "error" ? "error" : "dim", kind === "error" ? `Error: ${text}` : text),
        kind === "error" ? this.options.appearance?.outputPad ?? 1 : 1, 0),
      epoch: this.state.epoch,
      ...(options.reserve !== undefined ? { pendingResult: new Text(this.theme.fg("dim", safeText(options.reserve).slice(0, 4096)), 1, 0) } : {}),
    };
    // Reveal the result in the loaded window; do not fetch newer history or
    // change following/selection when the user is inspecting an older page.
    if (options.reveal !== false) {
      const entry = this.state.view(this.currentId);
      entry.pageAnchor = entry.following ? undefined : "end";
      entry.anchorLength = undefined;
    }
    this.tui.requestRender();
  }

  private copyFeedback(text: string, kind: Feedback["kind"], command?: string, reveal = true): void {
    if (command !== undefined) this.notifyCommand(text, kind, { reveal });
    else {
      // A shortcut superseding a slash copy must not leave a pending result.
      if (this.commandNotification?.pendingResult) this.clearCommandNotification();
      this.feedback = { text: safeText(text), kind, at: Date.now() };
    }
  }

  private copySelection(command?: string): void {
    const text = this.textSelection.text();
    if (!text) {
      this.copyFeedback("No transcript text selected. Drag to select first.", "error", command);
      return;
    }
    this.copyText(text, "Copied selected transcript text", command);
  }

  private copyResponse(command?: string, preferSelection = false): void {
    if (preferSelection && this.textSelection.active) { this.copySelection(command); return; }
    if (!this.currentId) return;
    const transcript = this.options.transcript(this.currentId, false);
    if (transcript.hasNewer) {
      this.copyFeedback("Use /latest before /copy to load the latest response.", "error", command);
      return;
    }
    const text = conversationAssistantText(transcript);
    if (!text) {
      this.copyFeedback("No assistant response to copy yet.", "error", command);
      return;
    }
    this.copyText(text, "Copied last assistant response", command);
  }

  private copyText(text: string, message: string, command?: string): void {
    const id = this.currentId;
    const epoch = this.state.epoch;
    const version = ++this.copyVersion;
    const editor = this.editor;
    // Completion removes the suggestion rows synchronously. Reserve the final
    // result now, so clipboard latency cannot produce a blank, shifting frame.
    if (command !== undefined) this.notifyCommand("Copying…", "info", { reserve: message });
    const notification = this.commandNotification;
    const current = (): boolean => !this.disposed && this.currentId === id && this.state.epoch === epoch && this.copyVersion === version;
    // A newer command owns the notification, but does not cancel the copy itself.
    const currentResult = (): boolean => current() && (command === undefined || this.commandNotification === notification);
    // Serialize writes so a slower older copy cannot overwrite a newer one.
    this.copyTask = this.copyTask.then(() => {
      if (current()) return (this.options.copyToClipboard ?? getConversationHost().copyToClipboard)(text);
    }).then(() => {
      if (!currentResult()) return;
      if (command !== undefined && id) {
        if (this.state.peek(id)?.draft === command) this.state.view(id).draft = "";
        if (editor?.getText() === command) editor.setText("");
      }
      this.copyFeedback(message, "info", command, false);
      this.tui.requestRender();
    }, (error: unknown) => {
      if (!currentResult()) return;
      this.copyFeedback(`Copy failed: ${errorText(error)}`, "error", command, false);
      this.tui.requestRender();
    });
  }

  private submit(delivery: FabricConversationDelivery): void {
    const editor = this.editor;
    const target = this.currentTarget();
    if (!editor || !target || isMainTarget(target)) return;
    const raw = editor.getText();
    const message = editor.getExpandedText();
    if (!message.trim()) return;
    const command = message.trim().replace(/[\t ]+/g, " ");
    // Commands belong only to this target's in-memory editor history, including
    // failed attempts. Remember before navigation/validation, never via send.
    if (command.startsWith("/")) this.rememberPrompt(message);
    if (command === "/copy") { this.copyResponse(raw); return; }
    if (command === "/copy selection") { this.copySelection(raw); return; }
    if (command === "/help") {
      editor.setText("");
      this.notifyCommand(CONVERSATION_COMMAND_HELP);
      return;
    }
    if (command === "/latest") {
      editor.setText("");
      this.followLatest();
      this.notifyCommand("Following latest output");
      return;
    }

    if (command === "/back") {
      this.options.close();
      return;
    }
    if (command === "/agents") {
      this.openPicker();
      return;
    }
    if (command === "/stop") {
      if (!target.canStop) {
        this.notifyCommand(`Stop unavailable for ${target.name}: the selected target cannot be stopped from here.`, "error");
        return;
      }
      this.stopConfirmId = target.id;
      this.notifyCommand(`Press enter again to stop ${target.name} · esc cancels`);
      return;
    }
    if (message.trim().startsWith("/") || message.trim().startsWith("!")) {
      this.notifyCommand(`Unsupported command "${message.trim()}" is not forwarded from this view. Use /help for preview commands.`, "error");
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
    this.textSelection.clear();
    this.state.queues.sync(target.id, this.options.transcript(target.id, true));
    if (queue.mode === "extension" && delivery === "followUp" && !isActiveStatus(target.status)) {
      const parked = queue.park(message, delivery);
      if (parked.ok) { this.rememberPrompt(message); this.state.view(target.id).draft = ""; editor.setText(""); }
      return;
    }
    // Session-owned pending marker: blocks duplicate submission of the same
    // raw draft for the same target across view close/reopen.
    if (this.state.hasPendingSend(target.id, raw)) return;
    this.rememberPrompt(message);
    const pending: FabricConversationPendingSend = { id: target.id, message: raw, delivery };
    this.state.addPendingSend(pending);
    const epoch = this.state.epoch;
    this.feedback = {
      text: safeText(`Sending ${delivery} → ${target.name}…`),
      kind: "info",
      at: Date.now(),
    };
    void Promise.resolve()
      .then(() => queue.dispatch(message, delivery))
      .then(() => {
        // Same-session acks mutate shared state even if this view was closed;
        // only a session clear (epoch change) invalidates the result.
        if (this.state.epoch !== epoch) return;
        this.state.resolvePendingSend(target.id, raw);
        if (this.disposed) return;
        if (this.currentId === target.id && this.editor === editor && editor.getText() === raw) {
          editor.setText("");
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
    const scope = this.notificationScope;
    const current = (): boolean => !this.disposed && epoch === this.state.epoch &&
      scope === this.notificationScope && this.currentId === target.id;
    this.notifyCommand(`Stopping ${target.name}…`);
    void Promise.resolve()
      .then(() => this.options.stop(target.id))
      .then(() => {
        if (current()) this.notifyCommand(`Stop requested for ${target.name}`);
      })
      .catch((error: unknown) => {
        if (current()) this.notifyCommand(`Stop failed for ${target.name}: ${errorText(error)}`, "error");
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
    if (!this.textSelection.dragging) this.textSelection.clear();
    const entry = this.state.view(this.currentId);
    const maxScroll = Math.max(0, this.lastBodyLength - this.lastBodyBudget);
    const position = entry.following ? maxScroll : entry.scroll;
    // A wheel/key gesture wins over an unpainted command-result reveal.
    if (entry.pageAnchor === "end") entry.pageAnchor = undefined;
    // Downward overscroll at the live tail is still follow mode. Paging here
    // can succeed on fresh activity and leave the view pinned between frames,
    // alternating the Working row with the newer-activity notice.
    if (entry.following && delta > 0) return;
    const next = position + Math.trunc(delta);
    entry.following = false;
    if (next < 0 && !this.textSelection.dragging && this.options.loadOlder(this.currentId)) {
      // Native history pages prepend records instead of replacing the tail.
      // Preserve the old viewport anchor, then apply the requested movement.
      entry.pageAnchor = "prepend";
      entry.anchorLength = this.lastBody.length;
      entry.scroll = next;
      return;
    }
    if (next > maxScroll && !this.textSelection.dragging && this.options.loadNewer(this.currentId)) {
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
    this.textSelection.clear();
    const entry = this.state.view(this.currentId);
    entry.following = false;
    entry.scroll = 0;
    if (this.options.loadOlder(this.currentId)) entry.pageAnchor = "start";
  }

  private followLatest(): void {
    this.textSelection.clear();
    if (!this.currentId) return;
    this.options.loadLatest(this.currentId);
    const entry = this.state.view(this.currentId);
    entry.following = true;
    entry.pageAnchor = undefined;
    entry.anchorLength = undefined;
  }

  private openPicker(): void {
    this.clearCommandNotification();
    this.copyVersion++;
    this.textSelection.clear();
    this.stopWorkingIndicator();
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
    this.pickerKey = "";
    this.pickerSelectedId = undefined;
    if (this.editor) this.editor.focused = this.focusState;
  }

  private refreshPicker(): void {
    const search = this.pickerInput?.getValue() ?? "";
    const key = JSON.stringify([this.targetsKey, search]);
    if (key === this.pickerKey) return;
    this.pickerKey = key;
    const rows: PickerRow[] = [];
    const targets = this.currentTargets();
    const children = new Map<string, FabricConversationTarget[]>();
    for (const target of targets) {
      if (!target.parentId) continue;
      const siblings = children.get(target.parentId) ?? [];
      siblings.push(target);
      children.set(target.parentId, siblings);
    }
    const roots = targets.filter(
      (target) => !target.parentId || !this.targetsById.has(target.parentId),
    );
    roots.sort((left, right) =>
      Number(isMainTarget(right)) - Number(isMainTarget(left)),
    );
    const visited = new Set<string>();
    const pushTree = (target: FabricConversationTarget, depth: number): void => {
      if (visited.has(target.id)) return;
      visited.add(target.id);
      rows.push({ target, depth });
      for (const child of children.get(target.id) ?? []) pushTree(child, depth + 1);
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
          "scroll · drag select · /help",
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
      send: (message, delivery) => {
        if (message.trimStart().startsWith("/") || message.trimStart().startsWith("!")) {
          return Promise.reject(new Error("Commands cannot be sent from queued edits; use the preview composer."));
        }
        return this.options.send(target.id, message, delivery);
      },
      editor: {
        getText: () => this.editor?.getText() ?? "",
        setText: (text) => this.setQueueEditorText(text),
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
    const transcript = this.observedTranscript ?? this.options.transcript(this.currentId, entry.following);
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

  private transcriptTail(width: number, budget: number): string[] {
    if (this.commandNotification && this.commandNotification.epoch !== this.state.epoch) this.clearCommandNotification();
    const notification = this.commandNotification;
    if (this.observedTranscript?.hasNewer && !notification) return [];
    // These rows belong to the end of history, never to the fixed input dock.
    const tail = notification ? ["", ...notification.component.render(width)] : [];
    // Reserve wrapped success geometry too, including after a resize.
    if (notification?.pendingResult) {
      const reserved = 1 + notification.pendingResult.render(width).length;
      while (tail.length < reserved) tail.push("");
    }
    if (!this.observedTranscript?.hasNewer) tail.push(...this.working?.render(width) ?? []);
    if (budget > 1) tail.push("");
    return tail;
  }

  private windowBody(body: string[], budget: number, tail: string[]): string[] {
    this.lastBodyLength = body.length + tail.length;
    this.lastBody = body;
    this.lastBodyBudget = budget;
    const entry = this.currentId ? this.state.view(this.currentId) : undefined;
    const maxScroll = Math.max(0, this.lastBodyLength - budget);
    if (entry) {
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
    }
    // Slice the virtual body + tail without copying retained history per frame.
    const start = entry?.scroll ?? 0;
    const end = start + budget;
    const lines = body.slice(start, end);
    if (end > body.length) lines.push(...tail.slice(Math.max(0, start - body.length), end - body.length));
    return lines;
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
