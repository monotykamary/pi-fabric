import type { SettingItem } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  unique,
  COMPACTION_DEFAULT_THRESHOLD_LABEL,
  COMPACTION_PERCENT_OPTION_LABEL,
  COMPACTION_TOKENS_OPTION_LABEL,
  parseFormattedNumericValue,
  clampCompactionPercentThreshold,
  formatTokens,
} from "./settings-values.js";
import {
  SectionSubmenu,
  SelectSubmenu,
  IntegerInputSubmenu,
  StringInputSubmenu,
  CompactionThresholdSubmenu,
} from "./settings-submenus.js";
import {
  clampCompactionTokenThreshold,
  type FabricConfigScope,
} from "../config.js";
import { FabricModelSelector } from "./fabric-model-selector.js";

// RPC needs only dialog primitives, not the terminal UI or the runtime state.
type SettingsRpcContext = {
  ui: Pick<ExtensionContext["ui"], "select" | "input" | "notify">;
};

const RPC_BACK = "← Back";

const RPC_DONE = "Done";

const RPC_SWITCH_SCOPE = "Switch save scope";

type RpcChoice = {
  value: string;
  label: string;
  description?: string;
  current?: boolean;
};

const rpcTitle = (path: string, description?: string): string =>
  description ? `${path}\n${description}` : path;

const cleanSettingLabel = (label: string): string => label.replace(/\s+›$/, "");

const rpcSettingRow = (item: SettingItem): string => {
  const label = cleanSettingLabel(item.label);
  const current = item.currentValue ? ` · ${item.currentValue}` : "";
  return item.description
    ? `${label}${current} — ${item.description}`
    : `${label}${current}`;
};

const rpcChoiceRow = (choice: RpcChoice): string => {
  const current = choice.current ? " · Current" : "";
  return choice.description
    ? `${choice.label}${current} — ${choice.description}`
    : `${choice.label}${current}`;
};

const selectRpcChoice = async (
  context: SettingsRpcContext,
  title: string,
  choices: RpcChoice[],
): Promise<string | undefined> => {
  const rows = choices.map(rpcChoiceRow);
  const selected = await context.ui.select(title, rows);
  if (selected === undefined) return undefined;
  const index = rows.indexOf(selected);
  return index < 0 ? undefined : choices[index]?.value;
};

const browseRpcSettings = async (
  context: SettingsRpcContext,
  path: string,
  description: string | undefined,
  items: SettingItem[],
  onChange: (id: string, newValue: string) => void,
): Promise<void> => {
  while (true) {
    const rows = items.map(rpcSettingRow);
    const selected = await context.ui.select(rpcTitle(path, description), [...rows, RPC_BACK]);
    if (selected === undefined || selected === RPC_BACK) return;
    const index = rows.indexOf(selected);
    const item = index < 0 ? undefined : items[index];
    if (!item) continue;
    await editRpcSetting(context, `${path} › ${cleanSettingLabel(item.label)}`, item, onChange);
  }
};

