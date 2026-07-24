import { type Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Focusable, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { FABRIC_ACTOR_HOST_EVENTS } from "../actors/types.js";
import type { FabricActorHostEvent } from "../actors/types.js";

const COMMON_HOST_EVENTS: readonly FabricActorHostEvent[] = [
  "input",
  "turn_end",
  "agent_settled",
  "tool_error",
  "session_compact",
];
const commonHostEvents = new Set<FabricActorHostEvent>(COMMON_HOST_EVENTS);
const MAX_VISIBLE_HOST_EVENTS = 12;
const HOST_EVENT_ORDER: readonly FabricActorHostEvent[] = [
  ...COMMON_HOST_EVENTS,
  ...FABRIC_ACTOR_HOST_EVENTS.filter((event) => !commonHostEvents.has(event)),
];

const EVENT_LABELS: Record<FabricActorHostEvent, string> = {
  input: "raw user or extension input",
  turn_end: "each completed LLM turn",
  agent_settled: "host fully idle after a run",
  tool_error: "synthetic notification for a failed tool",
  session_compact: "context was compacted",
  resources_discover: "skills, prompts, and themes are discovered",
  session_start: "a session starts, reloads, or is restored",
  session_info_changed: "session metadata or name changed",
  session_before_switch: "before a new or resumed session replaces this one",
  session_before_fork: "before a session fork or clone",
  session_before_compact: "before context compaction",
  session_shutdown: "before this session runtime shuts down",
  session_before_tree: "before session-tree navigation",
  session_tree: "after session-tree navigation",
  before_agent_start: "expanded prompt and system context before the agent loop",
  agent_start: "a low-level agent run started",
  agent_end: "a low-level agent run ended",
  turn_start: "an LLM turn started",
  message_start: "a user, assistant, or tool message started",
  message_update: "an assistant streaming update",
  message_end: "a user, assistant, or tool message completed",
  context: "assembled messages before an LLM request",
  before_provider_headers: "outbound provider headers assembled; secrets redacted",
  before_provider_request: "provider payload assembled before sending",
  after_provider_response: "provider response status and headers received",
  tool_execution_start: "tool execution started",
  tool_call: "validated tool call before execution",
  tool_execution_update: "streaming tool progress",
  tool_result: "final tool result before message persistence",
  tool_execution_end: "tool execution completed",
  model_select: "the active model changed",
  thinking_level_select: "the active thinking level changed",
  user_bash: "a user ! or !! shell command was submitted",
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
 * supported host events are shown with a [x]/[ ] checkbox; space toggles the
 * row under the cursor, Enter applies the selection, and Esc cancels.
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
    const total = HOST_EVENT_ORDER.length;
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(MAX_VISIBLE_HOST_EVENTS / 2),
        total - MAX_VISIBLE_HOST_EVENTS,
      ),
    );
    const endIndex = Math.min(startIndex + MAX_VISIBLE_HOST_EVENTS, total);
    if (startIndex > 0) {
      this.listContainer.addChild(
        new Text(this.theme.fg("dim", `  ↑ ${startIndex} earlier events`), 0, 0),
      );
    }
    for (let index = startIndex; index < endIndex; index++) {
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
    if (endIndex < total) {
      this.listContainer.addChild(
        new Text(this.theme.fg("dim", `  ↓ ${total - endIndex} later events`), 0, 0),
      );
    }
    this.listContainer.addChild(new Spacer(1));
    this.listContainer.addChild(
      new Text(this.theme.fg("muted", "  space toggle · enter apply · esc cancel"), 0, 0),
    );
  }
}
