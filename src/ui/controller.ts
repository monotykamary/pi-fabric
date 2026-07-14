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
    const onActorModel = (actorId: string, model: string | undefined): void => {
      this.state.actors.setModel(actorId, model).catch(() => undefined);
    };
    const onActorThinking = (actorId: string, thinking: FabricThinking | undefined): void => {
      this.state.actors.setThinking(actorId, thinking).catch(() => undefined);
    };
    const onActorEvents = (actorId: string, events: FabricActorHostEvent[]): void => {
      this.state.actors.setEvents(actorId, events).catch(() => undefined);
    };
    const onClearMessages = (actorId: string): void => {
      this.state.actors.clearMessages(actorId).catch(() => undefined);
    };
    await context.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        new FabricDashboard(tui, theme, () => this.#snapshot, () => done(undefined), {
          modelSource,
          onActorModel,
          onActorThinking,
          onActorEvents,
          onClearMessages,
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
