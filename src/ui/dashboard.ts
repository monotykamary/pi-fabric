import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import {
  Editor,
  getKeybindings,
  Markdown,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type EditorTheme,
  type MarkdownTheme,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type {
  FabricActivityCall,
  FabricActivityItem,
  FabricActivityKind,
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
import { isActiveStatus, orderAgentsByCreation } from "./types.js";
import type { FabricAgentTranscript } from "./transcript.js";
import { highlightCode } from "./highlight.js";
import { formatJsonAsYaml } from "./structured.js";
import { nestedEditDiff } from "./fabric-render.js";

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

type PanelKind = "phase" | "unphased" | "session";

interface PhasePanel {
  id: string;
  name: string;
  status: string;
  completed: number;
  total: number;
  phase?: FabricActivityPhase;
  kind: PanelKind;
  agents?: number;
  tokens?: number;
  elapsedMs?: number;
}

type Pane = "phases" | "entities";

type EntityGroupKind = FabricActivityKind | "globalActor" | "state";

interface EntityGroup {
  kind: EntityGroupKind;
  label: string;
  entries: Array<{ entity: Entity; index: number }>;
}

const entityGroupOrder: readonly EntityGroupKind[] = [
  "agent",
  "actor",
  "globalActor",
  "tool",
  "extension",
  "mcp",
  "mesh",
  "task",
  "custom",
  "state",
];

const entityGroupLabels: Record<EntityGroupKind, string> = {
  agent: "Agents",
  actor: "Actors",
  globalActor: "Global templates",
  tool: "Tools",
  extension: "Extensions",
  mcp: "MCP",
  mesh: "Mesh",
  task: "Tasks",
  custom: "Custom items",
  state: "Shared state",
};

const entityGroupKind = (entity: Entity): EntityGroupKind => {
  if (entity.kind === "agent") return "agent";
  if (entity.kind === "actor") return "actor";
  if (entity.kind === "globalActor") return "globalActor";
  if (entity.kind === "state") return "state";
  if (entity.kind === "call") return entity.value.entityKind ?? entity.value.kind;
  return entity.value.kind;
};

const entityGroupRanks = new Map(
  entityGroupOrder.map((kind, index) => [kind, index] as const),
);

const orderEntitiesByGroup = (entities: Entity[]): Entity[] =>
  entities
    .map((entity, index) => ({ entity, index }))
    .sort(
      (left, right) =>
        (entityGroupRanks.get(entityGroupKind(left.entity)) ?? Number.MAX_SAFE_INTEGER) -
          (entityGroupRanks.get(entityGroupKind(right.entity)) ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index,
    )
    .map(({ entity }) => entity);

const groupEntities = (entities: Entity[]): EntityGroup[] => {
  const indexed = entities.map((entity, index) => ({ entity, index }));
  return entityGroupOrder.flatMap((kind) => {
    const entries = indexed.filter(({ entity }) => entityGroupKind(entity) === kind);
    return entries.length > 0 ? [{ kind, label: entityGroupLabels[kind], entries }] : [];
  });
};

type StatusFilter = "all" | "active" | "completed" | "failed";

const filters: StatusFilter[] = ["all", "active", "completed", "failed"];
const spinnerFrames = ["◐", "◓", "◑", "◒"];

const statusGlyph = (status: string): string => {
  if (status === "completed" || status === "done") return "✓";
  if (status === "failed" || status === "timed_out" || status === "error") return "✗";
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

const transcriptMarkdownTheme = (theme: Theme, invalidate: () => void): MarkdownTheme => ({
  heading: (text) => theme.fg("mdHeading", text),
  link: (text) => theme.fg("mdLink", text),
  linkUrl: (text) => theme.fg("mdLinkUrl", text),
  code: (text) => theme.fg("mdCode", text),
  codeBlock: (text) => theme.fg("mdCodeBlock", text),
  codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
  quote: (text) => theme.fg("mdQuote", text),
  quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
  hr: (text) => theme.fg("mdHr", text),
  listBullet: (text) => theme.fg("mdListBullet", text),
  bold: (text) => theme.bold(text),
  italic: (text) => theme.italic(text),
  underline: (text) => theme.underline(text),
  strikethrough: (text) => theme.strikethrough(text),
  highlightCode: (code, lang) =>
    highlightCode(code, lang ?? "", invalidate) ??
    code.split("\n").map((line) => theme.fg("mdCodeBlock", line)),
});

const safeMarkdownText = (value: string): string =>
  value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f-\u009f]/g, " ");

const linkedEntityId = (entityId: string | undefined, id: string): boolean =>
  Boolean(entityId && (id.startsWith(entityId) || entityId.startsWith(id)));

const linkedAgent = (call: FabricActivityCall, agent: FabricUiAgent): boolean =>
  linkedEntityId(call.entityId, agent.id);

const agentLaunchRefs = new Set(["agents.run", "agents.spawn"]);

const UNPHASED_PANEL_ID = "__fabric_unphased";
const SESSION_PANEL_ID = "__fabric_session";

const callsForPanel = (
  run: FabricActivityRun | undefined,
  panel: PhasePanel,
): FabricActivityCall[] => {
  if (!run || panel.kind === "session") return [];
  return run.calls.filter((call) =>
    panel.kind === "unphased" ? !call.phaseId : call.phaseId === panel.id,
  );
};

const itemsForPanel = (
  run: FabricActivityRun | undefined,
  panel: PhasePanel,
): FabricActivityItem[] => {
  if (!run || panel.kind === "session") return [];
  return run.items.filter((item) =>
    panel.kind === "unphased" ? !item.phaseId : item.phaseId === panel.id,
  );
};

const entitiesFor = (
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun | undefined,
  panel: PhasePanel | undefined,
): Entity[] => {
  if (!panel || panel.kind === "session") {
    const unlinkedAgents: Entity[] = orderAgentsByCreation(snapshot.agents)
      .filter((agent) => agent.runId !== run?.id && isActiveStatus(agent.status))
      .map((agent) => ({
        id: `agent:${agent.id}`,
        kind: "agent",
        label: agent.name,
        status: agent.status,
        value: agent,
      }));
    const actors: Entity[] = snapshot.actors.map((actor) => ({
      id: `actor:${actor.id}`,
      kind: "actor",
      label: actor.name,
      status: actor.lastError ? "failed" : actor.status,
      value: actor,
    }));
    const globalActors: Entity[] = snapshot.globalActors.map((definition) => ({
      id: `globalActor:${definition.id}`,
      kind: "globalActor",
      label: definition.name,
      status: "global",
      value: definition,
    }));
    const state: Entity[] = snapshot.state.map((entry) => ({
      id: `state:${entry.key}`,
      kind: "state",
      label: entry.label,
      status: entry.status,
      value: entry,
    }));
    return orderEntitiesByGroup([...unlinkedAgents, ...actors, ...globalActors, ...state]);
  }

  const calls = callsForPanel(run, panel);
  const panelAgents = orderAgentsByCreation(snapshot.agents).filter((agent) => {
    const ownedByPanel =
      agent.runId === run?.id &&
      (panel.kind === "unphased" ? !agent.phaseId : agent.phaseId === panel.id);
    return ownedByPanel || (!agent.runId && calls.some((call) => linkedAgent(call, agent)));
  });
  const linkedAgents: Entity[] = panelAgents.map((agent) => ({
    id: `agent:${agent.id}`,
    kind: "agent",
    label: agent.name,
    status: agent.status,
    value: agent,
  }));
  const visibleCalls: Entity[] = calls
    .filter((call) => {
      const representedAgentLaunch =
        call.kind === "agent" &&
        agentLaunchRefs.has(call.ref) &&
        panelAgents.some((agent) => linkedAgent(call, agent));
      const representedActorCreation =
        call.kind === "actor" &&
        call.ref === "agents.create" &&
        snapshot.actors.some((actor) => linkedEntityId(call.entityId, actor.id));
      return !representedAgentLaunch && !representedActorCreation;
    })
    .map((call) => ({
      id: `call:${call.id}`,
      kind: "call",
      label: call.label,
      status: call.status,
      value: call,
    }));
  const items: Entity[] = itemsForPanel(run, panel).map((item) => ({
    id: `item:${item.id}`,
    kind: "item",
    label: item.label,
    status: item.status,
    value: item,
  }));
  return orderEntitiesByGroup([...linkedAgents, ...visibleCalls, ...items]);
};

const panelStatus = (entities: Entity[], fallback: string): string => {
  if (entities.some((entity) => ["failed", "timed_out", "error"].includes(entity.status))) {
    return "failed";
  }
  if (entities.some((entity) => entity.status === "blocked")) return "blocked";
  if (entities.some((entity) => isActiveStatus(entity.status))) return "running";
  if (
    entities.length > 0 &&
    entities.every((entity) =>
      ["completed", "done", "stopped", "cancelled", "global", "idle", "state"].includes(
        entity.status,
      ),
    )
  ) {
    return "completed";
  }
  return fallback;
};

const withPanelProgress = (
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun | undefined,
  panel: PhasePanel,
): PhasePanel => {
  const entities = entitiesFor(snapshot, run, panel);
  const status =
    panel.kind === "session"
      ? entities.some((entity) => ["failed", "timed_out", "error"].includes(entity.status))
        ? "failed"
        : entities.some((entity) => isActiveStatus(entity.status))
          ? "running"
          : "idle"
      : panelStatus(entities, panel.status);
  const agents = entities.filter((entity) => entity.kind === "agent");
  const tokens = agents.reduce(
    (sum, entity) =>
      sum +
      (entity.kind === "agent" && entity.value.usage
        ? entity.value.usage.input + entity.value.usage.output
        : 0),
    0,
  );
  const starts = entities
    .flatMap((entity) => {
      if (entity.kind === "agent" || entity.kind === "call") return [entity.value.startedAt ?? 0];
      if (entity.kind === "item") return [entity.value.createdAt];
      return [];
    })
    .filter((value) => value > 0);
  const startedAt = starts.length > 0 ? Math.min(...starts) : undefined;
  const hasActive = entities.some((entity) => isActiveStatus(entity.status));
  const finishes = entities
    .flatMap((entity) => {
      if (entity.kind === "agent" || entity.kind === "call") return [entity.value.finishedAt ?? 0];
      if (entity.kind === "item") return [entity.value.finishedAt ?? 0];
      return [];
    })
    .filter((value) => value > 0);
  const finishedAt = hasActive
    ? snapshot.now
    : finishes.length > 0
      ? Math.max(...finishes)
      : undefined;
  return {
    ...panel,
    status,
    completed: entities.filter(
      (entity) => entity.status === "completed" || entity.status === "done",
    ).length,
    total: Math.max(panel.total, entities.length),
    ...(agents.length > 0 ? { agents: agents.length } : {}),
    ...(tokens > 0 ? { tokens } : {}),
    ...(startedAt && finishedAt ? { elapsedMs: Math.max(0, finishedAt - startedAt) } : {}),
  };
};

const phasePanels = (
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun | undefined,
): PhasePanel[] => {
  const panels: PhasePanel[] = [];

  if (run) {
    const runActivity: PhasePanel = {
      id: UNPHASED_PANEL_ID,
      name: "Run activity",
      status: run.status,
      completed: 0,
      total: 0,
      kind: "unphased",
    };
    if (entitiesFor(snapshot, run, runActivity).length > 0) panels.push(runActivity);
  }

  panels.push(
    ...(run?.phases.map((phase) => ({
      id: phase.id,
      name: phase.name,
      status: phase.status,
      completed: 0,
      total: phase.total ?? 0,
      phase,
      kind: "phase" as const,
    })) ?? []),
  );

  const session: PhasePanel = {
    id: SESSION_PANEL_ID,
    name: "Actors & shared state",
    status: "idle",
    completed: 0,
    total: 0,
    kind: "session",
  };
  const sessionEntities = entitiesFor(snapshot, run, session);
  if (sessionEntities.length > 0 || panels.length === 0) panels.push(session);

  return panels.map((panel) => withPanelProgress(snapshot, run, panel));
};

const matchesFilter = (status: string, filter: StatusFilter): boolean => {
  if (filter === "all") return true;
  if (filter === "active") return isActiveStatus(status);
  if (filter === "completed") return status === "completed" || status === "done";
  return status === "failed" || status === "timed_out" || status === "blocked" || status === "error";
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
    const narrative = safeText(agent.error ?? agent.text).slice(0, 140);
    const summary =
      agent.status === "blocked" && narrative
        ? `needs input: ${narrative}`
        : (agent.status === "failed" || agent.status === "timed_out") && narrative
          ? `error: ${narrative}`
          : agent.status === "completed" && narrative
            ? `result: ${narrative}`
            : agent.currentTool ?? (agent.status === "running" ? "thinking" : undefined);
    const parts = [
      summary,
      agent.runner,
      agent.model,
      agent.usage ? `${formatTokens(agent.usage.input + agent.usage.output)} tok` : undefined,
      agent.toolCalls !== undefined ? `${agent.toolCalls} tools` : undefined,
      agent.startedAt ? formatDuration((agent.finishedAt ?? now) - agent.startedAt) : undefined,
    ];
    return parts.filter((value): value is string => Boolean(value)).join(" · ");
  }
  if (entity.kind === "actor") {
    const actor = entity.value;
    return [
      actor.runner,
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
      def.runner,
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
  private selectedRunId: string | undefined;
  private runSelectionTouched = false;
  private selectedEntityId: string | undefined;
  private filter: StatusFilter = "all";
  private phaseSelectionTouched = false;
  private selectedPhaseId: string | undefined;
  private detailId: string | undefined;
  private detailScroll = 0;
  private detailMaxScroll = 0;
  private detailSelectionRestore:
    | { runSelectionTouched: boolean; phaseSelectionTouched: boolean }
    | undefined;
  private detailView: "summary" | "transcript" = "summary";
  private transcriptFollowing = true;
  private readonly transcriptMarkdown = new Map<string, { text: string; component: Markdown }>();
  private readonly highlightInvalidate = (): void => this.tui.requestRender();
  private readonly refreshTimer: NodeJS.Timeout;
  private mode:
    | "overview"
    | "detail"
    | "modelPicker"
    | "thinkingPicker"
    | "eventsPicker"
    | "instructionsEditor"
    | "agentMessageEditor"
    | "help" = "overview";
  private picker:
    | FabricModelSelector
    | FabricThinkingSelector
    | FabricHostEventSelector
    | undefined;
  private editor: Editor | undefined;
  private editorActorName: string | undefined;
  private agentMessageTarget: { id: string; name: string; kind: "steer" | "followUp" } | undefined;
  private pendingStop: { id: string; expiresAt: number } | undefined;
  private readonly modelSource: ModelSource | undefined;
  private readonly claudeModelSource: ModelSource | undefined;
  private readonly onAgentSteer: ((agentId: string, message: string) => void) | undefined;
  private readonly onAgentFollowUp: ((agentId: string, message: string) => void) | undefined;
  private readonly onAgentStop: ((agentId: string) => void) | undefined;
  private readonly agentTranscript: ((agent: FabricUiAgent) => FabricAgentTranscript) | undefined;
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
      claudeModelSource?: ModelSource;
      onAgentSteer?: (agentId: string, message: string) => void;
      onAgentFollowUp?: (agentId: string, message: string) => void;
      onAgentStop?: (agentId: string) => void;
      agentTranscript?: (agent: FabricUiAgent) => FabricAgentTranscript;
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
    this.claudeModelSource = options.claudeModelSource;
    this.onAgentSteer = options.onAgentSteer;
    this.onAgentFollowUp = options.onAgentFollowUp;
    this.onAgentStop = options.onAgentStop;
    this.agentTranscript = options.agentTranscript;
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
    if (this.mode === "help") {
      if (
        data === "?" ||
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.ctrl("c"))
      ) {
        this.mode = this.detailId ? "detail" : "overview";
      }
      this.tui.requestRender();
      return;
    }
    if (this.mode === "agentMessageEditor" && this.editor) {
      if (getKeybindings().matches(data, "tui.select.cancel")) {
        this.closeAgentMessageEditor();
      } else {
        this.editor.handleInput(data);
      }
      this.tui.requestRender();
      return;
    }
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
    const run = this.selectRun(snapshot);
    const panels = phasePanels(snapshot, run);
    this.syncPhase(run, panels);
    const panel = panels[this.phaseIndex];
    const allEntities = entitiesFor(snapshot, run, panel);
    const entities = allEntities.filter((entity) => matchesFilter(entity.status, this.filter));
    this.syncEntitySelection(entities);

    if (data === "?") {
      this.mode = "help";
      this.tui.requestRender();
      return;
    }

    if (this.detailId) {
      if (
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.ctrl("c")) ||
        matchesKey(data, Key.left) ||
        data === "h"
      ) {
        this.closeDetail();
      } else if (data === "t") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (detail?.kind === "agent" && this.agentTranscript) {
          this.detailView = this.detailView === "summary" ? "transcript" : "summary";
          this.detailScroll = 0;
          this.transcriptFollowing = true;
        }
      } else if (matchesKey(data, Key.up) || data === "k") {
        if (this.detailScroll > 0) {
          if (this.detailView === "transcript") this.transcriptFollowing = false;
          this.detailScroll--;
        }
      } else if (matchesKey(data, Key.down) || data === "j") {
        if (this.detailScroll < this.detailMaxScroll) {
          if (this.detailView === "transcript") this.transcriptFollowing = false;
          this.detailScroll++;
        }
      } else if (data === "G" && this.detailView === "transcript") {
        this.transcriptFollowing = true;
      } else if (matchesKey(data, Key.home) || data === "g") {
        if (this.detailScroll > 0) {
          if (this.detailView === "transcript") this.transcriptFollowing = false;
          this.detailScroll = 0;
        }
      } else if (data === "s" || data === "u") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (detail?.kind === "agent") {
          this.openAgentMessageEditor(detail, data === "s" ? "steer" : "followUp");
        }
      } else if (data === "m") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (detail && detail.kind === "actor" && detail.status !== "stopped") {
          this.openModelPicker(detail);
        }
      } else if (data === "e") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (detail && detail.kind === "actor" && detail.status !== "stopped") {
          this.openThinkingPicker(detail);
        }
      } else if (data === "v") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (detail && detail.kind === "actor" && detail.status !== "stopped") {
          this.openEventsPicker(detail);
        }
      } else if (data === "c") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (
          detail &&
          detail.kind === "actor" &&
          detail.status !== "stopped" &&
          this.onClearMessages
        ) {
          this.onClearMessages(detail.value.id);
        }
      } else if (data === "i") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (detail && (detail.kind === "actor" || detail.kind === "globalActor")) {
          this.openInstructionsEditor(detail);
        }
      } else if (data === "x") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (detail?.kind === "agent" && isActiveStatus(detail.status)) {
          this.requestAgentStop(detail);
        } else if (
          detail &&
          detail.kind === "actor" &&
          detail.status !== "stopped" &&
          this.onExportActor
        ) {
          this.onExportActor(detail.value.id);
        }
      } else if (data === "p") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (detail && detail.kind === "globalActor" && this.onImportActor) {
          this.onImportActor(detail.value.id);
        }
      } else if (data === "d") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
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
        this.entityIndex = 0;
        this.selectedEntityId = undefined;
      } else {
        this.entityIndex = Math.max(0, this.entityIndex - 1);
      }
    } else if (matchesKey(data, Key.down) || data === "j") {
      if (this.pane === "phases") {
        this.phaseIndex = Math.min(Math.max(0, panels.length - 1), this.phaseIndex + 1);
        this.phaseSelectionTouched = true;
        this.entityIndex = 0;
        this.selectedEntityId = undefined;
      } else {
        this.entityIndex = Math.min(Math.max(0, entities.length - 1), this.entityIndex + 1);
      }
    } else if (
      ["m", "e", "v", "i", "s", "u", "x"].includes(data) &&
      this.pane === "entities"
    ) {
      const selected = entities[this.entityIndex];
      if (selected) {
        if ((data === "s" || data === "u") && selected.kind === "agent") {
          this.detailId = selected.id;
          this.openAgentMessageEditor(selected, data === "s" ? "steer" : "followUp");
        } else if (data === "x" && selected.kind === "agent" && isActiveStatus(selected.status)) {
          this.requestAgentStop(selected);
        } else if (data === "m" && selected.kind === "actor" && selected.status !== "stopped") {
          this.detailId = selected.id;
          this.openModelPicker(selected);
        } else if (data === "e" && selected.kind === "actor" && selected.status !== "stopped") {
          this.detailId = selected.id;
          this.openThinkingPicker(selected);
        } else if (data === "v" && selected.kind === "actor" && selected.status !== "stopped") {
          this.detailId = selected.id;
          this.openEventsPicker(selected);
        } else if (data === "i" && (selected.kind === "actor" || selected.kind === "globalActor")) {
          this.detailId = selected.id;
          this.openInstructionsEditor(selected);
        }
      }
    } else if (data === " " && this.pane === "entities") {
      const selected = entities[this.entityIndex];
      if (selected?.kind === "agent" && this.agentTranscript) {
        this.detailId = selected.id;
        this.detailView = "transcript";
        this.detailScroll = 0;
        this.transcriptFollowing = true;
      }
    } else if (matchesKey(data, Key.enter)) {
      if (this.pane === "phases") {
        this.pane = "entities";
      } else {
        const selected = entities[this.entityIndex];
        if (selected) {
          this.detailId = selected.id;
          this.detailView = "summary";
          this.detailScroll = 0;
          this.transcriptFollowing = true;
        }
      }
    } else if (data === "f") {
      const next = (filters.indexOf(this.filter) + 1) % filters.length;
      this.filter = filters[next] ?? "all";
      this.entityIndex = 0;
      this.selectedEntityId = undefined;
    } else if (data === "[") {
      this.runIndex = Math.min(Math.max(0, snapshot.runs.length - 1), this.runIndex + 1);
      this.selectedRunId = snapshot.runs[this.runIndex]?.id;
      this.runSelectionTouched = true;
      this.resetSelection();
      this.tui.requestRender();
      return;
    } else if (data === "]") {
      this.runIndex = Math.max(0, this.runIndex - 1);
      this.selectedRunId = snapshot.runs[this.runIndex]?.id;
      this.runSelectionTouched = true;
      this.resetSelection();
      this.tui.requestRender();
      return;
    } else if (data === "G") {
      if (this.pane === "phases") {
        this.phaseIndex = Math.max(0, panels.length - 1);
        this.phaseSelectionTouched = true;
        this.entityIndex = 0;
        this.selectedEntityId = undefined;
      } else {
        this.entityIndex = Math.max(0, entities.length - 1);
      }
    } else if (data === "g") {
      if (this.pane === "phases") {
        this.phaseIndex = 0;
        this.phaseSelectionTouched = true;
        this.entityIndex = 0;
        this.selectedEntityId = undefined;
      } else {
        this.entityIndex = 0;
      }
    }
    if (this.phaseSelectionTouched) this.selectedPhaseId = panels[this.phaseIndex]?.id;
    if (this.detailId) this.pinDetailSelection(run, panel);
    if (this.pane === "entities") {
      this.selectedEntityId = entities[this.entityIndex]?.id;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (this.mode === "help") return this.renderHelp(width);
    if (this.mode === "agentMessageEditor") return this.renderAgentMessageEditor(width);
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
    const run = this.selectRun(snapshot);
    const panels = phasePanels(snapshot, run);
    this.syncPhase(run, panels);
    const panel = panels[this.phaseIndex];
    const allEntities = entitiesFor(snapshot, run, panel);
    const entities = allEntities.filter((entity) => matchesFilter(entity.status, this.filter));
    this.syncEntitySelection(entities);
    if (this.detailId) {
      const detail = allEntities.find((entity) => entity.id === this.detailId);
      if (detail) return this.renderDetail(width, snapshot, detail);
      this.closeDetail();
    }
    return this.renderOverview(width, snapshot, run, panels, entities);
  }

  invalidate(): void {
    this.transcriptMarkdown.clear();
  }

  dispose(): void {
    clearInterval(this.refreshTimer);
    this.picker = undefined;
    this.editor = undefined;
    this.editorActorName = undefined;
    this.agentMessageTarget = undefined;
    this.pendingStop = undefined;
    this.transcriptMarkdown.clear();
    this.mode = "overview";
  }

  private openAgentMessageEditor(entity: Entity, kind: "steer" | "followUp"): void {
    if (entity.kind !== "agent") return;
    if (kind === "steer" && (!isActiveStatus(entity.status) || !this.onAgentSteer)) return;
    if (kind === "followUp" && !this.onAgentFollowUp) return;
    const editor = new Editor(this.tui, editorTheme(this.theme));
    editor.focused = true;
    editor.onSubmit = (text) => {
      const message = text.trim();
      if (!message) return;
      if (kind === "steer") this.onAgentSteer?.(entity.value.id, message);
      else this.onAgentFollowUp?.(entity.value.id, message);
      this.closeAgentMessageEditor();
    };
    this.editor = editor;
    this.agentMessageTarget = { id: entity.value.id, name: entity.value.name, kind };
    this.mode = "agentMessageEditor";
  }

  private closeAgentMessageEditor(): void {
    this.editor = undefined;
    this.agentMessageTarget = undefined;
    this.mode = this.detailId ? "detail" : "overview";
  }

  private requestAgentStop(entity: Extract<Entity, { kind: "agent" }>): void {
    if (!this.onAgentStop) return;
    const now = Date.now();
    if (this.pendingStop?.id === entity.value.id && this.pendingStop.expiresAt > now) {
      this.pendingStop = undefined;
      this.onAgentStop(entity.value.id);
      return;
    }
    this.pendingStop = { id: entity.value.id, expiresAt: now + 2_000 };
  }

  private renderAgentMessageEditor(width: number): string[] {
    if (!this.editor || !this.agentMessageTarget) return [];
    if (width < 24) return this.renderNarrowFallback(width, `${this.agentMessageTarget.kind} · ${this.agentMessageTarget.name}`, "esc cancel");
    const target = this.agentMessageTarget;
    const label = target.kind === "steer" ? "steer now" : "follow up after completion";
    const innerWidth = width - 2;
    const lines = [this.topBorder(width, `${label} · ${target.name}`)];
    for (const line of this.editor.render(innerWidth)) lines.push(this.row(width, line));
    lines.push(this.middleBorder(width));
    lines.push(
      this.row(
        width,
        this.theme.fg("dim", "  enter send · shift+enter newline · esc cancel"),
      ),
    );
    lines.push(this.bottomBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private renderHelp(width: number): string[] {
    if (width < 24) return this.renderNarrowFallback(width, "dashboard help", "? or esc close");
    const lines = [this.topBorder(width, "Fabric dashboard help")];
    const agentActions = [
      this.agentTranscript ? "space transcript peek" : undefined,
      this.onAgentSteer ? "s steer now" : undefined,
      this.onAgentFollowUp ? "u queue follow-up" : undefined,
      this.onAgentStop ? "x twice stop" : undefined,
      "enter details",
    ].filter((value): value is string => Boolean(value));
    const actorActions = [
      (this.modelSource || this.claudeModelSource) && this.onActorModel ? "m model" : undefined,
      this.onActorThinking ? "e thinking" : undefined,
      this.onActorEvents ? "v events" : undefined,
      this.onActorInstructions ? "i instructions" : undefined,
      this.onClearMessages ? "c clear mailbox" : undefined,
      this.onExportActor ? "x export" : undefined,
    ].filter((value): value is string => Boolean(value));
    const templateActions = [
      this.onGlobalInstructions ? "i instructions" : undefined,
      this.onImportActor ? "p import" : undefined,
      this.onRemoveGlobalActor ? "d delete" : undefined,
    ].filter((value): value is string => Boolean(value));
    const help = [
      ["Navigate", "↑↓/jk select · ←→/tab switch pane · enter inspect · esc back"],
      ["Runs", "[ older · ] newer · f cycle status filter"],
      ...(agentActions.length > 1 ? [["Agents", agentActions.join(" · ")]] : []),
      ...(actorActions.length > 0 ? [["Actors", actorActions.join(" · ")]] : []),
      ...(templateActions.length > 0 ? [["Templates", templateActions.join(" · ")]] : []),
      ["Details", "↑↓/jk scroll · g top · t transcript/summary · G resume follow · ? close help"],
    ];
    for (const [label, value] of help) {
      const prefix = `${this.theme.fg("accent", `${label}:`)} `;
      const wrapped = wrapPlainText(value ?? "", Math.max(1, width - 2 - visibleWidth(prefix)), 3);
      if (wrapped[0]) lines.push(this.row(width, prefix + wrapped[0]));
      for (const continuation of wrapped.slice(1)) {
        lines.push(this.row(width, " ".repeat(visibleWidth(prefix)) + continuation));
      }
    }
    lines.push(this.middleBorder(width));
    lines.push(this.row(width, this.theme.fg("dim", "  ? or esc close")));
    lines.push(this.bottomBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private modelSourceForActor(actor: FabricUiActor): ModelSource | undefined {
    return actor.runner === "claude" ? this.claudeModelSource : this.modelSource;
  }

  private openModelPicker(entity: Entity): void {
    if (entity.kind !== "actor" || !this.onActorModel) return;
    const actor = entity.value;
    const source = this.modelSourceForActor(actor);
    if (!source) return;
    this.pickerActorName = actor.name;
    this.picker = new FabricModelSelector({
      theme: this.theme,
      source,
      currentValue: actor.model ?? INHERIT_VALUE,
      headerText:
        actor.runner === "claude"
          ? `Model for Claude actor "${actor.name}". Pick Inherit to use the Claude default.`
          : `Model for actor "${actor.name}". Pick Inherit to use the Fabric Pi default.`,
      inheritName:
        actor.runner === "claude"
          ? "Use the Fabric Claude model (or Claude Code runtime default)"
          : "Use the Fabric Pi model (or host default)",
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
    if (!this.picker) return [];
    if (width < 24) return this.renderNarrowFallback(width, `actor · ${this.pickerActorName ?? ""}`, "esc cancel");
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
    if (!this.editor) return [];
    if (width < 24) return this.renderNarrowFallback(width, `instructions · ${this.editorActorName ?? ""}`, "esc cancel");
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
    entities: Entity[],
  ): string[] {
    if (width < 24) {
      return [truncateToWidth("too narrow · need 24 cols", width)];
    }
    const innerWidth = width - 2;
    const lines: string[] = [];
    lines.push(this.topBorder(width, `Fabric · ${run?.name ?? "session"}`));

    const runAgents = run
      ? snapshot.agents.filter((agent) => agent.runId === run.id)
      : snapshot.agents;
    const activeAgents = runAgents.filter((agent) => isActiveStatus(agent.status)).length;
    const hasDetachedWork = activeAgents > 0;
    const runTokens = tokensFor(snapshot, run);
    const largeRun = runAgents.length > 25 || runTokens > 1_500_000;
    const elapsed = run
      ? formatDuration(((hasDetachedWork ? snapshot.now : run.finishedAt) ?? snapshot.now) - run.startedAt)
      : undefined;
    const summary = [
      run?.status,
      largeRun ? "⚠ large run" : undefined,
      `${activeAgents}/${runAgents.length} run agents active`,
      `${snapshot.actors.length} actors`,
      runTokens > 0 ? `${formatTokens(runTokens)} tok` : undefined,
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

    const terminalRows = this.tui.terminal?.rows ?? process.stdout.rows ?? 28;
    const maxBody = Math.max(2, Math.min(22, terminalRows - 12));
    if (innerWidth >= 88) {
      const leftWidth = Math.min(38, Math.max(28, Math.floor((innerWidth - 1) * 0.34)));
      const rightWidth = innerWidth - leftWidth - 1;
      const leftLines = this.renderPhasePanel(panels, leftWidth, maxBody);
      const rightLines = this.renderEntityPanel(entities, rightWidth, maxBody, snapshot.now);
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
      const panelRows = Math.max(2, maxBody - 1);
      const phaseHeight = Math.max(1, Math.min(panels.length + 1, Math.floor(panelRows * 0.45)));
      const entityHeight = Math.max(1, panelRows - phaseHeight);
      for (const line of this.renderPhasePanel(panels, innerWidth, phaseHeight)) {
        lines.push(this.row(width, line));
      }
      lines.push(this.row(width, this.theme.fg("borderMuted", "─".repeat(innerWidth))));
      for (const line of this.renderEntityPanel(entities, innerWidth, entityHeight, snapshot.now)) {
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
          `↑↓/jk select · ←→/tab pane · enter inspect · f filter:${this.filter} · [ older · ] newer · ? help · esc close`,
        ),
      ),
    );
    const selectedEntity = entities[this.entityIndex];
    const actionHint =
      this.pane === "entities" && selectedEntity
        ? this.theme.fg("muted", `  ${this.overviewActionHint(selectedEntity)}`)
        : "";
    lines.push(this.row(width, actionHint));
    lines.push(this.bottomBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private overviewActionHint(entity: Entity): string {
    if (entity.kind === "actor" && entity.status !== "stopped") {
      const actions = [
        this.modelSourceForActor(entity.value) && this.onActorModel ? "m model" : undefined,
        this.onActorThinking ? "e thinking" : undefined,
        this.onActorEvents ? "v events" : undefined,
        this.onActorInstructions ? "i instructions" : undefined,
        this.onClearMessages ? "c clear mailbox" : undefined,
        this.onExportActor ? "x export" : undefined,
        "enter details",
      ].filter((value): value is string => Boolean(value));
      return `actor actions: ${actions.join(" · ")}`;
    }
    if (entity.kind === "globalActor") {
      const actions = [
        this.onGlobalInstructions ? "i instructions" : undefined,
        this.onImportActor ? "p import" : undefined,
        this.onRemoveGlobalActor ? "d delete" : undefined,
        "enter details",
      ].filter((value): value is string => Boolean(value));
      return `template actions: ${actions.join(" · ")}`;
    }
    if (entity.kind === "agent") {
      const armed = this.pendingStop?.id === entity.value.id && this.pendingStop.expiresAt > Date.now();
      const actions = [
        this.agentTranscript
          ? `space ${isActiveStatus(entity.status) ? "live " : ""}transcript peek`
          : undefined,
        isActiveStatus(entity.status) && this.onAgentSteer ? "s steer" : undefined,
        this.onAgentFollowUp ? "u follow-up" : undefined,
        isActiveStatus(entity.status) && this.onAgentStop
          ? armed
            ? "x again to stop"
            : "x stop"
          : undefined,
        "enter details",
      ].filter((value): value is string => Boolean(value));
      return `agent actions: ${actions.join(" · ")}`;
    }
    return "enter details";
  }

  private renderPhasePanel(panels: PhasePanel[], width: number, height: number): string[] {
    const lines = [
      truncateToWidth(
        `${this.pane === "phases" ? this.theme.fg("accent", "▸ ") : "  "}${this.theme.fg(
          "accent",
          "Activity",
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
      if (selected && this.pane === "phases") {
        line = this.theme.bg("selectedBg", padToWidth(line, width));
      }
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
  ): string[] {
    const lines: string[] = [];
    const available = Math.max(0, height);
    const groupedRows: Array<
      | { type: "group"; group: EntityGroup }
      | { type: "spacer" }
      | { type: "entity"; entity: Entity; entityIndex: number }
    > = [];
    const groups = groupEntities(entities);
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex]!;
      if (groupIndex > 0) groupedRows.push({ type: "spacer" });
      groupedRows.push({ type: "group", group });
      for (const entry of group.entries) {
        groupedRows.push({ type: "entity", entity: entry.entity, entityIndex: entry.index });
      }
    }
    const selectedRow = Math.max(
      0,
      groupedRows.findIndex(
        (row) => row.type === "entity" && row.entityIndex === this.entityIndex,
      ),
    );
    const start = Math.max(
      0,
      Math.min(
        selectedRow - Math.floor(available / 2),
        Math.max(0, groupedRows.length - available),
      ),
    );
    for (let index = start; index < Math.min(groupedRows.length, start + available); index++) {
      const row = groupedRows[index];
      if (!row) continue;
      if (row.type === "spacer") {
        lines.push("");
        continue;
      }
      if (row.type === "group") {
        lines.push(
          truncateToWidth(
            this.theme.fg(
              "muted",
              `  ${this.theme.bold(row.group.label)} (${row.group.entries.length})`,
            ),
            width,
            "",
          ),
        );
        continue;
      }
      const entity = row.entity;
      const selected = row.entityIndex === this.entityIndex;
      const prefix = selected ? "› " : "  ";
      const lead = `${prefix}${colorStatus(this.theme, entity.status, statusGlyph(entity.status))} ${safeText(
        entity.label,
      )}`;
      const tail = safeText(entityTail(entity, now));
      let line = tail ? `${lead}  ${this.theme.fg("dim", tail)}` : lead;
      if (selected && this.pane === "entities") {
        line = this.theme.bg("selectedBg", padToWidth(line, width));
      }
      lines.push(truncateToWidth(line, width, ""));
    }
    if (entities.length === 0 && available > 0) {
      const label = this.filter === "all" ? "activity" : `${this.filter} activity`;
      lines.push(this.theme.fg("dim", `  (no ${label}; press f to change filter)`));
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private renderDetail(
    width: number,
    snapshot: FabricDashboardSnapshot,
    entity: Entity,
  ): string[] {
    if (width < 24) return this.renderNarrowDetail(width, snapshot, entity);
    const innerWidth = width - 2;
    const transcriptView = entity.kind === "agent" && this.detailView === "transcript";
    const actionLines = wrapPlainText(this.detailActionHint(entity), Math.max(1, innerWidth - 2), 3);
    const viewLabel = transcriptView
      ? ` · transcript · ${isActiveStatus(entity.status) ? "live" : entity.status}`
      : "";
    const lines = [this.topBorder(width, `${entity.kind} · ${entity.label}${viewLabel}`)];
    const content = transcriptView
      ? this.transcriptLines(entity.value, innerWidth)
      : this.detailLines(entity, innerWidth, snapshot.now);
    const terminalRows = this.tui.terminal?.rows ?? process.stdout.rows ?? 28;
    const maxBody = Math.max(1, Math.min(24, terminalRows - 8 - actionLines.length));
    const maxScroll = Math.max(0, content.length - maxBody);
    this.detailMaxScroll = maxScroll;
    if (transcriptView && this.transcriptFollowing) this.detailScroll = maxScroll;
    else this.detailScroll = Math.max(0, Math.min(this.detailScroll, maxScroll));
    const visible = content.slice(this.detailScroll, this.detailScroll + maxBody);
    for (const line of visible) lines.push(this.row(width, line));
    while (lines.length < maxBody + 1) lines.push(this.row(width, ""));
    lines.push(this.middleBorder(width));
    const range =
      content.length > maxBody
        ? ` · ${this.detailScroll + 1}-${Math.min(content.length, this.detailScroll + maxBody)}/${content.length}`
        : "";
    const navigation = transcriptView
      ? `↑↓/jk scroll · G follow:${this.transcriptFollowing ? "on" : "off"} · t summary · esc back${range}`
      : `↑↓/jk scroll · ${entity.kind === "agent" && this.agentTranscript ? "t transcript · " : ""}esc back${range}`;
    lines.push(this.row(width, this.theme.fg("dim", navigation)));
    for (const actionLine of actionLines) {
      lines.push(this.row(width, this.theme.fg("muted", `  ${actionLine}`)));
    }
    lines.push(this.bottomBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private transcriptLines(agent: FabricUiAgent, width: number): string[] {
    const transcript = this.agentTranscript?.(agent);
    if (!transcript || transcript.entries.length === 0) {
      return [
        this.theme.fg(
          "dim",
          isActiveStatus(agent.status)
            ? "Waiting for streamed agent activity…"
            : "No retained transcript is available for this agent.",
        ),
      ];
    }
    const lines: string[] = [];
    if (transcript.truncated) lines.push(this.theme.fg("dim", "… earlier activity omitted"));
    for (const entry of transcript.entries) {
      const glyph =
        entry.kind === "assistant"
          ? this.theme.fg("accent", "◆")
          : entry.kind === "error"
            ? this.theme.fg("error", "✗")
            : colorStatus(this.theme, entry.status ?? "completed", statusGlyph(entry.status ?? "completed"));
      const status =
        entry.status === "running" ? " · running" : entry.status === "failed" ? " · failed" : "";
      if (entry.kind === "tool") {
        const detail = entry.text ? ` · ${safeText(entry.text)}` : "";
        lines.push(
          truncateToWidth(
            `${glyph} ${this.theme.fg("muted", `${safeText(entry.label)}${status}${detail}`)}`,
            width,
            "",
          ),
        );
        continue;
      }
      lines.push(
        truncateToWidth(
          `${glyph} ${this.theme.fg(entry.kind === "assistant" ? "accent" : "muted", safeText(entry.label))}`,
          width,
          "",
        ),
      );
      if (!entry.text) continue;
      if (entry.kind === "assistant") {
        lines.push(...this.markdownTranscriptLines(agent.id, entry.id, entry.text, width));
        continue;
      }
      for (const paragraph of entry.text.split("\n")) {
        const wrapped = wrapPlainText(paragraph, Math.max(1, width - 2), 100);
        for (const line of wrapped) lines.push(truncateToWidth(`  ${line}`, width, ""));
      }
    }
    return lines;
  }

  private markdownTranscriptLines(
    agentId: string,
    entryId: string,
    text: string,
    width: number,
  ): string[] {
    return this.markdownLines(`transcript:${agentId}:${entryId}`, text, width);
  }

  private markdownLines(key: string, text: string, width: number, indent = 2): string[] {
    const markdown = safeMarkdownText(text);
    if (!markdown.trim()) return [];
    let cached = this.transcriptMarkdown.get(key);
    if (!cached || cached.text !== markdown) {
      cached = {
        text: markdown,
        component: new Markdown(
          markdown,
          0,
          0,
          transcriptMarkdownTheme(this.theme, () => {
            this.transcriptMarkdown.delete(key);
            this.tui.requestRender();
          }),
        ),
      };
      this.transcriptMarkdown.delete(key);
      this.transcriptMarkdown.set(key, cached);
      while (this.transcriptMarkdown.size > 128) {
        const oldest = this.transcriptMarkdown.keys().next().value as string | undefined;
        if (!oldest) break;
        this.transcriptMarkdown.delete(oldest);
      }
    }
    const padding = " ".repeat(Math.max(0, indent));
    return cached.component
      .render(Math.max(1, width - visibleWidth(padding)))
      .map((line) => truncateToWidth(`${padding}${line}`, width, ""));
  }

  private detailActionHint(entity: Entity): string {
    if (entity.kind === "agent") {
      const armed = this.pendingStop?.id === entity.value.id && this.pendingStop.expiresAt > Date.now();
      const actions = [
        isActiveStatus(entity.status) && this.onAgentSteer ? "s steer now" : undefined,
        this.onAgentFollowUp ? "u queue follow-up" : undefined,
        isActiveStatus(entity.status) && this.onAgentStop
          ? armed
            ? "x again to confirm stop"
            : "x stop"
          : undefined,
      ].filter((value): value is string => Boolean(value));
      const controls = actions.length > 0 ? `One-shot agent actions: ${actions.join(" · ")}. ` : "One-shot agent. ";
      return `${controls}Model and thinking are fixed at spawn; use a persistent actor for editable runtime settings.`;
    }
    if (entity.kind === "actor" && entity.status !== "stopped") {
      const actions = [
        this.modelSourceForActor(entity.value) && this.onActorModel ? "m model" : undefined,
        this.onActorThinking ? "e thinking" : undefined,
        this.onActorEvents ? "v events" : undefined,
        this.onClearMessages ? "c clear mailbox" : undefined,
        this.onActorInstructions ? "i instructions" : undefined,
        this.onExportActor ? "x export→global" : undefined,
      ].filter((value): value is string => Boolean(value));
      return actions.length > 0 ? `Actor actions: ${actions.join(" · ")}` : "Actor settings are read-only in this session.";
    }
    if (entity.kind === "globalActor") {
      const actions = [
        this.onGlobalInstructions ? "i instructions" : undefined,
        this.onImportActor ? "p import" : undefined,
        this.onRemoveGlobalActor ? "d delete" : undefined,
      ].filter((value): value is string => Boolean(value));
      return actions.length > 0 ? `Template actions: ${actions.join(" · ")}` : "Global template is read-only in this session.";
    }
    return "Read-only detail.";
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
    const markdownField = (label: string, value: string | undefined, key: string): void => {
      if (!value?.trim()) return;
      lines.push(this.theme.fg("dim", `${label}:`));
      lines.push(...this.markdownLines(`detail:${entity.id}:${key}`, value, width));
    };
    const structuredField = (label: string, value: unknown): void => {
      if (value === undefined) return;
      const yaml = formatJsonAsYaml(value);
      if (yaml === undefined) {
        field(label, value);
        return;
      }
      lines.push(this.theme.fg("dim", `${label}:`));
      const highlighted =
        highlightCode(yaml, "yaml", this.highlightInvalidate) ??
        yaml.split("\n").map((line) => this.theme.fg("mdCodeBlock", line || " "));
      for (const highlightedLine of highlighted) {
        for (const wrapped of wrapTextWithAnsi(highlightedLine, Math.max(1, width - 2))) {
          lines.push(truncateToWidth(`  ${wrapped}`, width, ""));
        }
      }
    };
    const stringOutputField = (label: string, value: unknown): void => {
      if (typeof value !== "string") return;
      markdownField(label, value, label.toLowerCase());
    };
    const objectOutputField = (label: string, value: Record<string, unknown>): void => {
      if (typeof value.output === "string" || typeof value.text === "string" || typeof value.content === "string") {
        stringOutputField(label, value.output ?? value.text ?? value.content);
        return;
      }
      structuredField(label, value);
    };
    const outputField = (label: string, value: unknown): void => {
      if (value === undefined) return;
      if (typeof value === "string") {
        stringOutputField(label, value);
        return;
      }
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        objectOutputField(label, value as Record<string, unknown>);
        return;
      }
      structuredField(label, value);
    };
    const argumentField = (call: FabricActivityCall): void => {
      const args = call.args;
      if (!args || Object.keys(args).length === 0) return;
      const stringValue = (key: string): string | undefined =>
        typeof args[key] === "string" ? args[key] : undefined;
      if (call.ref === "pi.bash") {
        const command = stringValue("command");
        if (command) markdownField("Command", "```bash\n" + command + "\n```", "command");
      }
      const edits = Array.isArray(args.edits) ? args.edits : [];
      if (call.ref === "pi.edit" && edits.length > 0) {
        lines.push(this.theme.fg("dim", "Edits:"));
        const diff = nestedEditDiff(
          {
            ref: call.ref,
            tool: call.ref.split(".")[1] ?? call.ref,
            args,
          },
          this.theme,
          this.highlightInvalidate,
        );
        if (diff) {
          for (const line of diff) lines.push(truncateToWidth(`  ${line}`, width, ""));
        } else {
          structuredField("Edits", edits);
        }
      }
      const content = stringValue("content");
      if (call.ref === "pi.write" && content !== undefined) {
        const path = stringValue("path") ?? "";
        const extension = path.includes(".") ? path.split(".").at(-1) : "";
        markdownField("Content", "```" + (extension || "text") + "\n" + content + "\n```", "content");
      }
      const renderedKeys = new Set(["command", "edits", "content"]);
      const remaining = Object.fromEntries(
        Object.entries(args).filter(([key]) => !renderedKeys.has(key)),
      );
      if (Object.keys(remaining).length > 0) structuredField("Input", remaining);
    };
    field("Status", entity.status);

    if (entity.kind === "agent") {
      const agent = entity.value;
      field("ID", agent.id);
      field("Runner", agent.runner);
      field("Model", agent.model);
      field("Thinking", agent.thinking);
      field("Transport", agent.transport);
      field("Activity", agent.currentTool);
      field("Elapsed", agent.startedAt ? formatDuration((agent.finishedAt ?? now) - agent.startedAt) : undefined);
      field("Usage", agent.usage ? `${formatTokens(agent.usage.input + agent.usage.output)} tokens · ${agent.toolCalls ?? 0} tools · ${agent.turns ?? 0} turns · $${agent.usage.cost.toFixed(4)}` : undefined);
      markdownField("Task", agent.task, "task");
      field("Branch", agent.branch);
      field("Worktree", agent.worktree);
      field("Attach", agent.attachCommand);
      field("Error", agent.error);
      markdownField("Result", agent.text, "result");
      structuredField("Value", agent.value);
    } else if (entity.kind === "actor") {
      const actor = entity.value;
      field("ID", actor.id);
      field("Runner", actor.runner);
      field("Model override", actor.model ?? "inherit");
      field("Active worker model", actor.worker?.model);
      field("Thinking override", actor.thinking ?? "inherit");
      field("Active worker thinking", actor.worker?.thinking);
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
          const text = message.text ?? message.error ?? message.action ?? "data";
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
      field("Kind", call.entityKind ?? call.kind);
      field("Progress", call.progress);
      field("Elapsed", formatDuration((call.finishedAt ?? now) - call.startedAt));
      field("Tokens", call.metrics?.tokens);
      field("Tool calls", call.metrics?.toolCalls);
      field("Cost", call.metrics?.cost);
      field("Entity", call.entityId);
      argumentField(call);
      field("Error", call.error);
      outputField("Output", call.result);
    } else if (entity.kind === "item") {
      const item = entity.value;
      field("ID", item.id);
      field("Kind", item.kind);
      field("Progress", item.total !== undefined ? `${item.completed ?? 0}/${item.total}` : undefined);
      field("Current", item.current);
      field("Detail", item.detail);
      structuredField("Data", item.data);
    } else if (entity.kind === "globalActor") {
      const def = entity.value;
      field("Scope", "global template");
      field("ID", def.id);
      field("Runner", def.runner);
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
      structuredField("Value", entry.value);
    }
    return lines.length > 0 ? lines : [this.theme.fg("dim", "No details")];
  }

  private syncEntitySelection(entities: Entity[]): void {
    if (entities.length === 0) {
      this.entityIndex = 0;
      this.selectedEntityId = undefined;
      return;
    }
    const retainedIndex = this.selectedEntityId
      ? entities.findIndex((entity) => entity.id === this.selectedEntityId)
      : -1;
    this.entityIndex =
      retainedIndex >= 0
        ? retainedIndex
        : Math.max(0, Math.min(this.entityIndex, entities.length - 1));
    this.selectedEntityId = entities[this.entityIndex]?.id;
  }

  private selectRun(snapshot: FabricDashboardSnapshot): FabricActivityRun | undefined {
    if (snapshot.runs.length === 0) {
      this.runIndex = 0;
      this.selectedRunId = undefined;
      return undefined;
    }
    if (!this.runSelectionTouched) {
      this.runIndex = 0;
      this.selectedRunId = snapshot.runs[0]?.id;
      return snapshot.runs[0];
    }
    const retainedIndex = this.selectedRunId
      ? snapshot.runs.findIndex((run) => run.id === this.selectedRunId)
      : -1;
    this.runIndex =
      retainedIndex >= 0
        ? retainedIndex
        : Math.max(0, Math.min(this.runIndex, snapshot.runs.length - 1));
    this.selectedRunId = snapshot.runs[this.runIndex]?.id;
    return snapshot.runs[this.runIndex];
  }

  private syncPhase(run: FabricActivityRun | undefined, panels: PhasePanel[]): void {
    if (panels.length === 0) {
      this.phaseIndex = 0;
      this.selectedPhaseId = undefined;
      return;
    }
    if (!this.phaseSelectionTouched) {
      const current = run?.currentPhaseId
        ? panels.findIndex((panel) => panel.id === run.currentPhaseId)
        : -1;
      const activeRunActivity = panels.findIndex(
        (panel) => panel.kind === "unphased" && isActiveStatus(panel.status),
      );
      if (current >= 0 && isActiveStatus(panels[current]!.status)) {
        this.phaseIndex = current;
      } else if (activeRunActivity >= 0) {
        this.phaseIndex = activeRunActivity;
      } else if (current >= 0) {
        this.phaseIndex = current;
      } else {
        this.phaseIndex = 0;
      }
    } else {
      const retainedIndex = this.selectedPhaseId
        ? panels.findIndex((panel) => panel.id === this.selectedPhaseId)
        : -1;
      this.phaseIndex =
        retainedIndex >= 0
          ? retainedIndex
          : Math.max(0, Math.min(this.phaseIndex, panels.length - 1));
    }
    this.phaseIndex = Math.max(0, Math.min(this.phaseIndex, panels.length - 1));
    this.selectedPhaseId = panels[this.phaseIndex]?.id;
  }

  private resetSelection(): void {
    this.phaseIndex = 0;
    this.entityIndex = 0;
    this.selectedEntityId = undefined;
    this.phaseSelectionTouched = false;
    this.selectedPhaseId = undefined;
    this.detailId = undefined;
    this.detailScroll = 0;
    this.detailMaxScroll = 0;
    this.detailSelectionRestore = undefined;
    this.detailView = "summary";
    this.transcriptFollowing = true;
    this.pane = "phases";
  }

  private pinDetailSelection(
    run: FabricActivityRun | undefined,
    panel: PhasePanel | undefined,
  ): void {
    this.detailSelectionRestore ??= {
      runSelectionTouched: this.runSelectionTouched,
      phaseSelectionTouched: this.phaseSelectionTouched,
    };
    this.runSelectionTouched = true;
    this.selectedRunId = run?.id;
    this.phaseSelectionTouched = true;
    this.selectedPhaseId = panel?.id;
  }

  private closeDetail(): void {
    const restore = this.detailSelectionRestore;
    if (restore) {
      this.runSelectionTouched = restore.runSelectionTouched;
      this.phaseSelectionTouched = restore.phaseSelectionTouched;
    }
    this.detailSelectionRestore = undefined;
    this.detailId = undefined;
    this.detailScroll = 0;
    this.detailMaxScroll = 0;
    this.detailView = "summary";
    this.transcriptFollowing = true;
  }

  private renderNarrowDetail(
    width: number,
    snapshot: FabricDashboardSnapshot,
    entity: Entity,
  ): string[] {
    const transcriptView = entity.kind === "agent" && this.detailView === "transcript";
    const content = transcriptView
      ? this.transcriptLines(entity.value, width)
      : this.detailLines(entity, width, snapshot.now);
    const terminalRows = this.tui.terminal?.rows ?? process.stdout.rows ?? 28;
    const maxBody = Math.max(1, terminalRows - 2);
    this.detailMaxScroll = Math.max(0, content.length - maxBody);
    if (transcriptView && this.transcriptFollowing) this.detailScroll = this.detailMaxScroll;
    else this.detailScroll = Math.max(0, Math.min(this.detailScroll, this.detailMaxScroll));
    const title = `${entity.label}${transcriptView ? " · transcript" : ""}`;
    const hint = transcriptView
      ? `G follow:${this.transcriptFollowing ? "on" : "off"} · t summary · esc`
      : `${entity.kind === "agent" && this.agentTranscript ? "t transcript · " : ""}esc`;
    return [title, ...content.slice(this.detailScroll, this.detailScroll + maxBody), hint]
      .map((line) => truncateToWidth(line, width, ""))
      .filter((line) => visibleWidth(line) > 0);
  }

  private renderNarrowFallback(width: number, label: string, hint: string): string[] {
    return [safeText(label), hint]
      .map((line) => truncateToWidth(line, width, ""))
      .filter((line) => visibleWidth(line) > 0);
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