const editRpcSetting = async (
  context: SettingsRpcContext,
  path: string,
  item: SettingItem,
  onChange: (id: string, newValue: string) => void,
): Promise<void> => {
  if (!item.submenu) {
    const values = item.values ?? [];
    if (values.length === 0) {
      context.ui.notify(`${cleanSettingLabel(item.label)} is read-only`, "info");
      return;
    }
    const selected = await selectRpcChoice(
      context,
      rpcTitle(path, item.description),
      unique([item.currentValue, ...values]).map((value) => ({
        value,
        label: value,
        current: value === item.currentValue,
      })),
    );
    if (selected === undefined) return;
    item.currentValue = selected;
    onChange(item.id, selected);
    return;
  }

  let completed = false;
  let selectedValue: string | undefined;
  const component = item.submenu(item.currentValue, (value) => {
    completed = true;
    selectedValue = value;
  });

  if (component instanceof SectionSubmenu) {
    await browseRpcSettings(
      context,
      path,
      item.description,
      component.items,
      (id, value) => {
        const child = component.items.find((candidate) => candidate.id === id);
        if (child) child.currentValue = value;
        component.applyChange(id, value);
      },
    );
    return;
  }

  if (component instanceof SelectSubmenu) {
    const selected = await selectRpcChoice(
      context,
      rpcTitle(path, item.description),
      component.options.map((option) => ({
        value: option.value,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
        current: option.value === item.currentValue || option.label === item.currentValue,
      })),
    );
    if (selected === undefined || !component.selectRpc(selected)) return;
  } else if (component instanceof IntegerInputSubmenu) {
    while (!completed) {
      const value = await context.ui.input(rpcTitle(path, item.description), component.input.getValue());
      if (value === undefined) return;
      if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value.trim()))) {
        context.ui.notify("Enter a non-negative safe integer.", "warning");
        continue;
      }
      component.submitRpc(value);
    }
  } else if (component instanceof StringInputSubmenu) {
    const value = await context.ui.input(rpcTitle(path, item.description), component.input.getValue());
    if (value === undefined) return;
    component.submitRpc(value);
  } else if (component instanceof CompactionThresholdSubmenu) {
    const selected = await selectRpcChoice(
      context,
      rpcTitle(path, item.description),
      [
        { value: COMPACTION_DEFAULT_THRESHOLD_LABEL, label: COMPACTION_DEFAULT_THRESHOLD_LABEL, current: item.currentValue === COMPACTION_DEFAULT_THRESHOLD_LABEL },
        { value: COMPACTION_PERCENT_OPTION_LABEL, label: COMPACTION_PERCENT_OPTION_LABEL, current: item.currentValue.endsWith("%") },
        { value: COMPACTION_TOKENS_OPTION_LABEL, label: COMPACTION_TOKENS_OPTION_LABEL, current: item.currentValue.endsWith(" tokens") },
      ],
    );
    if (selected === undefined) return;
    if (selected === COMPACTION_DEFAULT_THRESHOLD_LABEL) {
      component.completeRpc(selected);
    } else {
      const percent = /^(\d+)%$/.exec(item.currentValue)?.[1] ?? "";
      const tokenText = /^(.+?) tokens$/.exec(item.currentValue)?.[1];
      const placeholder = selected === COMPACTION_PERCENT_OPTION_LABEL
        ? percent
        : tokenText === undefined ? "" : String(parseFormattedNumericValue(tokenText));
      const input = await context.ui.input(rpcTitle(path, item.description), placeholder);
      if (input === undefined || !/^\d+$/.test(input.trim())) return;
      const numeric = Number(input.trim());
      component.completeRpc(
        selected === COMPACTION_PERCENT_OPTION_LABEL
          ? `${clampCompactionPercentThreshold(numeric)}%`
          : `${formatTokens(clampCompactionTokenThreshold(numeric))} tokens`,
      );
    }
  } else if (component instanceof FabricModelSelector) {
    const selected = await selectRpcChoice(
      context,
      rpcTitle(path, item.description),
      component.rpcChoices().map((choice) => ({
        value: choice.value,
        label: choice.label,
        description: choice.description,
        current: choice.current,
      })),
    );
    if (selected === undefined || !component.selectRpc(selected)) return;
  } else {
    context.ui.notify(`${cleanSettingLabel(item.label)} requires terminal UI`, "warning");
    return;
  }

  if (!completed || selectedValue === undefined) return;
  item.currentValue = selectedValue;
  onChange(item.id, selectedValue);
};

export const openRpcFabricSettings = async (
  context: SettingsRpcContext,
  options: {
    projectScopeAvailable: boolean;
    getScope: () => FabricConfigScope;
    setScope: (scope: FabricConfigScope) => void;
    itemsForScope: (scope: FabricConfigScope) => SettingItem[];
    persist: (id: string, value: string) => void;
  },
): Promise<void> => {
  while (true) {
    const scope = options.getScope();
    const items = options.itemsForScope(scope);
    const rows = items.map(rpcSettingRow);
    const scopeDestination = scope === "project"
      ? "Project overrides (.pi/fabric.json)"
      : "Global defaults (~/.pi/agent/fabric.json)";
    const controls = [
      ...(options.projectScopeAvailable ? [`${RPC_SWITCH_SCOPE} · ${scope === "project" ? "Global defaults" : "Project overrides"}`] : []),
      RPC_DONE,
    ];
    const selected = await context.ui.select(
      rpcTitle("Fabric settings", `Editing: ${scopeDestination}`),
      [...rows, ...controls],
    );
    if (selected === undefined || selected === RPC_DONE) return;
    if (selected.startsWith(RPC_SWITCH_SCOPE)) {
      options.setScope(scope === "project" ? "global" : "project");
      continue;
    }
    const index = rows.indexOf(selected);
    const item = index < 0 ? undefined : items[index];
    if (!item) continue;
    await editRpcSetting(context, `Fabric settings › ${cleanSettingLabel(item.label)}`, item, options.persist);
  }
};
