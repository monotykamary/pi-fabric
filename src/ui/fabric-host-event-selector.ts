import { type Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Focusable, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import type { FabricActorHostEvent } from "../actors/types.js";

const HOST_EVENT_ORDER: readonly FabricActorHostEvent[] = [
  "input",
  "turn_end",
  "agent_settled",
  "tool_error",
  "session_compact",
];

const EVENT_LABELS: Record<FabricActorHostEvent, string> = {
  input: "user submitted a message",
  turn_end: "each LLM sub-turn while the agent is working",
  agent_settled: "host fully idle after a run (decision point)",
  tool_error: "a tool call failed",
  session_compact: "context was compacted",
};

export interface FabricHostEventSelectorOptions {
  theme: Theme;
  /** Currently enabled host events for the actor. */
  currentValue: FabricActorHostEvent[];
  onSelect: (events: FabricActorHostEvent[]) => void;
  onCancel: () => void;
  headerText?: string;
}

/**
 * A compact multi-select picker for an actor's host-event subscriptions. The
 * fixed set of host events is shown with a [x]/[ ] checkbox; space toggles the
 * row under the cursor, Enter applies the selection, Esc cancels. No search —
 * the set is small and fixed.
 */
export class FabricHostEventSelector extends Container implements Focusable {
  private readonly theme: Theme;
  private readonly onSelectCallback: (events: FabricActorHostEvent[]) => void;
  private readonly onCancelCallback: () => void;
  private readonly listContainer = new Container();
  private enabled: Set<FabricActorHostEvent>;
  private selectedIndex = 0;
  focused = false;

  constructor(options: FabricHostEventSelectorOptions) {
    super();
    this.theme = options.theme;
    this.onSelectCallback = options.onSelect;
    this.onCancelCallback = options.onCancel;
    this.enabled = new Set(options.currentValue);
    this.addChild(
      new Text(
        this.theme.fg(
          "muted",
          options.headerText ?? "Toggle the host events this actor subscribes to.",
        ),
        0,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.updateList();
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    if (kb.matches(keyData, "tui.select.up")) {
      this.selectedIndex =
        this.selectedIndex === 0 ? HOST_EVENT_ORDER.length - 1 : this.selectedIndex - 1;
      this.updateList();
    } else if (kb.matches(keyData, "tui.select.down")) {
      this.selectedIndex =
        this.selectedIndex === HOST_EVENT_ORDER.length - 1 ? 0 : this.selectedIndex + 1;
      this.updateList();
    } else if (keyData === " ") {
      const event = HOST_EVENT_ORDER[this.selectedIndex];
      if (event) {
        if (this.enabled.has(event)) this.enabled.delete(event);
        else this.enabled.add(event);
        this.updateList();
      }
    } else if (kb.matches(keyData, "tui.select.confirm")) {
      this.onSelectCallback(HOST_EVENT_ORDER.filter((event) => this.enabled.has(event)));
    } else if (kb.matches(keyData, "tui.select.cancel")) {
      this.onCancelCallback();
    }
  }

  private updateList(): void {
    this.listContainer.clear();
    for (let index = 0; index < HOST_EVENT_ORDER.length; index++) {
      const event = HOST_EVENT_ORDER[index]!;
      const selected = index === this.selectedIndex;
      const checked = this.enabled.has(event);
      const box = checked ? this.theme.fg("success", "[x]") : this.theme.fg("dim", "[ ]");
      const label = `${box} ${event} · ${this.theme.fg("muted", EVENT_LABELS[event])}`;
      const line = selected
        ? `${this.theme.fg("accent", "→ ")}${this.theme.fg("accent", label)}`
        : `  ${label}`;
      this.listContainer.addChild(new Text(line, 0, 0));
    }
    this.listContainer.addChild(new Spacer(1));
    this.listContainer.addChild(
      new Text(this.theme.fg("muted", "  space toggle · enter apply · esc cancel"), 0, 0),
    );
  }
}
