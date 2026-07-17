import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { FabricActorHostEvent } from "../actors/types.js";
import type { FabricState } from "../fabric-state.js";
import type { FabricThinking } from "../thinking.js";
import type { MeshEvent } from "../mesh/store.js";
import { FabricDashboard } from "./dashboard.js";
import { buildModelSource } from "./model-picker.js";
import { createDashboardSnapshot } from "./snapshot.js";
import { type FabricDashboardSnapshot } from "./types.js";
import { FabricWidget, shouldShowFabricWidget } from "./widget.js";

const WIDGET_ID = "pi-fabric";

const emptySnapshot = (): FabricDashboardSnapshot => ({
  now: Date.now(),
  runs: [],
  agents: [],
  actors: [],
  globalActors: [],
  state: [],
  events: [],
});

export class FabricUiController {
  #context: ExtensionContext | undefined;
  #snapshot: FabricDashboardSnapshot = emptySnapshot();
  #events: MeshEvent[] = [];
  #meshOffset = 0;
  #timer: NodeJS.Timeout | undefined;
  #activityUnsubscribe: (() => void) | undefined;
  #scheduledRefresh: NodeJS.Timeout | undefined;
  #widgetTui: TUI | undefined;
  #widgetMounted = false;
  #widget: FabricWidget | undefined;

  constructor(readonly state: FabricState) {}

  start(context: ExtensionContext): void {
    this.stop();
    this.#context = context;
    if (!this.state.config.ui.enabled || context.mode !== "tui") return;
    if (this.state.config.mesh.enabled) {
      this.#events = this.state.mesh.read({ limit: this.state.config.ui.eventHistory });
      this.#meshOffset = this.state.mesh.latestOffset();
    }
    this.#activityUnsubscribe = this.state.activity.subscribe(() => this.#scheduleRefresh());
    this.#refresh();
    this.#timer = setInterval(() => this.#refresh(), this.state.config.ui.refreshMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#scheduledRefresh) clearTimeout(this.#scheduledRefresh);
    this.#timer = undefined;
    this.#scheduledRefresh = undefined;
    this.#widget = undefined;
    this.#activityUnsubscribe?.();
    this.#activityUnsubscribe = undefined;
    if (this.#context?.mode === "tui") {
      this.#context.ui.setWidget(WIDGET_ID, undefined);
    }
    this.#context = undefined;
    this.#widgetTui = undefined;
    this.#widgetMounted = false;
    this.#events = [];
    this.#meshOffset = 0;
    this.#snapshot = emptySnapshot();
  }

