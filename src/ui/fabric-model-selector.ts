import { type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  fuzzyFilter,
  getKeybindings,
  Input,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { INHERIT_VALUE, modelKey, sortByLastUsed, type ModelLike, type ModelSource } from "./model-picker.js";

/** A single pickable row in the Fabric model selector. */
interface ModelEntry {
  /** Value persisted to fabric.json: "Inherit" or `provider/id`. */
  value: string;
  /** Main text shown for the row (the model id, or "Inherit"). */
  id: string;
  /** Provider badge shown after the id; empty for the Inherit row. */
  provider: string;
  /** Human-readable name shown in the footer line. */
  name: string;
  /** Whether this is a real model (vs. the Inherit sentinel). */
  isModel: boolean;
}

export interface FabricModelSelectorOptions {
  theme: Theme;
  source: ModelSource;
  /** The currently configured canonical model key or "Inherit". */
  currentValue: string;
  onSelect: (value: string) => void;
  onCancel: () => void;
  /** Header line above the search input. Defaults to the global-default wording. */
  headerText?: string;
  /** Label shown for the unset/default row. Defaults to Inherit. */
  inheritLabel?: string;
  /** Description shown for the unset/default row's footer name. */
  inheritName?: string;
}

/**
 * A /model-style searchable model picker adapted for Fabric: same look
 * (search input, list with `[provider]` badges and a ✓ on
 * the current row, scroll indicator, and a "Model Name:" footer) but it writes
 * the Fabric default-model setting instead of the host's default model, and
 * pins an unset/default row on top. Order respects pi-model-sort (most recently
 * used first); search filters by fuzzy match and re-sorts by recency, matching
 * pi-model-sort's patched /model behavior.
 */
export class FabricModelSelector extends Container implements Focusable {
  private readonly theme: Theme;
  private readonly allEntries: ModelEntry[];
  private filteredEntries: ModelEntry[];
  private readonly lastUsed: Record<string, number>;
  private readonly currentKey: string | null;
  private readonly currentValue: string;
  private selectedIndex = 0;
  private readonly searchInput: Input;
  private readonly listContainer = new Container();
  private readonly onSelectCallback: (value: string) => void;
  private readonly onCancelCallback: () => void;
  private readonly headerText: string;
  private readonly inheritLabel: string;
  private readonly inheritName: string;
  private _focused = false;

  constructor(options: FabricModelSelectorOptions) {
    super();
    this.theme = options.theme;
    this.lastUsed = options.source.lastUsed;
    this.currentValue = options.currentValue;
    this.currentKey = options.currentValue === INHERIT_VALUE ? null : options.currentValue;
    this.onSelectCallback = options.onSelect;
    this.onCancelCallback = options.onCancel;
    this.headerText =
      options.headerText ??
      "Default model for Fabric agents and actors. Pick Inherit to use the host session's model.";
    this.inheritLabel = options.inheritLabel ?? INHERIT_VALUE;
    this.inheritName = options.inheritName ?? "Use the host session's default model";

    this.allEntries = this.buildEntries(options.source.models);
    this.filteredEntries = this.allEntries;
    const current = this.allEntries.findIndex((entry) => entry.value === this.currentValue);
    this.selectedIndex = current >= 0 ? current : 0;

    this.addChild(
      new Text(
        this.theme.fg("muted", this.headerText),
        0,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.searchInput = new Input();
    this.searchInput.focused = true;
    this.searchInput.onSubmit = () => {
      const entry = this.filteredEntries[this.selectedIndex];
      if (entry) this.handleSelect(entry);
    };
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.updateList();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    if (kb.matches(keyData, "tui.select.up")) {
      if (this.filteredEntries.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0 ? this.filteredEntries.length - 1 : this.selectedIndex - 1;
      this.updateList();
    } else if (kb.matches(keyData, "tui.select.down")) {
      if (this.filteredEntries.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.filteredEntries.length - 1 ? 0 : this.selectedIndex + 1;
      this.updateList();
    } else if (kb.matches(keyData, "tui.select.confirm")) {
      const entry = this.filteredEntries[this.selectedIndex];
      if (entry) this.handleSelect(entry);
    } else if (kb.matches(keyData, "tui.select.cancel")) {
      this.onCancelCallback();
    } else {
      this.searchInput.handleInput(keyData);
      this.filterModels(this.searchInput.getValue());
    }
  }

  private handleSelect(entry: ModelEntry): void {
    this.onSelectCallback(entry.value);
  }

  private buildEntries(models: ModelLike[]): ModelEntry[] {
    const sorted = sortByLastUsed(models, this.lastUsed, this.currentKey);
    const inherit: ModelEntry = {
      value: INHERIT_VALUE,
      id: this.inheritLabel,
      provider: "",
      name: this.inheritName,
      isModel: false,
    };
    const modelEntries: ModelEntry[] = sorted.map((model) => ({
      value: modelKey(model.provider, model.id),
      id: model.id,
      provider: model.provider,
      name: model.name ?? model.id,
      isModel: true,
    }));
    return [inherit, ...modelEntries];
  }

  /** Filter by fuzzy match, then re-sort by recency (mirrors pi-model-sort). */
  private sortEntries(entries: ModelEntry[]): ModelEntry[] {
    const inherit = entries.find((entry) => !entry.isModel);
    const models = entries.filter((entry) => entry.isModel);
    const sorted = sortByLastUsed(
      models.map((entry) => ({ provider: entry.provider, id: entry.id, entry })),
      this.lastUsed,
      this.currentKey,
    ).map((item) => item.entry);
    return inherit ? [inherit, ...sorted] : sorted;
  }

  private filterModels(query: string): void {
    const matches = query.trim()
      ? fuzzyFilter(this.allEntries, query, (entry) => this.searchText(entry))
      : this.allEntries;
    this.filteredEntries = this.sortEntries(matches);
    const current = this.filteredEntries.findIndex((entry) => entry.value === this.currentValue);
    this.selectedIndex =
      current >= 0
        ? current
        : Math.min(this.selectedIndex, Math.max(0, this.filteredEntries.length - 1));
    this.updateList();
  }

  /** Mirrors getModelSelectorSearchText from pi's /model selector. */
  private searchText(entry: ModelEntry): string {
    if (!entry.isModel) return `${entry.id} ${entry.name}`;
    return `${entry.provider} ${entry.provider}/${entry.id} ${entry.provider} ${entry.id} ${entry.name}`;
  }

  private updateList(): void {
    this.listContainer.clear();
    const maxVisible = 10;
    const total = this.filteredEntries.length;
    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(maxVisible / 2), total - maxVisible),
    );
    const endIndex = Math.min(startIndex + maxVisible, total);
    for (let i = startIndex; i < endIndex; i++) {
      const entry = this.filteredEntries[i];
      if (!entry) continue;
      const isSelected = i === this.selectedIndex;
      const isCurrent = entry.value === this.currentValue;
      const badge = entry.provider ? ` ${this.theme.fg("muted", `[${entry.provider}]`)}` : "";
      const check = isCurrent ? this.theme.fg("success", " ✓") : "";
      const line = isSelected
        ? `${this.theme.fg("accent", "\u2192 ")}${this.theme.fg("accent", entry.id)}${badge}${check}`
        : `  ${entry.id}${badge}${check}`;
      this.listContainer.addChild(new Text(line, 0, 0));
    }
    if (startIndex > 0 || endIndex < total) {
      this.listContainer.addChild(
        new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${total})`), 0, 0),
      );
    }
    if (total === 0) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching models"), 0, 0));
    } else {
      const selected = this.filteredEntries[this.selectedIndex];
      this.listContainer.addChild(new Spacer(1));
      this.listContainer.addChild(
        new Text(
          this.theme.fg("muted", `  Model Name: ${selected ? selected.name : ""}`),
          0,
          0,
        ),
      );
    }
  }
}
