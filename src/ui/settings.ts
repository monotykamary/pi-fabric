import {
  DynamicBorder,
  getAgentDir,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Component,
  SelectList,
  type SelectItem,
  type SelectListLayoutOptions,
  type SelectListTheme,
  SettingsList,
  type SettingItem,
  type SettingsListTheme,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { FabricModelSelector } from "./fabric-model-selector.js";
import {
  buildClaudeModelSource,
  buildModelSource,
  INHERIT_VALUE,
  type ModelSource,
} from "./model-picker.js";
import {
  MAX_EXECUTOR_MEMORY_LIMIT_BYTES,
  saveFabricConfig,
  type FabricConfig,
} from "../config.js";
import { THINKING_LEVELS, thinkingLabel } from "../thinking.js";
import type { CapturedToolCatalog } from "../capture/catalog.js";
import type { FabricState } from "../fabric-state.js";

const SUBMENU_LAYOUT: SelectListLayoutOptions = {
  minPrimaryColumnWidth: 12,
  maxPrimaryColumnWidth: 32,
};

const BOOLEANS = ["true", "false"] as const;
const APPROVAL_MODES = ["allow", "ask", "deny"] as const;
const RUNNERS = ["pi", "claude"] as const;
const TRANSPORTS = ["auto", "process", "tmux", "screen", "localterm", "herdr"] as const;
const WIDGET_MODES = ["auto", "always", "hidden"] as const;
const RESULT_FORMATS = ["auto", "yaml", "json", "text"] as const;
const COMPACTION_ENGINES = ["fabric", "pi"] as const;
const ACTOR_SCOPES = ["project", "session"] as const;
const RISKS = ["read", "write", "execute", "network", "agent"] as const;
const CORE_RISK_TOOLS = ["read", "grep", "find", "edit", "write", "bash"] as const;
const CORE_DEFAULT_TOOL_CANDIDATES = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const BUDGET_VALUES = [0, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
const TOKEN_VALUES = [0, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000];
const ROOT_ITEM_IDS = [
  "fullCodeMode",
  "executor",
  "approvals",
  "mcp",
  "subagents",
  "capture",
  "ui",
  "compaction",
  "mesh",
] as const;
const RELOAD_SECTIONS = new Set(["mesh", "subagents", "mcp"]);

const unique = (values: readonly string[]): string[] => [...new Set(values)];

type SettingsSubmenu = (currentValue: string, done: (selectedValue?: string) => void) => Component;

const settingsListTheme = (theme: Theme): SettingsListTheme => ({
  label: (text, selected) => (selected ? theme.fg("accent", text) : text),
  value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
  description: (text) => theme.fg("dim", text),
  cursor: theme.fg("accent", "→ "),
  hint: (text) => theme.fg("dim", text),
});

const selectListTheme = (theme: Theme): SelectListTheme => ({
  selectedPrefix: (text) => theme.fg("accent", text),
  selectedText: (text) => theme.fg("accent", text),
  description: (text) => theme.fg("muted", text),
  scrollInfo: (text) => theme.fg("muted", text),
  noMatch: (text) => theme.fg("muted", text),
});

const formatDebounce = (ms: number): string =>
  ms === 0 ? "Off" : ms < 1_000 ? `${ms}ms` : `${ms / 1_000}s`;

const formatMs = (ms: number): string =>
  ms < 60_000
    ? `${Math.round(ms / 1_000)}s`
    : ms < 3_600_000
      ? `${ms / 60_000}m`
      : `${ms / 3_600_000}h`;

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 * 1024
    ? `${Number((bytes / (1024 * 1024 * 1024)).toFixed(2))} GB`
    : bytes >= 1024 * 1024
      ? `${Number((bytes / (1024 * 1024)).toFixed(2))} MB`
      : `${Number((bytes / 1024).toFixed(2))} KB`;

export const executorMemoryLimitOptions = (
  maximumBytes = MAX_EXECUTOR_MEMORY_LIMIT_BYTES,
): number[] => {
  const minimumBytes = 16 * 1024 * 1024;
  const values: number[] = [];
  for (let value = minimumBytes; value <= maximumBytes; value *= 2) values.push(value);
  if (maximumBytes >= minimumBytes && values.at(-1) !== maximumBytes) values.push(maximumBytes);
  return values;
};

const formatUsd = (value: number): string =>
  value <= 0 ? "Off" : `$${value.toFixed(2)}`;

const formatTokens = (value: number): string =>
  value <= 0
    ? "Off"
    : value >= 1_000_000
      ? `${value / 1_000_000}M`
      : value >= 1_000
        ? `${value / 1_000}k`
        : String(value);

const formatToolCount = (count: number): string =>
  `${count} ${count === 1 ? "tool" : "tools"}`;

const numericOptions = (
  values: readonly number[],
  format: (value: number) => string,
  currentValue: string,
): SelectItem[] => {
  const options: SelectItem[] = values.map((value) => ({
    value: String(value),
    label: format(value),
  }));
  if (!options.some((option) => option.value === currentValue || option.label === currentValue)) {
    options.unshift({ value: currentValue, label: currentValue });
  }
  return options;
};

const getPath = (config: FabricConfig, id: string): unknown => {
  const segments = id.split(".");
  let current: unknown = config;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

export const parseBudgetValue = (value: string): number => {
  if (value === "Off") return 0;
  const digits = Number.parseFloat(value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(digits) ? digits : 0;
};

const coerceValue = (id: string, value: string, config: FabricConfig): unknown => {
  const current = getPath(config, id);
  if (typeof current === "boolean") return value === "true";
  if (typeof current === "number") {
    // budgetUsd is the only currency field; its submenu values are formatted
    // as "$0.10" / "Off", so strip the currency formatting before coercing.
    if (id === "subagents.budgetUsd") return parseBudgetValue(value);
    if (id === "ui.nestedToolDebounceMs") {
      if (value === "Off") return 0;
      const parsed = Number.parseFloat(value);
      return value.endsWith("s") && !value.endsWith("ms") ? parsed * 1_000 : parsed;
    }
    return Number(value);
  }
  // The model picker stores the canonical "provider/id" string, or "Inherit"
  // for no override; persist an empty string so normalizeFabricConfig drops it
  // and the subagent inherits the host's default model.
  if (id === "subagents.model" || id === "subagents.claude.model") {
    return value === INHERIT_VALUE ? "" : value;
  }
  return value;
};

const buildPartial = (id: string, value: unknown): Record<string, unknown> => {
  const segments = id.split(".");
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index];
    if (segment === undefined) break;
    const next: Record<string, unknown> = {};
    current[segment] = next;
    current = next;
  }
  const last = segments[segments.length - 1];
  if (last !== undefined) current[last] = value;
  return root;
};

const summaryFor = (id: string, config: FabricConfig): string => {
  switch (id) {
    case "fullCodeMode":
      return config.fullCodeMode ? "true" : "false";
    case "executor":
      return formatMs(config.executor.timeoutMs);
    case "approvals":
      return config.approvals.execute;
    case "mcp":
      return config.mcp.enabled ? "enabled" : "disabled";
    case "subagents":
      return `${config.subagents.runner}/${config.subagents.transport}`;
    case "capture":
      return config.capture.enabled ? "enabled" : "disabled";
    case "ui":
      return config.ui.widget;
    case "compaction":
      return config.compaction.engine;
    case "mesh":
      return config.mesh.enabled ? "enabled" : "disabled";
    default:
      return "";
  }
};

const setting = (
  id: string,
  label: string,
  currentValue: string,
  rest: {
    description?: string;
    values?: readonly string[];
    submenu?: SettingsSubmenu;
  } = {},
): SettingItem => {
  const item: SettingItem = { id, label, currentValue };
  if (rest.description !== undefined) item.description = rest.description;
  if (rest.values !== undefined) item.values = [...rest.values];
  if (rest.submenu !== undefined) item.submenu = rest.submenu;
  return item;
};

const numericSubmenu = (
  theme: Theme,
  values: readonly number[],
  format: (value: number) => string,
  title: string,
  description: string,
): SettingsSubmenu => (currentValue, done) => {
  const options = numericOptions(values, format, currentValue);
  const selectedValue =
    options.find((option) => option.value === currentValue || option.label === currentValue)?.value ??
    currentValue;
  return new SelectSubmenu(
    theme,
    title,
    description,
    options,
    selectedValue,
    (value) => done(value),
    () => done(),
  );
};

const listSubmenu = (
  theme: Theme,
  id: string,
  title: string,
  description: string,
  candidates: readonly string[],
  currentList: readonly string[],
  onCommit: (selected: string[]) => void,
): SettingsSubmenu => {
  const prefix = `${id}.`;
  return (_currentValue, done) => {
    const items = unique([...candidates, ...currentList]).map((name) =>
      setting(`${id}.${name}`, name, currentList.includes(name) ? "true" : "false", {
        description: `Toggle ${name}.`,
        values: BOOLEANS,
      }),
    );
    const onChange = (_itemId: string, _newValue: string): void => {
      const selected = items
        .filter((item) => item.currentValue === "true")
        .map((item) => item.id.slice(prefix.length));
      onCommit(selected);
    };
    return new SectionSubmenu(theme, title, description, items, onChange, () => done(), true);
  };
};

// Append a › to the label of every item that opens a submenu, so it is
// obvious which rows drill in (vs. inline value cycling). Mutates in place to
// preserve the shared item references that listSubmenu updates live.
const markDrillIn = (items: SettingItem[]): SettingItem[] => {
  for (const item of items) {
    if (item.submenu && !item.label.endsWith("›")) item.label = `${item.label} ›`;
  }
  return items;
};

const sectionSubmenu = (
  theme: Theme,
  title: string,
  description: string,
  items: SettingItem[],
  persist: (id: string, value: string) => void,
): SettingsSubmenu => (_currentValue, done) =>
  new SectionSubmenu(theme, title, description, markDrillIn(items), persist, () => done());

class SelectSubmenu extends Container {
  readonly selectList: SelectList;

  constructor(
    theme: Theme,
    title: string,
    description: string | undefined,
    options: SelectItem[],
    currentValue: string,
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) {
    super();
    this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
    if (description) {
      this.addChild(new Spacer(1));
      this.addChild(new Text(theme.fg("muted", description), 0, 0));
    }
    this.addChild(new Spacer(1));
    this.selectList = new SelectList(
      options,
      Math.min(options.length, 10),
      selectListTheme(theme),
      SUBMENU_LAYOUT,
    );
    const index = options.findIndex((option) => option.value === currentValue);
    if (index !== -1) this.selectList.setSelectedIndex(index);
    this.selectList.onSelect = (item) => onSelect(item.value);
    this.selectList.onCancel = onCancel;
    this.addChild(this.selectList);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
  }

  handleInput(data: string): void {
    this.selectList.handleInput(data);
  }
}

const thinkingSubmenu = (
  theme: Theme,
  currentValue: string,
): SettingsSubmenu => (_currentValue, done) => {
  const options: SelectItem[] = THINKING_LEVELS.map((level) => ({
    value: level,
    label: thinkingLabel(level),
  }));
  if (!options.some((option) => option.value === currentValue)) {
    options.unshift({ value: currentValue, label: currentValue });
  }
  return new SelectSubmenu(
    theme,
    "Default thinking",
    "Reasoning effort forwarded to spawned subagents and actors when a call does not specify one. The level is clamped to each model's supported levels (next highest if unsupported).",
    options,
    currentValue,
    (value) => done(value),
    () => done(),
  );
};

const modelPickerSubmenu = (
  theme: Theme,
  source: ModelSource,
  currentValue: string,
  options: { headerText?: string; inheritName?: string } = {},
): SettingsSubmenu => (_currentValue, done) =>
  new FabricModelSelector({
    theme,
    source,
    currentValue,
    onSelect: (value) => done(value),
    onCancel: () => done(),
    ...(options.headerText ? { headerText: options.headerText } : {}),
    ...(options.inheritName ? { inheritName: options.inheritName } : {}),
  });

class SectionSubmenu extends Container {
  readonly settingsList: SettingsList;

  constructor(
    theme: Theme,
    title: string,
    description: string | undefined,
    items: SettingItem[],
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void,
    enableSearch = false,
  ) {
    super();
    this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
    if (description) {
      this.addChild(new Spacer(1));
      this.addChild(new Text(theme.fg("muted", description), 0, 0));
    }
    this.addChild(new Spacer(1));
    this.settingsList = new SettingsList(
      items,
      Math.min(items.length, 16),
      settingsListTheme(theme),
      onChange,
      onCancel,
      { enableSearch },
    );
    this.addChild(this.settingsList);
  }

  handleInput(data: string): void {
    this.settingsList.handleInput(data);
  }
}

export class FabricSettingsComponent extends Container {
  readonly settingsList: SettingsList;

  constructor(
    theme: Theme,
    items: SettingItem[],
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void,
  ) {
    super();
    this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
    this.settingsList = new SettingsList(items, 10, settingsListTheme(theme), onChange, onCancel, {
      enableSearch: true,
    });
    this.addChild(this.settingsList);
    this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
  }

  handleInput(data: string): void {
    this.settingsList.handleInput(data);
  }
}

export const buildFabricSettingsItems = (
  theme: Theme,
  config: FabricConfig,
  apply: (id: string, value: unknown) => void,
  options: {
    keepVisibleCandidates: readonly string[];
    modelSource: ModelSource;
    claudeModelSource?: ModelSource;
  },
): SettingItem[] => {
  const persist = (id: string, newValue: string): void =>
    apply(id, coerceValue(id, newValue, config));
  const envFullCode = process.env.PI_FABRIC_FULL_CODE_MODE;
  const fullCodeDescription = envFullCode
    ? "Fabric owns Pi core tools (read, bash, edit, write, grep, find, ls) via fabric_exec. Currently overridden by the PI_FABRIC_FULL_CODE_MODE environment variable."
    : "Fabric owns Pi core tools (read, bash, edit, write, grep, find, ls) via fabric_exec. Disable to keep native tools model-facing (orchestration-only mode).";

  const defaultToolsItem = setting(
    "subagents.defaultTools",
    "Default tools",
    formatToolCount(config.subagents.defaultTools.length),
    { description: "Pi core tools exposed to spawned subagents by default." },
  );
  defaultToolsItem.submenu = listSubmenu(
    theme,
    "subagents.defaultTools",
    "Default tools",
    "Pi core tools exposed to spawned subagents by default.",
    CORE_DEFAULT_TOOL_CANDIDATES,
    config.subagents.defaultTools,
    (selected) => {
      apply("subagents.defaultTools", selected);
      defaultToolsItem.currentValue = formatToolCount(selected.length);
    },
  );

  const keepVisibleItem = setting(
    "capture.keepVisible",
    "Keep visible",
    formatToolCount(config.capture.keepVisible.length),
    { description: "Captured tool names that stay model-visible despite hideFromModel." },
  );
  keepVisibleItem.submenu = listSubmenu(
    theme,
    "capture.keepVisible",
    "Keep visible",
    "Captured tool names that stay model-visible despite hideFromModel.",
    options.keepVisibleCandidates,
    config.capture.keepVisible,
    (selected) => {
      apply("capture.keepVisible", selected);
      keepVisibleItem.currentValue = formatToolCount(selected.length);
    },
  );

  const items = [
    setting("fullCodeMode", "Full code mode", config.fullCodeMode ? "true" : "false", {
      description: fullCodeDescription,
      values: BOOLEANS,
    }),
    setting("executor", "Executor", summaryFor("executor", config), {
      description: "QuickJS sandbox resource limits for fabric_exec programs.",
      submenu: sectionSubmenu(
        theme,
        "Executor",
        "QuickJS sandbox resource limits for fabric_exec programs.",
        [
          setting("executor.timeoutMs", "Timeout", formatMs(config.executor.timeoutMs), {
            description: "Maximum wall-clock time for a single fabric_exec program.",
            submenu: numericSubmenu(
              theme,
              [15_000, 30_000, 60_000, 120_000, 300_000, 600_000],
              formatMs,
              "Executor timeout",
              "Maximum wall-clock time for a single fabric_exec program.",
            ),
          }),
          setting(
            "executor.memoryLimitBytes",
            "Memory limit",
            formatBytes(config.executor.memoryLimitBytes),
            {
              description:
                "Maximum QuickJS heap size for a single fabric_exec program. The upper bound is this machine's physical memory; large allocations may destabilize the system.",
              submenu: numericSubmenu(
                theme,
                executorMemoryLimitOptions(),
                formatBytes,
                "Executor memory limit",
                "Maximum QuickJS heap size for a single fabric_exec program. The upper bound is this machine's physical memory; large allocations may destabilize the system.",
              ),
            },
          ),
          setting("executor.maxOutputChars", "Max output chars", String(config.executor.maxOutputChars), {
            description: "Character cap applied to the final fabric_exec return value shown to the model.",
            submenu: numericSubmenu(
              theme,
              [20_000, 50_000, 100_000, 200_000, 500_000],
              (n) => n.toLocaleString(),
              "Max output chars",
              "Character cap applied to the final fabric_exec return value shown to the model.",
            ),
          }),
          setting("executor.resultFormat", "Result format", config.executor.resultFormat, {
            description:
              "Default formatting for fabric_exec return values. Auto renders structured values as syntax-highlighted YAML; each call can override this.",
            values: RESULT_FORMATS,
          }),
          setting(
            "executor.maxNestedResultChars",
            "Max nested result chars",
            String(config.executor.maxNestedResultChars),
            {
              description: "Character cap applied to results returned by nested tool calls inside the sandbox.",
              submenu: numericSubmenu(
                theme,
                [500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000],
                (n) => n.toLocaleString(),
                "Max nested result chars",
                "Character cap applied to results returned by nested tool calls inside the sandbox.",
              ),
            },
          ),
        ],
        persist,
      ),
    }),
    setting("approvals", "Approvals", summaryFor("approvals", config), {
      description: "Per-action approval policy for tools invoked from inside fabric_exec.",
      submenu: sectionSubmenu(
        theme,
        "Approvals",
        "Per-action approval policy for tools invoked from inside fabric_exec.",
        [
          setting("approvals.read", "Read", config.approvals.read, {
            description: "Approval policy for read operations.",
            values: APPROVAL_MODES,
          }),
          setting("approvals.write", "Write", config.approvals.write, {
            description: "Approval policy for write and edit operations.",
            values: APPROVAL_MODES,
          }),
          setting("approvals.execute", "Execute", config.approvals.execute, {
            description: "Approval policy for shell execution.",
            values: APPROVAL_MODES,
          }),
          setting("approvals.network", "Network", config.approvals.network, {
            description: "Approval policy for network operations.",
            values: APPROVAL_MODES,
          }),
          setting("approvals.agent", "Agent", config.approvals.agent, {
            description: "Approval policy for subagent and actor operations.",
            values: APPROVAL_MODES,
          }),
        ],
        persist,
      ),
    }),
    setting("mcp", "MCP", summaryFor("mcp", config), {
      description: "Model Context Protocol provider discovery and invocation.",
      submenu: sectionSubmenu(
        theme,
        "MCP",
        "Model Context Protocol provider discovery and invocation.",
        [
          setting("mcp.enabled", "Enabled", config.mcp.enabled ? "true" : "false", {
            description: "Enable the MCP provider inside fabric_exec.",
            values: BOOLEANS,
          }),
          setting("mcp.disableOAuth", "Disable OAuth", config.mcp.disableOAuth ? "true" : "false", {
            description: "Skip MCP OAuth flows.",
            values: BOOLEANS,
          }),
          setting("mcp.allowDynamicServers", "Dynamic servers", config.mcp.allowDynamicServers ? "true" : "false", {
            description: "Allow servers to be added at runtime via the MCP protocol.",
            values: BOOLEANS,
          }),
          setting("mcp.callTimeoutMs", "Call timeout", formatMs(config.mcp.callTimeoutMs), {
            description: "Timeout for individual MCP tool calls.",
            submenu: numericSubmenu(
              theme,
              [15_000, 30_000, 60_000, 120_000, 300_000],
              formatMs,
              "MCP call timeout",
              "Timeout for individual MCP tool calls.",
            ),
          }),
        ],
        persist,
      ),
    }),
    setting("subagents", "Subagents", summaryFor("subagents", config), {
      description: "One-shot child agents spawned from inside fabric_exec.",
      submenu: sectionSubmenu(
        theme,
        "Subagents",
        "One-shot child agents spawned from inside fabric_exec.",
        [
          setting("subagents.enabled", "Enabled", config.subagents.enabled ? "true" : "false", {
            description: "Enable subagent spawning via workflow.agent() and agents.run().",
            values: BOOLEANS,
          }),
          setting("subagents.runner", "Default runner", config.subagents.runner, {
            description: "Execution harness used when agents.run/create does not specify runner.",
            values: RUNNERS,
          }),
          setting("subagents.transport", "Transport", config.subagents.transport, {
            description: "Preferred transport for spawned subagents.",
            values: TRANSPORTS,
          }),
          setting("subagents.model", "Default model", config.subagents.model || INHERIT_VALUE, {
            description:
              "Model forwarded to Pi-backed subagents and actors when a call does not specify one. Pick Inherit to use the host session's default. Order matches pi-model-sort (most recently used first).",
            submenu: modelPickerSubmenu(
              theme,
              options.modelSource,
              config.subagents.model || INHERIT_VALUE,
            ),
          }),
          setting(
            "subagents.claude.model",
            "Claude model",
            config.subagents.claude.model || INHERIT_VALUE,
            {
              description:
                "Claude Code model used by Claude-backed agents and actors. Models are enumerated from the installed claude runtime; Inherit uses Claude Code's default.",
              submenu: modelPickerSubmenu(
                theme,
                options.claudeModelSource ?? { models: [], lastUsed: {} },
                config.subagents.claude.model || INHERIT_VALUE,
                {
                  headerText:
                    "Default model for Claude-backed Fabric agents and actors. Pick Inherit to use Claude Code's runtime default.",
                  inheritName: "Use Claude Code's runtime default model",
                },
              ),
            },
          ),
          setting("subagents.thinking", "Default thinking", thinkingLabel(config.subagents.thinking), {
            description:
              "Reasoning effort forwarded to spawned subagents and actors when a call does not specify one. Clamped to each model's supported levels (next highest if unsupported).",
            submenu: thinkingSubmenu(theme, config.subagents.thinking),
          }),
          setting("subagents.maxConcurrent", "Max concurrent", String(config.subagents.maxConcurrent), {
            description: "Maximum number of subagents that may run at the same time.",
            submenu: numericSubmenu(
              theme,
              [1, 2, 4, 8, 16, 32],
              String,
              "Subagent concurrency",
              "Maximum number of subagents that may run at the same time.",
            ),
          }),
          setting("subagents.maxPerExecution", "Max per execution", String(config.subagents.maxPerExecution), {
            description: "Maximum number of subagent calls allowed within a single fabric_exec program.",
            submenu: numericSubmenu(
              theme,
              [10, 25, 50, 100, 200, 500],
              String,
              "Subagents per execution",
              "Maximum number of subagent calls allowed within a single fabric_exec program.",
            ),
          }),
          setting("subagents.maxDepth", "Max depth", String(config.subagents.maxDepth), {
            description: "Maximum nesting depth for recursive subagent calls.",
            submenu: numericSubmenu(
              theme,
              [0, 1, 2, 3, 4, 6],
              String,
              "Subagent depth",
              "Maximum nesting depth for recursive subagent calls.",
            ),
          }),
          setting("subagents.budgetUsd", "Recursion budget", formatUsd(config.subagents.budgetUsd), {
            description:
              "Maximum USD spend for subagent work across the whole recursion tree. 0 disables the budget.",
            submenu: numericSubmenu(
              theme,
              BUDGET_VALUES,
              formatUsd,
              "Recursion budget",
              "Maximum USD spend for subagent work across the whole recursion tree. 0 disables the budget.",
            ),
          }),
          setting("subagents.maxTokensPerChild", "Token limit", formatTokens(config.subagents.maxTokensPerChild), {
            description:
              "Maximum cumulative tokens a single subagent may use before it is terminated (0 disables). Caps a runaway child before the host session compacts.",
            submenu: numericSubmenu(
              theme,
              TOKEN_VALUES,
              formatTokens,
              "Subagent token limit",
              "Maximum cumulative tokens a single subagent may use before it is terminated (0 disables).",
            ),
          }),
          setting("subagents.timeoutMs", "Timeout", formatMs(config.subagents.timeoutMs), {
            description: "Wall-clock timeout for a single subagent run.",
            submenu: numericSubmenu(
              theme,
              [60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000],
              formatMs,
              "Subagent timeout",
              "Wall-clock timeout for a single subagent run.",
            ),
          }),
          setting("subagents.extensions", "Extensions", config.subagents.extensions ? "true" : "false", {
            description: "Allow subagents to load registered extensions.",
            values: BOOLEANS,
          }),
          defaultToolsItem,
          setting("subagents.retainRuns", "Retain runs", config.subagents.retainRuns ? "true" : "false", {
            description: "Keep completed subagent run artifacts for later inspection.",
            values: BOOLEANS,
          }),
          setting("subagents.notifyOnComplete", "Notify on complete", config.subagents.notifyOnComplete ? "true" : "false", {
            description: "Post a message when a background subagent completes.",
            values: BOOLEANS,
          }),
        ],
        persist,
      ),
    }),
    setting("capture", "Capture", summaryFor("capture", config), {
      description: "Registered tool capture and model visibility policy.",
      submenu: sectionSubmenu(
        theme,
        "Capture",
        "Registered tool capture and model visibility policy.",
        [
          setting("capture.enabled", "Enabled", config.capture.enabled ? "true" : "false", {
            description: "Capture registered extension tools so they are callable from fabric_exec.",
            values: BOOLEANS,
          }),
          setting("capture.hideFromModel", "Hide from model", config.capture.hideFromModel ? "true" : "false", {
            description: "Hide captured tools from the parent model's tool schema.",
            values: BOOLEANS,
          }),
          setting("capture.defaultRisk", "Default risk", config.capture.defaultRisk, {
            description: "Approval risk level applied to captured tools without an explicit override.",
            values: RISKS,
          }),
          keepVisibleItem,
          ...CORE_RISK_TOOLS.map((tool) =>
            setting(`capture.risks.${tool}`, `${tool} risk`, config.capture.risks[tool] ?? config.capture.defaultRisk, {
              description: `Approval risk level for the ${tool} tool when captured.`,
              values: RISKS,
            }),
          ),
        ],
        persist,
      ),
    }),
    setting("ui", "UI", summaryFor("ui", config), {
      description: "Fabric activity widget and dashboard.",
      submenu: sectionSubmenu(
        theme,
        "UI",
        "Fabric activity widget and dashboard.",
        [
          setting("ui.enabled", "Enabled", config.ui.enabled ? "true" : "false", {
            description: "Show the Fabric activity widget and dashboard.",
            values: BOOLEANS,
          }),
          setting("ui.widget", "Widget", config.ui.widget, {
            description: "When to show the activity widget above the editor.",
            values: WIDGET_MODES,
          }),
          setting(
            "ui.showNestedToolCalls",
            "Nested tool calls",
            config.ui.showNestedToolCalls ? "true" : "false",
            {
              description: "Show child-agent and actor tool activity in the Fabric card and widget.",
              values: BOOLEANS,
            },
          ),
          setting(
            "ui.nestedToolDebounceMs",
            "Nested tool debounce",
            formatDebounce(config.ui.nestedToolDebounceMs),
            {
              description: "One global coalescing window for regular nested-tool UI updates.",
              submenu: numericSubmenu(
                theme,
                [0, 16, 50, 100, 150, 250, 500, 1000],
                formatDebounce,
                "Nested tool debounce",
                "One global coalescing window for regular nested-tool UI updates. Off emits every update.",
              ),
            },
          ),
          setting("ui.maxRows", "Max rows", String(config.ui.maxRows), {
            description: "Maximum rows rendered by the activity widget.",
            submenu: numericSubmenu(
              theme,
              [1, 2, 3, 5, 6, 8, 10, 15, 20],
              String,
              "Widget max rows",
              "Maximum rows rendered by the activity widget.",
            ),
          }),
          setting("ui.refreshMs", "Refresh interval", formatMs(config.ui.refreshMs), {
            description: "Refresh interval for the activity widget.",
            submenu: numericSubmenu(
              theme,
              [100, 250, 500, 1000, 2000],
              formatMs,
              "Widget refresh interval",
              "Refresh interval for the activity widget.",
            ),
          }),
          setting("ui.eventHistory", "Event history", String(config.ui.eventHistory), {
            description: "Number of mesh events kept in the dashboard history.",
            submenu: numericSubmenu(
              theme,
              [20, 40, 80, 120, 200, 500],
              String,
              "Event history",
              "Number of mesh events kept in the dashboard history.",
            ),
          }),
        ],
        persist,
      ),
    }),
    setting("compaction", "Compaction", summaryFor("compaction", config), {
      description: "Compaction engine used at session compaction boundaries.",
      submenu: sectionSubmenu(
        theme,
        "Compaction",
        "Choose Fabric deterministic compaction or Pi core model-driven compaction.",
        [
          setting("compaction.engine", "Engine", config.compaction.engine, {
            description:
              "Fabric uses deterministic branch summaries; Pi delegates compaction to Pi core.",
            values: COMPACTION_ENGINES,
          }),
        ],
        persist,
      ),
    }),
    setting("mesh", "Mesh", summaryFor("mesh", config), {
      description: "Durable mesh coordination store and actors.",
      submenu: sectionSubmenu(
        theme,
        "Mesh",
        "Durable mesh coordination store and actors.",
        [
          setting("mesh.enabled", "Enabled", config.mesh.enabled ? "true" : "false", {
            description: "Enable the durable mesh store and actor providers.",
            values: BOOLEANS,
          }),
          setting("mesh.actorScope", "Actor scope", config.mesh.actorScope, {
            description:
              'Where persistent actor definitions, mailboxes, and sessions are stored. "project" shares actors across all Pi sessions in this project (survives /new); "session" isolates them per Pi session (the previous default).',
            values: ACTOR_SCOPES,
          }),
          setting("mesh.maxReadEvents", "Max read events", String(config.mesh.maxReadEvents), {
            description: "Maximum events returned by a single mesh read.",
            submenu: numericSubmenu(
              theme,
              [100, 200, 500, 1000, 5000],
              String,
              "Max read events",
              "Maximum events returned by a single mesh read.",
            ),
          }),
          setting("mesh.actorPollMs", "Actor poll interval", formatMs(config.mesh.actorPollMs), {
            description: "Polling interval for actor mailbox checks.",
            submenu: numericSubmenu(
              theme,
              [50, 100, 250, 500, 1000],
              formatMs,
              "Actor poll interval",
              "Polling interval for actor mailbox checks.",
            ),
          }),
          setting("mesh.actorQueueLimit", "Actor queue limit", String(config.mesh.actorQueueLimit), {
            description: "Maximum messages queued per actor mailbox.",
            submenu: numericSubmenu(
              theme,
              [4, 8, 16, 32, 64, 128],
              String,
              "Actor queue limit",
              "Maximum messages queued per actor mailbox.",
            ),
          }),
          setting("mesh.actorContextEntries", "Actor context entries", String(config.mesh.actorContextEntries), {
            description: "Transcript entries forwarded to actors as context.",
            submenu: numericSubmenu(
              theme,
              [3, 5, 10, 14, 20, 50],
              String,
              "Actor context entries",
              "Transcript entries forwarded to actors as context.",
            ),
          }),
          setting("mesh.eventContextChars", "Event context chars", String(config.mesh.eventContextChars), {
            description: "Character cap applied to host events dispatched to actors.",
            submenu: numericSubmenu(
              theme,
              [10_000, 20_000, 40_000, 80_000, 160_000],
              (n) => n.toLocaleString(),
              "Event context chars",
              "Character cap applied to host events dispatched to actors.",
            ),
          }),
        ],
        persist,
      ),
    }),
  ];
  return markDrillIn(items);
};

export interface FabricSettingsDeps {
  state: FabricState;
  applyFabricMode: () => void;
  capturedTools: CapturedToolCatalog;
}

export async function openFabricSettings(
  context: ExtensionContext,
  deps: FabricSettingsDeps,
): Promise<void> {
  if (context.mode !== "tui") {
    context.ui.notify("Fabric settings are available in TUI mode", "warning");
    return;
  }
  await deps.state.ensure(context);

  const agentDir = getAgentDir();
  let rootList: SettingsList | undefined;
  const changedSections = new Set<string>();
  let dirty = false;

  const apply = (id: string, value: unknown): void => {
    const partial = buildPartial(id, value);
    try {
      saveFabricConfig(
        { cwd: context.cwd, agentDir, projectTrusted: context.isProjectTrusted() },
        partial,
      );
    } catch (error) {
      context.ui.notify(
        `Failed to save Fabric settings: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }
    deps.state.reloadConfig(context);
    dirty = true;
    changedSections.add(id.split(".")[0] ?? id);
    const list = rootList;
    if (list) {
      for (const rootId of ROOT_ITEM_IDS) {
        list.updateValue(rootId, summaryFor(rootId, deps.state.config));
      }
    }
  };

  const persist = (id: string, newValue: string): void =>
    apply(id, coerceValue(id, newValue, deps.state.config));

  const keepVisibleCandidates = unique([
    "fabric_exec",
    ...deps.capturedTools.list().map((tool) => tool.name),
  ]);
  const modelSource = buildModelSource(context.modelRegistry);
  let claudeModelSource: ModelSource = { models: [], lastUsed: {} };
  try {
    claudeModelSource = buildClaudeModelSource(await deps.state.subagents.claudeModels());
  } catch (error) {
    if (deps.state.config.subagents.runner === "claude") {
      context.ui.notify(
        `Claude model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  }

  await context.ui.custom<void>(
    (_tui, theme, _keybindings, done) => {
      const items = buildFabricSettingsItems(theme, deps.state.config, apply, {
        keepVisibleCandidates,
        modelSource,
        claudeModelSource,
      });
      const component = new FabricSettingsComponent(theme, items, persist, () => done());
      rootList = component.settingsList;
      return component;
    },
  );

  if (dirty) {
    deps.applyFabricMode();
    const needsReload = [...changedSections].some((section) => RELOAD_SECTIONS.has(section));
    if (needsReload) {
      context.ui.notify(
        "Fabric settings saved. Run /fabric reload to apply mesh, subagent, and MCP changes.",
        "info",
      );
    } else {
      context.ui.notify("Fabric settings saved.", "info");
    }
  }
}
