import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import {
  Editor,
  getKeybindings,
  Key,
  matchesKey,
  truncateToWidth,
  type EditorTheme,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type {
  FabricActivityCall,
  FabricActivityItem,
  FabricActivityPhase,
  FabricActivityRun,
} from "../activity/types.js";
import { formatClock, formatDuration, formatTokens, padToWidth, safeText, wrapPlainText } from "./format.js";
import { FabricModelSelector } from "./fabric-model-selector.js";
import { FabricHostEventSelector } from "./fabric-host-event-selector.js";
import { FabricThinkingSelector } from "./fabric-thinking-selector.js";
import { INHERIT_VALUE, type ModelSource } from "./model-picker.js";
import { isFabricThinking, type FabricThinking } from "../thinking.js";
import type { FabricActorHostEvent, GlobalActorDefinition } from "../actors/types.js";
import type {
  FabricDashboardSnapshot,
  FabricUiActor,
  FabricUiAgent,
  FabricUiStateEntry,
} from "./types.js";
import { isActiveStatus } from "./types.js";

interface PhasePanel {
  id: string;
  name: string;
  status: string;
  completed: number;
  total: number;
  phase?: FabricActivityPhase;
  session: boolean;
}

type Entity =
  | { id: string; kind: "agent"; label: string; status: string; value: FabricUiAgent }
  | { id: string; kind: "actor"; label: string; status: string; value: FabricUiActor }
  | {
      id: string;
      kind: "globalActor";
      label: string;
      status: string;
      value: GlobalActorDefinition;
    }
  | { id: string; kind: "call"; label: string; status: string; value: FabricActivityCall }
  | { id: string; kind: "item"; label: string; status: string; value: FabricActivityItem }
  | { id: string; kind: "state"; label: string; status: string; value: FabricUiStateEntry };

type Pane = "phases" | "entities";
type StatusFilter = "all" | "active" | "completed" | "failed";

const filters: StatusFilter[] = ["all", "active", "completed", "failed"];
const spinnerFrames = ["◐", "◓", "◑", "◒"];

const statusGlyph = (status: string): string => {
  if (status === "completed" || status === "done") return "✓";
  if (status === "failed" || status === "timed_out") return "✗";
  if (status === "blocked") return "!";
  if (status === "stopped" || status === "cancelled") return "■";
  if (status === "queued" || status === "pending" || status === "ready") return "○";
  if (status === "idle" || status === "state") return "·";
  if (status === "global") return "◇";
  return spinnerFrames[Math.floor(Date.now() / 250) % spinnerFrames.length] ?? "●";
};

const colorStatus = (theme: Theme, status: string, value: string): string => {
  if (status === "completed" || status === "done") return theme.fg("success", value);
  if (status === "failed" || status === "timed_out" || status === "error") {
    return theme.fg("error", value);
  }
  if (status === "blocked" || status === "warning") return theme.fg("warning", value);
  if (status === "running" || status === "in_progress") return theme.fg("accent", value);
  if (status === "global") return theme.fg("muted", value);
  return theme.fg("dim", value);
};

const editorTheme = (theme: Theme): EditorTheme => ({
  borderColor: (value: string) => theme.fg("borderMuted", value),
  selectList: {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("muted", text),
    noMatch: (text: string) => theme.fg("muted", text),
  },
});

const phaseWork = (
  run: FabricActivityRun,
  phaseId: string,
): Array<FabricActivityCall | FabricActivityItem> => [
  ...run.calls.filter((call) => call.phaseId === phaseId),
  ...run.items.filter((item) => item.phaseId === phaseId),
];

const phasePanels = (snapshot: FabricDashboardSnapshot, run: FabricActivityRun | undefined): PhasePanel[] => {
  const panels: PhasePanel[] =
    run?.phases.map((phase) => {
      const work = phaseWork(run, phase.id);
      return {
        id: phase.id,
        name: phase.name,
        status: phase.status,
        completed: work.filter((entry) => entry.status === "completed").length,
        total: Math.max(phase.total ?? 0, work.length),
        phase,
        session: false,
      };
    }) ?? [];
  const sessionTotal = snapshot.actors.length + snapshot.state.length;
  if (sessionTotal > 0 || panels.length === 0) {
    panels.push({
      id: "__fabric_session",
      name: "Actors & shared state",
      status: snapshot.actors.some((actor) => actor.lastError)
        ? "failed"
        : snapshot.actors.some((actor) => isActiveStatus(actor.status)) ||
            snapshot.state.some((entry) => isActiveStatus(entry.status))
          ? "running"
          : "idle",
      completed: snapshot.actors.filter((actor) => actor.status === "stopped").length,
      total: sessionTotal,
      session: true,
    });
  }
  return panels;
};

const linkedAgent = (call: FabricActivityCall, agent: FabricUiAgent): boolean =>
  Boolean(
    call.entityId &&
      (agent.id.startsWith(call.entityId) || call.entityId.startsWith(agent.id)),
  );

const entitiesFor = (
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun | undefined,
  panel: PhasePanel | undefined,
): Entity[] => {
  if (!panel || panel.session) {
    const actors: Entity[] = snapshot.actors.map((actor) => ({
      id: `actor:${actor.id}`,
      kind: "actor",
      label: actor.name,
      status: actor.lastError ? "failed" : actor.status,
      value: actor,
    }));
    const state: Entity[] = snapshot.state.map((entry) => ({
      id: `state:${entry.key}`,
      kind: "state",
      label: entry.label,
      status: entry.status,
      value: entry,
    }));
    const unlinkedAgents: Entity[] = snapshot.agents
      .filter(
        (agent) =>
          agent.runId !== run?.id && isActiveStatus(agent.status),
      )
      .map((agent) => ({
        id: `agent:${agent.id}`,
        kind: "agent",
        label: agent.name,
        status: agent.status,
        value: agent,
      }));
    const globalActors: Entity[] = snapshot.globalActors.map((def) => ({
      id: `globalActor:${def.id}`,
      kind: "globalActor",
      label: def.name,
      status: "global",
      value: def,
    }));
    return [...unlinkedAgents, ...actors, ...globalActors, ...state];
  }

  const calls = run?.calls.filter((call) => call.phaseId === panel.id) ?? [];
  const linkedAgents: Entity[] = snapshot.agents
    .filter(
      (agent) =>
        (agent.runId === run?.id && agent.phaseId === panel.id) ||
        calls.some((call) => linkedAgent(call, agent)),
    )
    .map((agent) => ({
      id: `agent:${agent.id}`,
      kind: "agent",
      label: agent.name,
      status: agent.status,
      value: agent,
    }));
  const visibleCalls: Entity[] = calls
    .filter(
      (call) =>
        (call.kind !== "agent" && call.kind !== "actor") ||
        !snapshot.agents.some((agent) => linkedAgent(call, agent)),
    )
    .map((call) => ({
      id: `call:${call.id}`,
      kind: "call",
      label: call.label,
      status: call.status,
      value: call,
    }));
  const items: Entity[] =
    run?.items
      .filter((item) => item.phaseId === panel.id)
      .map((item) => ({
        id: `item:${item.id}`,
        kind: "item" as const,
        label: item.label,
        status: item.status,
        value: item,
      })) ?? [];
  return [...linkedAgents, ...visibleCalls, ...items];
};

const matchesFilter = (status: string, filter: StatusFilter): boolean => {
  if (filter === "all") return true;
  if (filter === "active") return isActiveStatus(status);
  if (filter === "completed") return status === "completed" || status === "done";
  return status === "failed" || status === "timed_out" || status === "blocked";
};

const tokensFor = (
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun | undefined,
): number =>
  snapshot.agents
    .filter((agent) => !run || agent.runId === run.id)
    .reduce(
      (sum, agent) => sum + (agent.usage ? agent.usage.input + agent.usage.output : 0),
      0,
    );

const entityTail = (entity: Entity, now: number): string => {
  if (entity.kind === "agent") {
    const agent = entity.value;
    const parts = [
      agent.model,
      agent.currentTool ?? (agent.status === "running" ? "thinking" : undefined),
      agent.usage ? `${formatTokens(agent.usage.input + agent.usage.output)} tok` : undefined,
      agent.toolCalls !== undefined ? `${agent.toolCalls} tools` : undefined,
      agent.startedAt ? formatDuration((agent.finishedAt ?? now) - agent.startedAt) : undefined,
    ];
    return parts.filter((value): value is string => Boolean(value)).join(" · ");
  }
  if (entity.kind === "actor") {
    const actor = entity.value;
    return [
      actor.model ?? actor.worker?.model,
      actor.worker?.currentTool,
      actor.worker?.usage
        ? `${formatTokens(actor.worker.usage.input + actor.worker.usage.output)} tok`
        : undefined,
      `${actor.messages} msg`,
      actor.queued > 0 ? `q:${actor.queued}` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (entity.kind === "globalActor") {
    const def = entity.value;
    return [
      "global template",
      def.model ?? "inherit",
      def.responseMode === "directive" ? "directive" : undefined,
      def.delivery !== "mailbox" ? def.delivery : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (entity.kind === "call") {
    const call = entity.value;
    return [
      call.ref,
      call.progress,
      call.metrics?.tokens !== undefined ? `${formatTokens(call.metrics.tokens)} tok` : undefined,
      call.metrics?.toolCalls !== undefined ? `${call.metrics.toolCalls} tools` : undefined,
      formatDuration((call.finishedAt ?? now) - call.startedAt),
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (entity.kind === "item") {
    const item = entity.value;
    return [
      item.current ?? item.detail,
      item.total !== undefined ? `${item.completed ?? 0}/${item.total}` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  return [entity.value.owner, entity.value.detail, `v${entity.value.version}`]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
};

export class FabricDashboard implements Component, Focusable {
  focused = false;
  private pane: Pane = "phases";
  private phaseIndex = 0;
  private entityIndex = 0;
  private runIndex = 0;
  private filter: StatusFilter = "all";
  private phaseSelectionTouched = false;
  private detailId: string | undefined;
  private detailScroll = 0;
  private readonly refreshTimer: NodeJS.Timeout;
  private mode:
    | "overview"
    | "detail"
    | "modelPicker"
    | "thinkingPicker"
    | "eventsPicker"
    | "instructionsEditor" = "overview";
  private picker:
    | FabricModelSelector
    | FabricThinkingSelector
    | FabricHostEventSelector
    | undefined;
  private editor: Editor | undefined;
  private editorActorName: string | undefined;
  private readonly modelSource: ModelSource | undefined;
  private readonly onActorModel:
    | ((actorId: string, model: string | undefined) => void)
    | undefined;
  private readonly onActorThinking:
    | ((actorId: string, thinking: FabricThinking | undefined) => void)
    | undefined;
  private readonly onActorEvents:
    | ((actorId: string, events: FabricActorHostEvent[]) => void)
    | undefined;
  private readonly onClearMessages: ((actorId: string) => void) | undefined;
  private readonly onActorInstructions:
    | ((actorId: string, instructions: string) => void)
    | undefined;
  private readonly onGlobalInstructions:
    | ((globalActorId: string, instructions: string) => void)
    | undefined;
  private readonly onImportActor: ((globalActorId: string) => void) | undefined;
  private readonly onExportActor: ((actorId: string) => void) | undefined;
  private readonly onRemoveGlobalActor: ((globalActorId: string) => void) | undefined;
  private pickerActorName: string | undefined;

  constructor(
    readonly tui: TUI,
    readonly theme: Theme,
    readonly snapshot: () => FabricDashboardSnapshot,
    readonly done: () => void,
    options: {
      modelSource?: ModelSource;
      onActorModel?: (actorId: string, model: string | undefined) => void;
      onActorThinking?: (actorId: string, thinking: FabricThinking | undefined) => void;
      onActorEvents?: (actorId: string, events: FabricActorHostEvent[]) => void;
      onClearMessages?: (actorId: string) => void;
      onActorInstructions?: (actorId: string, instructions: string) => void;
      onGlobalInstructions?: (globalActorId: string, instructions: string) => void;
      onImportActor?: (globalActorId: string) => void;
      onExportActor?: (actorId: string) => void;
      onRemoveGlobalActor?: (globalActorId: string) => void;
    } = {},
  ) {
    this.focused = true;
    this.modelSource = options.modelSource;
    this.onActorModel = options.onActorModel;
    this.onActorThinking = options.onActorThinking;
    this.onActorEvents = options.onActorEvents;
    this.onClearMessages = options.onClearMessages;
    this.onActorInstructions = options.onActorInstructions;
    this.onGlobalInstructions = options.onGlobalInstructions;
    this.onImportActor = options.onImportActor;
    this.onExportActor = options.onExportActor;
    this.onRemoveGlobalActor = options.onRemoveGlobalActor;
    this.refreshTimer = setInterval(() => this.tui.requestRender(), 500);
    this.refreshTimer.unref();
  }

  handleInput(data: string): void {
    if (this.mode === "instructionsEditor" && this.editor) {
      if (getKeybindings().matches(data, "tui.select.cancel")) {
        this.closeInstructionsEditor();
      } else {
        this.editor.handleInput(data);
      }
      this.tui.requestRender();
      return;
    }
    if (
      (this.mode === "modelPicker" ||
        this.mode === "thinkingPicker" ||
        this.mode === "eventsPicker") &&
      this.picker
    ) {
      this.picker.handleInput(data);
      this.tui.requestRender();
      return;
    }

    const snapshot = this.snapshot();
    const run = snapshot.runs[this.runIndex];
    const panels = phasePanels(snapshot, run);
    this.syncPhase(run, panels);
    const panel = panels[this.phaseIndex];
    const entities = entitiesFor(snapshot, run, panel).filter((entity) =>
      matchesFilter(entity.status, this.filter),
    );

    if (this.detailId) {
      if (
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.ctrl("c")) ||
        matchesKey(data, Key.left) ||
        data === "h"
      ) {
        this.detailId = undefined;
        this.detailScroll = 0;
      } else if (matchesKey(data, Key.up) || data === "k") {
        this.detailScroll = Math.max(0, this.detailScroll - 1);
      } else if (matchesKey(data, Key.down) || data === "j") {
        this.detailScroll++;
      } else if (matchesKey(data, Key.home) || data === "g") {
        this.detailScroll = 0;
      } else if (data === "m") {
        const detail = entities.find((entity) => entity.id === this.detailId);
        if (detail && detail.kind === "actor" && detail.status !== "stopped") {
          this.openModelPicker(detail);
        }
      } else if (data === "e") {
        const detail = entities.find((entity) => entity.id === this.detailId);
        if (detail && detail.kind === "actor" && detail.status !== "stopped") {
          this.openThinkingPicker(detail);
        }
      } else if (data === "v") {
        const detail = entities.find((entity) => entity.id === this.detailId);
        if (detail && detail.kind === "actor" && detail.status !== "stopped") {
          this.openEventsPicker(detail);
        }
      } else if (data === "c") {
        const detail = entities.find((entity) => entity.id === this.detailId);
        if (
          detail &&
          detail.kind === "actor" &&
          detail.status !== "stopped" &&
          this.onClearMessages
        ) {
          this.onClearMessages(detail.value.id);
        }
      } else if (data === "i") {
        const detail = entities.find((entity) => entity.id === this.detailId);
        if (detail && (detail.kind === "actor" || detail.kind === "globalActor")) {
          this.openInstructionsEditor(detail);
        }
      } else if (data === "x") {
        const detail = entities.find((entity) => entity.id === this.detailId);
        if (
          detail &&
          detail.kind === "actor" &&
          detail.status !== "stopped" &&
          this.onExportActor
        ) {
          this.onExportActor(detail.value.id);
        }
      } else if (data === "p") {
        const detail = entities.find((entity) => entity.id === this.detailId);
        if (detail && detail.kind === "globalActor" && this.onImportActor) {
          this.onImportActor(detail.value.id);
        }
      } else if (data === "d") {
        const detail = entities.find((entity) => entity.id === this.detailId);
        if (detail && detail.kind === "globalActor" && this.onRemoveGlobalActor) {
          this.onRemoveGlobalActor(detail.value.id);
        }
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      if (this.pane === "entities") {
        this.pane = "phases";
      } else {
        this.done();
        return;
      }
    } else if (matchesKey(data, Key.tab)) {
      this.pane = this.pane === "phases" ? "entities" : "phases";
    } else if (matchesKey(data, Key.left) || data === "h") {
      this.pane = "phases";
    } else if (matchesKey(data, Key.right) || data === "l") {
      this.pane = "entities";
    } else if (matchesKey(data, Key.up) || data === "k") {
      if (this.pane === "phases") {
        this.phaseIndex = Math.max(0, this.phaseIndex - 1);
        this.phaseSelectionTouched = true;
      } else this.entityIndex = Math.max(0, this.entityIndex - 1);
    } else if (matchesKey(data, Key.down) || data === "j") {
      if (this.pane === "phases") {
        this.phaseIndex = Math.min(Math.max(0, panels.length - 1), this.phaseIndex + 1);
        this.phaseSelectionTouched = true;
        this.entityIndex = 0;
      } else {
        this.entityIndex = Math.min(Math.max(0, entities.length - 1), this.entityIndex + 1);
      }
    } else if (matchesKey(data, Key.enter)) {
      if (this.pane === "phases") {
        this.pane = "entities";
      } else if (entities[this.entityIndex]) {
        this.detailId = entities[this.entityIndex]?.id;
        this.detailScroll = 0;
      }
    } else if (data === "f") {
      const next = (filters.indexOf(this.filter) + 1) % filters.length;
      this.filter = filters[next] ?? "all";
      this.entityIndex = 0;
    } else if (data === "[") {
      this.runIndex = Math.min(Math.max(0, snapshot.runs.length - 1), this.runIndex + 1);
      this.resetSelection();
    } else if (data === "]") {
      this.runIndex = Math.max(0, this.runIndex - 1);
      this.resetSelection();
    } else if (data === "G") {
      if (this.pane === "phases") {
        this.phaseIndex = Math.max(0, panels.length - 1);
        this.phaseSelectionTouched = true;
      } else this.entityIndex = Math.max(0, entities.length - 1);
    } else if (data === "g") {
      if (this.pane === "phases") {
        this.phaseIndex = 0;
        this.phaseSelectionTouched = true;
      } else this.entityIndex = 0;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (this.mode === "instructionsEditor") {
      return this.renderInstructionsEditor(width);
    }
    if (
      (this.mode === "modelPicker" ||
        this.mode === "thinkingPicker" ||
        this.mode === "eventsPicker") &&
      this.picker
    ) {
      return this.renderPicker(width);
    }
    const snapshot = this.snapshot();
    this.runIndex = Math.max(0, Math.min(this.runIndex, Math.max(0, snapshot.runs.length - 1)));
    const run = snapshot.runs[this.runIndex];
    const panels = phasePanels(snapshot, run);
    this.syncPhase(run, panels);
    const panel = panels[this.phaseIndex];
    const entities = entitiesFor(snapshot, run, panel).filter((entity) =>
      matchesFilter(entity.status, this.filter),
    );
    this.entityIndex = Math.max(0, Math.min(this.entityIndex, Math.max(0, entities.length - 1)));
    if (this.detailId) {
      const detail = entities.find((entity) => entity.id === this.detailId);
      if (detail) return this.renderDetail(width, snapshot, detail);
      this.detailId = undefined;
    }
    return this.renderOverview(width, snapshot, run, panels, panel, entities);
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.refreshTimer);
    this.picker = undefined;
    this.editor = undefined;
    this.editorActorName = undefined;
    this.mode = "overview";
  }

  private openModelPicker(entity: Entity): void {
    if (entity.kind !== "actor" || !this.modelSource || !this.onActorModel) return;
    const actor = entity.value;
    this.pickerActorName = actor.name;
    this.picker = new FabricModelSelector({
      theme: this.theme,
      source: this.modelSource,
      currentValue: actor.model ?? INHERIT_VALUE,
      headerText: `Model for actor "${actor.name}". Pick Inherit to use the Fabric default.`,
      inheritName: "Use the Fabric default model (or host default)",
      onSelect: (value) => {
        const model = value === INHERIT_VALUE ? undefined : value;
        this.onActorModel!(actor.id, model);
        this.closeModelPicker();
      },
      onCancel: () => this.closeModelPicker(),
    });
    this.picker.focused = true;
    this.mode = "modelPicker";
  }

  private openThinkingPicker(entity: Entity): void {
    if (entity.kind !== "actor" || !this.onActorThinking) return;
    const actor = entity.value;
    this.pickerActorName = actor.name;
    this.picker = new FabricThinkingSelector({
      theme: this.theme,
      currentValue: actor.thinking ?? INHERIT_VALUE,
      headerText: `Thinking level for actor "${actor.name}". Pick Inherit to use the Fabric default.`,
      inheritName: "Use the Fabric default thinking level",
      onSelect: (value) => {
        const thinking = value === INHERIT_VALUE ? undefined : value;
        this.onActorThinking!(actor.id, isFabricThinking(thinking) ? thinking : undefined);
        this.closeModelPicker();
      },
      onCancel: () => this.closeModelPicker(),
    });
    this.picker.focused = true;
    this.mode = "thinkingPicker";
  }

  private openEventsPicker(entity: Entity): void {
    if (entity.kind !== "actor" || !this.onActorEvents) return;
    const actor = entity.value;
    this.pickerActorName = actor.name;
    this.picker = new FabricHostEventSelector({
      theme: this.theme,
      currentValue: actor.events,
      headerText: `Host events for actor "${actor.name}". Toggle with space, Enter to apply, Esc to cancel.`,
      onSelect: (events) => {
        this.onActorEvents!(actor.id, events);
        this.closeModelPicker();
      },
      onCancel: () => this.closeModelPicker(),
    });
    this.picker.focused = true;
    this.mode = "eventsPicker";
  }

  private closeModelPicker(): void {
    this.picker = undefined;
    this.pickerActorName = undefined;
    this.mode = "detail";
  }

  /**
   * Open the embedded multi-line editor for an actor's default instruction.
   * Matches Pi's editor dialog convention (Enter submit, Shift+Enter newline,
   * Esc/Ctrl+C cancel) so a steering user edits the persona with the same
   * muscle memory as the chat input. Works for both live project actors and
   * global templates; the submit routes to the scope-appropriate callback.
   */
  private openInstructionsEditor(entity: Entity): void {
    let kind: "actor" | "globalActor";
    let id: string;
    let name: string;
    let instructions: string;
    if (entity.kind === "actor") {
      if (entity.status === "stopped" || !this.onActorInstructions) return;
      kind = "actor";
      id = entity.value.id;
      name = entity.value.name;
      instructions = entity.value.instructions;
    } else if (entity.kind === "globalActor") {
      if (!this.onGlobalInstructions) return;
      kind = "globalActor";
      id = entity.value.id;
      name = entity.value.name;
      instructions = entity.value.instructions;
    } else {
      return;
    }
    const editor = new Editor(this.tui, editorTheme(this.theme));
    editor.focused = true;
    editor.setText(instructions);
    editor.onSubmit = (text) => {
      if (kind === "actor") this.onActorInstructions?.(id, text);
      else this.onGlobalInstructions?.(id, text);
      this.closeInstructionsEditor();
    };
    this.editor = editor;
    this.editorActorName = name;
    this.mode = "instructionsEditor";
  }

  private closeInstructionsEditor(): void {
    this.editor = undefined;
    this.editorActorName = undefined;
    this.mode = "detail";
  }

  private renderPicker(width: number): string[] {
    if (width < 24 || !this.picker) return [];
    const kind =
      this.mode === "thinkingPicker"
        ? "thinking"
        : this.mode === "eventsPicker"
          ? "events"
          : "model";
    const lines = [
      this.topBorder(width, `actor · ${this.pickerActorName ?? ""} · ${kind}`),
    ];
    const inner = this.picker.render(width - 2);
    for (const line of inner) lines.push(this.row(width, line));
    lines.push(this.middleBorder(width));
    const filterHint =
      this.mode === "thinkingPicker" || this.mode === "eventsPicker" ? "" : " · type to filter";
    lines.push(
      this.row(
        width,
        this.theme.fg("dim", `  Enter to select · Esc to cancel${filterHint}`),
      ),
    );
    lines.push(this.bottomBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private renderInstructionsEditor(width: number): string[] {
    if (width < 24 || !this.editor) return [];
    const innerWidth = width - 2;
    const lines = [this.topBorder(width, `instructions · ${this.editorActorName ?? ""}`)];
    for (const line of this.editor.render(innerWidth)) {
      lines.push(this.row(width, line));
    }
    lines.push(this.middleBorder(width));
    lines.push(
      this.row(
        width,
        this.theme.fg("dim", "  enter submit · shift+enter newline · esc cancel"),
      ),
    );
    lines.push(this.bottomBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private renderOverview(
    width: number,
    snapshot: FabricDashboardSnapshot,
    run: FabricActivityRun | undefined,
    panels: PhasePanel[],
    selectedPanel: PhasePanel | undefined,
    entities: Entity[],
  ): string[] {
    if (width < 24) {
      return [truncateToWidth(`Fabric · ${run?.name ?? "session"}`, width)];
    }
    const innerWidth = width - 2;
    const lines: string[] = [];
    lines.push(this.topBorder(width, `Fabric · ${run?.name ?? "session"}`));

    const activeAgents = snapshot.agents.filter((agent) => isActiveStatus(agent.status)).length;
    const elapsed = run ? formatDuration((run.finishedAt ?? snapshot.now) - run.startedAt) : undefined;
    const summary = [
      run?.status,
      `${activeAgents}/${snapshot.agents.length} agents active`,
      `${snapshot.actors.length} actors`,
      tokensFor(snapshot, run) > 0
        ? `${formatTokens(tokensFor(snapshot, run))} tok`
        : undefined,
      elapsed,
      snapshot.runs.length > 1 ? `run ${this.runIndex + 1}/${snapshot.runs.length}` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
    const summaryText = safeText(summary);
    let headerLine = summaryText;
    if (run?.description) {
      const gap = "  ";
      const availableDescription = innerWidth - visibleWidth(summaryText) - gap.length;
      headerLine =
        availableDescription >= 12
          ? `${padToWidth(
              this.theme.fg("muted", safeText(run.description)),
              availableDescription,
            )}${gap}${this.theme.fg("dim", summaryText)}`
          : this.theme.fg("dim", summaryText);
    } else if (summaryText) {
      headerLine = this.theme.fg("dim", summaryText);
    }
    lines.push(this.row(width, headerLine || this.theme.fg("muted", "No Fabric activity yet")));
    lines.push(this.middleBorder(width));

    const maxBody = Math.max(8, Math.min(22, (process.stdout.rows ?? 28) - 10));
    if (innerWidth >= 88) {
      const leftWidth = Math.min(38, Math.max(28, Math.floor((innerWidth - 1) * 0.34)));
      const rightWidth = innerWidth - leftWidth - 1;
      const leftLines = this.renderPhasePanel(panels, leftWidth, maxBody);
      const rightLines = this.renderEntityPanel(
        entities,
        rightWidth,
        maxBody,
        snapshot.now,
        selectedPanel,
      );
      for (let index = 0; index < maxBody; index++) {
        const left = leftLines[index] ?? "";
        const right = rightLines[index] ?? "";
        lines.push(
          this.row(
            width,
            `${padToWidth(left, leftWidth)}${this.theme.fg("borderMuted", "│")}${padToWidth(
              right,
              rightWidth,
            )}`,
          ),
        );
      }
    } else {
      const phaseHeight = Math.min(Math.max(3, panels.length + 1), Math.floor(maxBody * 0.45));
      const entityHeight = Math.max(3, maxBody - phaseHeight - 1);
      for (const line of this.renderPhasePanel(panels, innerWidth, phaseHeight)) {
        lines.push(this.row(width, line));
      }
      lines.push(this.row(width, this.theme.fg("borderMuted", "─".repeat(innerWidth))));
      for (const line of this.renderEntityPanel(
        entities,
        innerWidth,
        entityHeight,
        snapshot.now,
        selectedPanel,
      )) {
        lines.push(this.row(width, line));
      }
    }

    const runEvents = run?.events.slice(-2) ?? [];
    const meshEventCount = Math.max(0, 2 - runEvents.length);
    const meshEvents = meshEventCount > 0 ? snapshot.events.slice(-meshEventCount) : [];
    if (runEvents.length > 0 || meshEvents.length > 0) {
      lines.push(this.middleBorder(width));
      for (const event of runEvents) {
        lines.push(
          this.row(
            width,
            colorStatus(
              this.theme,
              event.level === "success" ? "completed" : event.level,
              `[${formatClock(event.createdAt)}] ${safeText(event.message)}`,
            ),
          ),
        );
      }
      for (const event of meshEvents) {
        const target = event.to ? ` → ${event.to}` : "";
        const text = event.text ? ` · ${safeText(event.text)}` : "";
        lines.push(
          this.row(
            width,
            this.theme.fg(
              "dim",
              `[${formatClock(event.createdAt)}] ${event.topic} · ${event.from.name}${target}${text}`,
            ),
          ),
        );
      }
    }

    lines.push(this.middleBorder(width));
    lines.push(
      this.row(
        width,
        this.theme.fg(
          "dim",
          `↑↓/jk select · ←→/tab pane · enter inspect · f filter:${this.filter} · [ ] runs · esc close`,
        ),
      ),
    );
    lines.push(this.bottomBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private renderPhasePanel(panels: PhasePanel[], width: number, height: number): string[] {
    const lines = [
      truncateToWidth(
        `${this.pane === "phases" ? this.theme.fg("accent", "▸ ") : "  "}${this.theme.fg(
          "accent",
          "Phases",
        )}`,
        width,
      ),
    ];
    const available = Math.max(0, height - 1);
    const start = Math.max(
      0,
      Math.min(this.phaseIndex - Math.floor(available / 2), Math.max(0, panels.length - available)),
    );
    for (let index = start; index < Math.min(panels.length, start + available); index++) {
      const panel = panels[index];
      if (!panel) continue;
      const selected = index === this.phaseIndex;
      const prefix = selected ? "› " : "  ";
      const count = panel.total > 0 ? `${panel.completed}/${panel.total}` : "";
      const raw = `${prefix}${colorStatus(this.theme, panel.status, statusGlyph(panel.status))} ${safeText(
        panel.name,
      )}`;
      const countWidth = visibleWidth(count);
      const contentWidth = Math.max(0, width - countWidth - (count ? 1 : 0));
      let line = `${padToWidth(raw, contentWidth)}${count ? ` ${this.theme.fg("dim", count)}` : ""}`;
      if (selected && this.pane === "phases") line = this.theme.bg("selectedBg", padToWidth(line, width));
      lines.push(truncateToWidth(line, width, ""));
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private renderEntityPanel(
    entities: Entity[],
    width: number,
    height: number,
    now: number,
    panel: PhasePanel | undefined,
  ): string[] {
    const heading = panel?.name ?? "Activity";
    const headingDetail = panel?.phase?.description
      ? this.theme.fg("dim", ` · ${safeText(panel.phase.description)}`)
      : "";
    const lines = [
      truncateToWidth(
        `${this.pane === "entities" ? this.theme.fg("accent", "▸ ") : "  "}${this.theme.fg(
          "accent",
          safeText(heading),
        )}${headingDetail}${this.filter !== "all" ? this.theme.fg("dim", ` · ${this.filter}`) : ""}`,
        width,
      ),
    ];
    const available = Math.max(0, height - 1);
    const start = Math.max(
      0,
      Math.min(
        this.entityIndex - Math.floor(available / 2),
        Math.max(0, entities.length - available),
      ),
    );
    for (let index = start; index < Math.min(entities.length, start + available); index++) {
      const entity = entities[index];
      if (!entity) continue;
      const selected = index === this.entityIndex;
      const prefix = selected ? "› " : "  ";
      const lead = `${prefix}${colorStatus(this.theme, entity.status, statusGlyph(entity.status))} ${safeText(
        entity.label,
      )}`;
      const tail = safeText(entityTail(entity, now));
      let line = tail ? `${lead}  ${this.theme.fg("dim", tail)}` : lead;
      if (selected && this.pane === "entities") line = this.theme.bg("selectedBg", padToWidth(line, width));
      lines.push(truncateToWidth(line, width, ""));
    }
    if (entities.length === 0 && available > 0) {
      lines.push(this.theme.fg("dim", "  (no matching activity)"));
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private renderDetail(
    width: number,
    snapshot: FabricDashboardSnapshot,
    entity: Entity,
  ): string[] {
    if (width < 24) return [truncateToWidth(entity.label, width)];
    const innerWidth = width - 2;
    const lines = [this.topBorder(width, `${entity.kind} · ${entity.label}`)];
    const content = this.detailLines(entity, innerWidth, snapshot.now);
    const maxBody = Math.max(8, Math.min(24, (process.stdout.rows ?? 28) - 7));
    const maxScroll = Math.max(0, content.length - maxBody);
    this.detailScroll = Math.max(0, Math.min(this.detailScroll, maxScroll));
    const visible = content.slice(this.detailScroll, this.detailScroll + maxBody);
    for (const line of visible) lines.push(this.row(width, line));
    while (lines.length < maxBody + 1) lines.push(this.row(width, ""));
    lines.push(this.middleBorder(width));
    const actorModelHint =
      entity.kind === "actor" && entity.status !== "stopped" && this.modelSource
        ? " · m model"
        : "";
    const actorThinkingHint =
      entity.kind === "actor" && entity.status !== "stopped" && this.onActorThinking
        ? " · e thinking"
        : "";
    const actorEventsHint =
      entity.kind === "actor" && entity.status !== "stopped" && this.onActorEvents
        ? " · v events"
        : "";
    const actorClearHint =
      entity.kind === "actor" && entity.status !== "stopped" && this.onClearMessages
        ? " · c clear"
        : "";
    const actorInstructionsHint =
      entity.kind === "actor" && entity.status !== "stopped" && this.onActorInstructions
        ? " · i instructions"
        : "";
    const actorExportHint =
      entity.kind === "actor" && entity.status !== "stopped" && this.onExportActor
        ? " · x export→global"
        : "";
    const globalInstructionsHint =
      entity.kind === "globalActor" && this.onGlobalInstructions ? " · i instructions" : "";
    const globalImportHint = entity.kind === "globalActor" && this.onImportActor ? " · p import" : "";
    const globalDeleteHint =
      entity.kind === "globalActor" && this.onRemoveGlobalActor ? " · d delete" : "";
    lines.push(
      this.row(
        width,
        this.theme.fg(
          "dim",
          `j/k scroll · esc back${content.length > maxBody ? ` · ${this.detailScroll + 1}-${Math.min(content.length, this.detailScroll + maxBody)}/${content.length}` : ""}${actorModelHint}${actorThinkingHint}${actorEventsHint}${actorClearHint}${actorInstructionsHint}${actorExportHint}${globalInstructionsHint}${globalImportHint}${globalDeleteHint}`,
        ),
      ),
    );
    lines.push(this.bottomBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private detailLines(entity: Entity, width: number, now: number): string[] {
    const lines: string[] = [];
    const field = (label: string, value: unknown): void => {
      const text = safeText(value);
      if (!text) return;
      const prefix = `${this.theme.fg("dim", `${label}:`)} `;
      const wrapped = wrapPlainText(text, Math.max(1, width - visibleWidth(prefix)), 12);
      if (wrapped[0]) lines.push(truncateToWidth(prefix + wrapped[0], width));
      for (const continuation of wrapped.slice(1)) {
        lines.push(truncateToWidth(" ".repeat(visibleWidth(prefix)) + continuation, width));
      }
    };
    field("Status", entity.status);

    if (entity.kind === "agent") {
      const agent = entity.value;
      field("ID", agent.id);
      field("Model", agent.model);
      field("Thinking", agent.thinking);
      field("Transport", agent.transport);
      field("Activity", agent.currentTool);
      field("Elapsed", agent.startedAt ? formatDuration((agent.finishedAt ?? now) - agent.startedAt) : undefined);
      field("Usage", agent.usage ? `${formatTokens(agent.usage.input + agent.usage.output)} tokens · ${agent.toolCalls ?? 0} tools · ${agent.turns ?? 0} turns · $${agent.usage.cost.toFixed(4)}` : undefined);
      field("Task", agent.task);
      field("Branch", agent.branch);
      field("Worktree", agent.worktree);
      field("Attach", agent.attachCommand);
      field("Error", agent.error);
      field("Result", agent.text);
    } else if (entity.kind === "actor") {
      const actor = entity.value;
      field("ID", actor.id);
      field("Model", actor.model ?? actor.worker?.model);
      field("Thinking", actor.thinking ?? actor.worker?.thinking);
      field("Delivery", `${actor.delivery} · ${actor.responseMode}`);
      field("Activity", actor.worker?.currentTool);
      field("Transport", actor.worker?.transport);
      field(
        "Usage",
        actor.worker?.usage
          ? `${formatTokens(actor.worker.usage.input + actor.worker.usage.output)} tokens · ${actor.worker.toolCalls ?? 0} tools`
          : undefined,
      );
      field("Host events", actor.events.join(", "));
      field("Topics", actor.topics.join(", "));
      field("Queue", actor.queued);
      field("Last error", actor.lastError);
      field("Instructions", actor.instructions);
      if (actor.recentMessages.length > 0) {
        lines.push("");
        lines.push(this.theme.fg("accent", "Recent mailbox"));
        for (const message of actor.recentMessages) {
          const text = message.text ?? message.action ?? message.error ?? "data";
          field(
            `${message.direction === "in" ? "→" : "←"} ${formatClock(message.createdAt)} ${message.source}`,
            text,
          );
        }
      }
    } else if (entity.kind === "call") {
      const call = entity.value;
      field("Reference", call.ref);
      field("ID", call.id);
      field("Kind", call.kind);
      field("Progress", call.progress);
      field("Elapsed", formatDuration((call.finishedAt ?? now) - call.startedAt));
      field("Tokens", call.metrics?.tokens);
      field("Tool calls", call.metrics?.toolCalls);
      field("Cost", call.metrics?.cost);
      field("Entity", call.entityId);
      field("Error", call.error);
    } else if (entity.kind === "item") {
      const item = entity.value;
      field("ID", item.id);
      field("Kind", item.kind);
      field("Progress", item.total !== undefined ? `${item.completed ?? 0}/${item.total}` : undefined);
      field("Current", item.current);
      field("Detail", item.detail);
      field("Data", item.data === undefined ? undefined : JSON.stringify(item.data));
    } else if (entity.kind === "globalActor") {
      const def = entity.value;
      field("Scope", "global template");
      field("ID", def.id);
      field("Delivery", `${def.delivery} · ${def.responseMode}`);
      field("Model", def.model ?? "inherit");
      field("Thinking", def.thinking ?? "inherit");
      field("Host events", def.events.join(", "));
      field("Topics", def.topics.join(", "));
      field("Trigger turn", def.triggerTurn ? "yes" : "no");
      field("Coalesce", def.coalesce ? "yes" : "no");
      field("Created", new Date(def.createdAt).toLocaleString());
      field("Updated", new Date(def.updatedAt).toLocaleString());
      field("Instructions", def.instructions);
    } else {
      const entry = entity.value;
      field("Key", entry.key);
      field("Owner", entry.owner);
      field("Version", entry.version);
      field("Updated", new Date(entry.updatedAt).toLocaleString());
      field("Detail", entry.detail);
      field("Value", JSON.stringify(entry.value));
    }
    return lines.length > 0 ? lines : [this.theme.fg("dim", "No details")];
  }

  private syncPhase(run: FabricActivityRun | undefined, panels: PhasePanel[]): void {
    if (panels.length === 0) {
      this.phaseIndex = 0;
      return;
    }
    if (!this.phaseSelectionTouched && run?.currentPhaseId) {
      const current = panels.findIndex((panel) => panel.id === run.currentPhaseId);
      if (current >= 0) this.phaseIndex = current;
    }
    this.phaseIndex = Math.max(0, Math.min(this.phaseIndex, panels.length - 1));
  }

  private resetSelection(): void {
    this.phaseIndex = 0;
    this.entityIndex = 0;
    this.phaseSelectionTouched = false;
    this.detailId = undefined;
    this.detailScroll = 0;
    this.pane = "phases";
  }

  private topBorder(width: number, title: string): string {
    const border = (value: string) => this.theme.fg("borderMuted", value);
    const safeTitle = truncateToWidth(safeText(title), Math.max(0, width - 6));
    const styledTitle = ` ${this.theme.fg("accent", safeTitle)} `;
    const remaining = Math.max(0, width - 2 - visibleWidth(styledTitle));
    const left = Math.floor(remaining / 2);
    const right = remaining - left;
    return `${border(`╭${"─".repeat(left)}`)}${styledTitle}${border(`${"─".repeat(right)}╮`)}`;
  }

  private middleBorder(width: number): string {
    return this.theme.fg("borderMuted", `├${"─".repeat(Math.max(0, width - 2))}┤`);
  }

  private bottomBorder(width: number): string {
    return this.theme.fg("borderMuted", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
  }

  private row(width: number, content: string): string {
    const innerWidth = Math.max(0, width - 2);
    return `${this.theme.fg("borderMuted", "│")}${padToWidth(content, innerWidth)}${this.theme.fg(
      "borderMuted",
      "│",
    )}`;
  }
}
