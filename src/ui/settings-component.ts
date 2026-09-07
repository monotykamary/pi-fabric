import {
  Key,
  type SettingItem,
  Container,
  SettingsList,
  Text,
  Spacer,
  matchesKey,
} from "@earendil-works/pi-tui";
import type { FabricConfigScope } from "../config.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "./dynamic-border.js";
import { settingsListTheme } from "./settings-submenus.js";

const SAVE_SCOPE_SHORTCUT = Key.ctrl("g");

export interface FabricSettingsComponentOptions {
  initialSaveScope?: FabricConfigScope;
  projectScopeAvailable?: boolean;
  onSaveScopeChange?: (scope: FabricConfigScope) => void;
  itemsForSaveScope?: (scope: FabricConfigScope) => SettingItem[];
}

export class FabricSettingsComponent extends Container {
  settingsList: SettingsList;
  private readonly theme: Theme;
  private readonly saveScopeText: Text;
  private readonly settingsListContainer: Container;
  private readonly projectScopeAvailable: boolean;
  private readonly onChange: (id: string, newValue: string) => void;
  private readonly onCancel: () => void;
  private readonly onSaveScopeChange: (scope: FabricConfigScope) => void;
  private readonly itemsForSaveScope: ((scope: FabricConfigScope) => SettingItem[]) | undefined;
  private saveScope: FabricConfigScope;

  constructor(
    theme: Theme,
    items: SettingItem[],
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void,
    options: FabricSettingsComponentOptions = {},
  ) {
    super();
    this.theme = theme;
    this.projectScopeAvailable = options.projectScopeAvailable ?? true;
    this.saveScope = options.initialSaveScope === "global" || !this.projectScopeAvailable
      ? "global"
      : "project";
    this.onChange = onChange;
    this.onCancel = onCancel;
    this.onSaveScopeChange = options.onSaveScopeChange ?? (() => {});
    this.itemsForSaveScope = options.itemsForSaveScope;
    this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
    this.saveScopeText = new Text("", 1, 0);
    this.updateSaveScopeText();
    this.addChild(this.saveScopeText);
    this.addChild(new Spacer(1));
    this.settingsListContainer = new Container();
    this.settingsList = this.createSettingsList(items);
    this.settingsListContainer.addChild(this.settingsList);
    this.addChild(this.settingsListContainer);
    this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
  }

  handleInput(data: string): void {
    if (matchesKey(data, SAVE_SCOPE_SHORTCUT)) {
      if (!this.projectScopeAvailable) return;
      this.saveScope = this.saveScope === "project" ? "global" : "project";
      this.updateSaveScopeText();
      this.onSaveScopeChange(this.saveScope);
      const nextItems = this.itemsForSaveScope?.(this.saveScope);
      if (nextItems) {
        this.settingsListContainer.clear();
        this.settingsList = this.createSettingsList(nextItems);
        this.settingsListContainer.addChild(this.settingsList);
      }
      return;
    }
    this.settingsList.handleInput(data);
  }

  private createSettingsList(items: SettingItem[]): SettingsList {
    return new SettingsList(
      items,
      10,
      settingsListTheme(this.theme),
      this.onChange,
      this.onCancel,
      { enableSearch: true },
    );
  }

  private updateSaveScopeText(): void {
    const destination = this.saveScope === "project"
      ? "Project overrides (.pi/fabric.json)"
      : "Global defaults (~/.pi/agent/fabric.json)";
    const hint = !this.projectScopeAvailable
      ? " · project scope unavailable for untrusted projects"
      : this.saveScope === "global"
        ? " · Ctrl+G switches scope · project overrides may remain active here"
        : " · Ctrl+G switches scope";
    this.saveScopeText.setText(
      this.theme.fg("muted", "Editing: ") +
      this.theme.fg("accent", destination) +
      this.theme.fg("dim", hint),
    );
  }
}