  async openDashboard(context: ExtensionContext): Promise<void> {
    if (context.mode !== "tui") {
      context.ui.notify("The Fabric dashboard is available in TUI mode", "warning");
      return;
    }
    if (!this.state.config.ui.enabled) {
      context.ui.notify("The Fabric UI is disabled by ui.enabled", "warning");
      return;
    }
    if (!this.#context) this.start(context);
    else this.#refresh();
    const modelSource = buildModelSource(context.modelRegistry);
    const reportUpdate = (message: string, update: Promise<unknown>): void => {
      void update
        .then(() => {
          context.ui.notify(message, "info");
          this.#refresh();
        })
        .catch((error) =>
          context.ui.notify(error instanceof Error ? error.message : String(error), "error"),
        );
    };
    const onAgentSteer = (agentId: string, message: string): void => {
      reportUpdate("Steer queued for agent", Promise.resolve(this.state.subagents.steer(agentId, message)));
    };
    const onAgentFollowUp = (agentId: string, message: string): void => {
      reportUpdate(
        "Follow-up queued for agent",
        Promise.resolve(this.state.subagents.followUp(agentId, message)),
      );
    };
    const onAgentStop = (agentId: string): void => {
      reportUpdate("Agent stopped", this.state.subagents.stop(agentId));
    };
    const onActorModel = (actorId: string, model: string | undefined): void => {
      reportUpdate("Actor model updated", this.state.actors.setModel(actorId, model));
    };
    const onActorThinking = (actorId: string, thinking: FabricThinking | undefined): void => {
      reportUpdate("Actor thinking level updated", this.state.actors.setThinking(actorId, thinking));
    };
    const onActorEvents = (actorId: string, events: FabricActorHostEvent[]): void => {
      reportUpdate("Actor event subscriptions updated", this.state.actors.setEvents(actorId, events));
    };
    const onClearMessages = (actorId: string): void => {
      reportUpdate("Actor mailbox cleared", this.state.actors.clearMessages(actorId));
    };
    const onActorInstructions = (actorId: string, instructions: string): void => {
      reportUpdate("Actor instructions updated", this.state.actors.setInstructions(actorId, instructions));
    };
    const onGlobalInstructions = (globalActorId: string, instructions: string): void => {
      try {
        this.state.globalActors.update(globalActorId, { instructions });
        context.ui.notify("Global actor instructions updated", "info");
        this.#refresh();
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    };
    const onImportActor = (globalActorId: string): void => {
      const def = this.state.globalActors.resolve(globalActorId);
      if (!def) return;
      this.state.actors
        .create(this.state.globalActors.toRequest(def))
        .then((actor) => {
          context.ui.notify(`Imported global actor "${def.name}" as ${actor.name}`, "info");
          this.#refresh();
        })
        .catch((error) =>
          context.ui.notify(error instanceof Error ? error.message : String(error), "error"),
        );
    };
    const onExportActor = (actorId: string): void => {
      try {
        const def = this.state.actors.definition(actorId);
        const template = this.state.globalActors.create(def);
        context.ui.notify(`Exported "${template.name}" to global actors`, "info");
        this.#refresh();
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    };
    const onRemoveGlobalActor = (globalActorId: string): void => {
      try {
        const result = this.state.globalActors.remove(globalActorId);
        context.ui.notify(
          result.removed ? "Removed global actor template" : "Global actor not found",
          result.removed ? "info" : "warning",
        );
        this.#refresh();
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    };
    await context.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        new FabricDashboard(tui, theme, () => this.#snapshot, () => done(undefined), {
          modelSource,
          onAgentSteer,
          onAgentFollowUp,
          onAgentStop,
          onActorModel,
          onActorThinking,
          onActorEvents,
          onClearMessages,
          onActorInstructions,
          onGlobalInstructions,
          onImportActor,
          onExportActor,
          onRemoveGlobalActor,
        }),
      {
        overlay: true,
        overlayOptions: {
          width: "94%",
          minWidth: 40,
          maxHeight: "90%",
          anchor: "center",
          margin: 1,
        },
      },
    );
  }

  snapshot(): FabricDashboardSnapshot {
    return structuredClone(this.#snapshot);
  }

  dismissOnSettle(): void {
    this.state.widgetDismissedAt = Date.now();
    this.#scheduleRefresh();
  }

  #scheduleRefresh(): void {
    if (this.#scheduledRefresh || !this.#context) return;
    this.#scheduledRefresh = setTimeout(() => {
      this.#scheduledRefresh = undefined;
      this.#refresh();
    }, 16);
    this.#scheduledRefresh.unref();
  }

  #refresh(): void {
    const context = this.#context;
    if (!context || !this.state.initialized) return;
    try {
      this.#pollMesh();
      this.#snapshot = createDashboardSnapshot(this.state, this.#events);
      this.#renderWidget(context);
      if (this.#widgetTui && this.#widget?.hasChanged()) this.#widgetTui.requestRender();
    } catch {
      return;
    }
  }

  #pollMesh(): void {
    if (!this.state.config.mesh.enabled) return;
    const result = this.state.mesh.tail(this.#meshOffset, this.state.config.ui.eventHistory);
    this.#meshOffset = result.nextOffset;
    if (result.events.length === 0) return;
    this.#events.push(...result.events);
    const limit = this.state.config.ui.eventHistory;
    if (this.#events.length > limit) this.#events.splice(0, this.#events.length - limit);
  }

  #renderWidget(context: ExtensionContext): void {
    const config = this.state.config.ui;
    const shouldShow =
      context.mode === "tui" &&
      shouldShowFabricWidget(this.#snapshot, config.widget);
    if (shouldShow) {
      if (this.#widgetMounted) return;
      this.#widgetMounted = true;
      context.ui.setWidget(
        WIDGET_ID,
        (tui, theme) => {
          this.#widgetTui = tui;
          this.#widget = new FabricWidget(theme, () => this.#snapshot, config.maxRows);
          return this.#widget;
        },
        { placement: "aboveEditor" },
      );
      return;
    }
    if (!this.#widgetMounted) return;
    context.ui.setWidget(WIDGET_ID, undefined);
    this.#widgetMounted = false;
    this.#widgetTui = undefined;
    this.#widget = undefined;
  }
}
