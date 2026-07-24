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
  maxExecutorMemoryLimitBytes,
  QUICKJS_MAX_MEMORY_LIMIT_BYTES,
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
const APPROVAL_MODES = ["allow", "ask", "auto", "deny"] as const;
const RUNNERS = ["pi", "claude"] as const;
const TRANSPORTS = ["auto", "process", "tmux", "screen", "localterm", "herdr"] as const;
const WIDGET_MODES = ["auto", "always", "hidden"] as const;
const RESULT_FORMATS = ["auto", "yaml", "json", "text"] as const;
const EXECUTOR_RUNTIMES = ["quickjs", "node-process"] as const;
const COMPACTION_ENGINES = ["fabric", "pi"] as const;
const COMPACTION_TARGET_RATIOS = [
  "0.25",
  "0.4",
  "0.5",
  "0.6",
  "0.65",
  "0.7",
  "0.75",
  "0.8",
  "0.85",
] as const;
const ACTOR_SCOPES = ["project", "session"] as const;
const RISKS = ["read", "write", "execute", "network", "agent"] as const;
const CORE_RISK_TOOLS = ["read", "grep", "find", "edit", "write", "bash"] as const;
const CORE_DEFAULT_TOOL_CANDIDATES = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const BUDGET_VALUES = [0, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
const TOKEN_VALUES = [0, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000];
const PREWALK_MODEL_UNSET_LABEL = "Ask each time";
const ROOT_ITEM_IDS = [
  "fullCodeMode",
  "executor",
  "approvals",
  "mcp",
  "prewalk",
  "agents",
  "capture",
  "ui",
  "compaction",
  "mesh",
] as const;
const RELOAD_SECTIONS = new Set(["mesh", "agents", "mcp"]);

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
  ms < 1_000
    ? `${ms}ms`
    : ms < 60_000
      ? `${ms / 1_000}s`
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
  maximumBytes = QUICKJS_MAX_MEMORY_LIMIT_BYTES,
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

export const parseFormattedNumericValue = (value: string): number => {
  const normalized = value.trim();
  if (normalized === "Off") return 0;
  if (normalized.startsWith("$")) return parseBudgetValue(normalized);

  const bytes = normalized.match(/^([0-9]+(?:\.[0-9]+)?) (KB|MB|GB)$/);
  if (bytes) {
    const amount = Number(bytes[1]);
    const units = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 } as const;
    return Math.round(amount * units[bytes[2] as keyof typeof units]);
  }

  const duration = normalized.match(/^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)$/);
  if (duration) {
    const amount = Number(duration[1]);
    const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
    return Math.round(amount * units[duration[2] as keyof typeof units]);
  }

  const tokens = normalized.match(/^([0-9]+(?:\.[0-9]+)?)(k|M)$/);
  if (tokens) return Math.round(Number(tokens[1]) * (tokens[2] === "M" ? 1_000_000 : 1_000));
  return Number(normalized.replaceAll(",", ""));
};

const coerceValue = (id: string, value: string, config: FabricConfig): unknown => {
  const current = getPath(config, id);
  if (typeof current === "boolean") return value === "true";
  if (typeof current === "number") return parseFormattedNumericValue(value);
  // The model picker stores the canonical "provider/id" string, or "Inherit"
  // for no override; persist an empty string so normalizeFabricConfig drops it.
  // Agents inherit; prewalk asks interactively when it is armed.
  if (
    id === "approvals.model" ||
    id === "prewalk.model" ||
    id === "agents.model" ||
    id === "agents.claude.model"
  ) {
    return value === INHERIT_VALUE || value === PREWALK_MODEL_UNSET_LABEL ? "" : value;
  }
  if (id === "agents.thinking") {
    return THINKING_LEVELS.find((level) => thinkingLabel(level) === value) ?? value;
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
      return `${config.executor.runtime} · ${formatMs(config.executor.timeoutMs)}`;
    case "approvals":
      return config.approvals.execute;
    case "mcp":
      return config.mcp.enabled ? "enabled" : "disabled";
    case "prewalk":
      return `${config.prewalk.model || PREWALK_MODEL_UNSET_LABEL}${config.prewalk.alwaysRearm ? " · repeat" : ""}`;
    case "agents":
      return `${config.agents.runner}/${config.agents.transport}`;
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
    (value) => done(options.find((option) => option.value === value)?.label ?? value),
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

const thinkingSubmenu = (theme: Theme): SettingsSubmenu => (currentValue, done) => {
  const canonicalCurrent =
    THINKING_LEVELS.find((level) => thinkingLabel(level) === currentValue) ?? currentValue;
  const options: SelectItem[] = THINKING_LEVELS.map((level) => ({
    value: level,
    label: thinkingLabel(level),
  }));
  if (!options.some((option) => option.value === canonicalCurrent)) {
    options.unshift({ value: canonicalCurrent, label: currentValue });
  }
  return new SelectSubmenu(
    theme,
    "Default thinking",
    "Reasoning effort forwarded to spawned agents and actors when a call does not specify one. The level is clamped to each model's supported levels (next highest if unsupported).",
    options,
    canonicalCurrent,
    (value) => done(options.find((option) => option.value === value)?.label ?? value),
    () => done(),
  );
};

const modelPickerSubmenu = (
  theme: Theme,
  source: ModelSource,
  options: {
    headerText?: string;
    inheritLabel?: string;
    inheritName?: string;
  } = {},
): SettingsSubmenu => (currentValue, done) => {
  const canonicalCurrent =
    options.inheritLabel && currentValue === options.inheritLabel
      ? INHERIT_VALUE
      : currentValue;
  return new FabricModelSelector({
    theme,
    source,
    currentValue: canonicalCurrent,
    onSelect: (value) =>
      done(
        value === INHERIT_VALUE && options.inheritLabel
          ? options.inheritLabel
          : value,
      ),
    onCancel: () => done(),
    ...(options.headerText ? { headerText: options.headerText } : {}),
    ...(options.inheritLabel ? { inheritLabel: options.inheritLabel } : {}),
    ...(options.inheritName ? { inheritName: options.inheritName } : {}),
  });
};

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

export const populateClaudeModelSource = async (
  source: ModelSource,
  load: () => Promise<Parameters<typeof buildClaudeModelSource>[0]>,
): Promise<void> => {
  const loaded = buildClaudeModelSource(await load());
  source.models.splice(0, source.models.length, ...loaded.models);
  source.lastUsed = loaded.lastUsed;
};

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
  const executorMemoryDescription = (): string =>
    config.executor.runtime === "quickjs"
      ? "Maximum QuickJS heap size. WASM32 limits this to less than 4 GiB."
      : "V8 old-generation heap limit for the disposable Node process. Large allocations may destabilize the system.";

  const defaultToolsItem = setting(
    "agents.defaultTools",
    "Default tools",
    formatToolCount(config.agents.defaultTools.length),
    { description: "Pi core tools exposed to spawned agents by default." },
  );
  defaultToolsItem.submenu = listSubmenu(
    theme,
    "agents.defaultTools",
    "Default tools",
    "Pi core tools exposed to spawned agents by default.",
    CORE_DEFAULT_TOOL_CANDIDATES,
    config.agents.defaultTools,
    (selected) => {
      apply("agents.defaultTools", selected);
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
      description: "Runtime and resource limits for fabric_exec programs.",
      submenu: sectionSubmenu(
        theme,
        "Executor",
        "Runtime and resource limits for fabric_exec programs.",
        [
          setting("executor.runtime", "Runtime", config.executor.runtime, {
            description:
              config.schema.mode === "enforce"
                ? "Schema enforce mode requires the isolated QuickJS runtime."
                : "QuickJS is isolated and limited by WASM32. Node process supports larger heaps but is an unsafe trusted-code escape hatch, not a security sandbox.",
            values: config.schema.mode === "enforce" ? ["quickjs"] : EXECUTOR_RUNTIMES,
          }),
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
              description: executorMemoryDescription(),
              submenu: (currentValue, done) =>
                numericSubmenu(
                  theme,
                  executorMemoryLimitOptions(maxExecutorMemoryLimitBytes(config.executor.runtime)),
                  formatBytes,
                  "Executor memory limit",
                  executorMemoryDescription(),
                )(currentValue, done),
            },
          ),
          setting("executor.maxOutputChars", "Max output chars", config.executor.maxOutputChars.toLocaleString(), {
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
            config.executor.maxNestedResultChars.toLocaleString(),
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
        "Per-action approval policy for tools invoked from inside fabric_exec. Auto routes each call through a dedicated safety classifier and escalates uncertain actions to you.",
        [
          setting("approvals.model", "Auto model", config.approvals.model || INHERIT_VALUE, {
            description:
              "Pi model used as the auto-mode safety classifier. Inherit uses the active session model. The classifier has no executable tools and returns a structured allow-or-escalate verdict.",
            submenu: modelPickerSubmenu(
              theme,
              options.modelSource,
              {
                headerText:
                  "Safety classifier for auto approval policies. Pick Inherit to use the active Pi session model.",
                inheritName: "Use the active Pi session model",
              },
            ),
          }),
          setting("approvals.read", "Read", config.approvals.read, {
            description: "Approval policy for read operations. Read is normally safe to leave allowed.",
            values: APPROVAL_MODES,
          }),
          setting("approvals.write", "Write", config.approvals.write, {
            description: "Approval policy for write and edit operations. Auto classifies each call.",
            values: APPROVAL_MODES,
          }),
          setting("approvals.execute", "Execute", config.approvals.execute, {
            description: "Approval policy for shell execution. Auto classifies each command.",
            values: APPROVAL_MODES,
          }),
          setting("approvals.network", "Network", config.approvals.network, {
            description: "Approval policy for network operations. Auto classifies each destination and payload.",
            values: APPROVAL_MODES,
          }),
          setting("approvals.agent", "Agent", config.approvals.agent, {
            description: "Approval policy for agent and actor operations. Auto classifies each request.",
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
    setting("prewalk", "Prewalk", summaryFor("prewalk", config), {
      description: "Trajectory handoff at the completed outer fabric_exec boundary.",
      submenu: sectionSubmenu(
        theme,
        "Prewalk",
        "Automatic handoff at the completed outer fabric_exec boundary.",
        [
          setting(
            "prewalk.alwaysRearm",
            "Always re-arm",
            config.prewalk.alwaysRearm ? "true" : "false",
            {
              description:
                "After a task settles or hands off, arm prewalk again for the next user task until explicitly cancelled.",
              values: BOOLEANS,
            },
          ),
          setting(
            "prewalk.model",
            "Executor model",
            config.prewalk.model || PREWALK_MODEL_UNSET_LABEL,
            {
              description:
                "Pi provider/model used by /fabric prewalk. Ask each time opens the model picker when arming and is unavailable in non-interactive mode.",
              submenu: modelPickerSubmenu(
                theme,
                options.modelSource,
                {
                  headerText:
                    "Executor model for automatic /fabric prewalk handoffs. Pick Ask each time to open the model picker for every prewalk.",
                  inheritLabel: PREWALK_MODEL_UNSET_LABEL,
                  inheritName: "Open the model picker whenever prewalk is armed",
                },
              ),
            },
          ),
        ],
        persist,
      ),
    }),
    setting("agents", "Agents", summaryFor("agents", config), {
      description: "One-shot child agents spawned from inside fabric_exec.",
      submenu: sectionSubmenu(
        theme,
        "Agents",
        "One-shot child agents spawned from inside fabric_exec.",
        [
          setting("agents.enabled", "Enabled", config.agents.enabled ? "true" : "false", {
            description: "Enable agent spawning via workflow.agent() and agents.run().",
            values: BOOLEANS,
          }),
          setting("agents.runner", "Default runner", config.agents.runner, {
            description: "Execution harness used when agents.run/create does not specify runner.",
            values: RUNNERS,
          }),
          setting("agents.transport", "Transport", config.agents.transport, {
            description: "Preferred transport for spawned agents.",
            values: TRANSPORTS,
          }),
          setting("agents.model", "Default model", config.agents.model || INHERIT_VALUE, {
            description:
              "Model forwarded to Pi-backed agents and actors when a call does not specify one. Pick Inherit to use the host session's default. Order matches pi-model-sort (most recently used first).",
            submenu: modelPickerSubmenu(
              theme,
              options.modelSource,
            ),
          }),
          setting(
            "agents.claude.model",
            "Claude model",
            config.agents.claude.model || INHERIT_VALUE,
            {
              description:
                "Claude Code model used by Claude-backed agents and actors. Models are enumerated from the installed claude runtime; Inherit uses Claude Code's default.",
              submenu: modelPickerSubmenu(
                theme,
                options.claudeModelSource ?? { models: [], lastUsed: {} },
                {
                  headerText:
                    "Default model for Claude-backed Fabric agents and actors. Pick Inherit to use Claude Code's runtime default.",
                  inheritName: "Use Claude Code's runtime default model",
                },
              ),
            },
          ),
          setting("agents.thinking", "Default thinking", thinkingLabel(config.agents.thinking), {
            description:
              "Reasoning effort forwarded to spawned agents and actors when a call does not specify one. Clamped to each model's supported levels (next highest if unsupported).",
            submenu: thinkingSubmenu(theme),
          }),
          setting("agents.maxConcurrent", "Max concurrent", String(config.agents.maxConcurrent), {
            description: "Maximum number of agents that may run at the same time.",
            submenu: numericSubmenu(
              theme,
              [1, 2, 4, 8, 16, 32],
              String,
              "Agent concurrency",
              "Maximum number of agents that may run at the same time.",
            ),
          }),
          setting("agents.maxPerExecution", "Max per execution", String(config.agents.maxPerExecution), {
            description: "Maximum number of agent calls allowed within a single fabric_exec program.",
            submenu: numericSubmenu(
              theme,
              [10, 25, 50, 100, 200, 500],
              String,
              "Agents per execution",
              "Maximum number of agent calls allowed within a single fabric_exec program.",
            ),
          }),
          setting("agents.maxDepth", "Max depth", String(config.agents.maxDepth), {
            description: "Maximum nesting depth for recursive agent calls.",
            submenu: numericSubmenu(
              theme,
              [0, 1, 2, 3, 4, 6],
              String,
              "Agent depth",
              "Maximum nesting depth for recursive agent calls.",
            ),
          }),
          setting("agents.budgetUsd", "Recursion budget", formatUsd(config.agents.budgetUsd), {
            description:
              "Maximum USD spend for agent work across the whole recursion tree. 0 disables the budget.",
            submenu: numericSubmenu(
              theme,
              BUDGET_VALUES,
              formatUsd,
              "Recursion budget",
              "Maximum USD spend for agent work across the whole recursion tree. 0 disables the budget.",
            ),
          }),
          setting("agents.maxTokensPerChild", "Token limit", formatTokens(config.agents.maxTokensPerChild), {
            description:
              "Maximum cumulative tokens a single agent may use before it is terminated (0 disables). Caps a runaway child before the host session compacts.",
            submenu: numericSubmenu(
              theme,
              TOKEN_VALUES,
              formatTokens,
              "Agent token limit",
              "Maximum cumulative tokens a single agent may use before it is terminated (0 disables).",
            ),
          }),
          setting("agents.timeoutMs", "Timeout", formatMs(config.agents.timeoutMs), {
            description: "Default wall-clock timeout and minimum for per-call agent timeouts.",
            submenu: numericSubmenu(
              theme,
              [
                60_000,
                120_000,
                300_000,
                600_000,
                1_800_000,
                3_600_000,
                7_200_000,
                14_400_000,
                28_800_000,
                86_400_000,
              ],
              formatMs,
              "Agent timeout",
              "Default wall-clock timeout and minimum for per-call agent timeouts.",
            ),
          }),
          setting("agents.extensions", "Extensions", config.agents.extensions ? "true" : "false", {
            description: "Allow agents to load registered extensions.",
            values: BOOLEANS,
          }),
          defaultToolsItem,
          setting("agents.retainRuns", "Retain runs", config.agents.retainRuns ? "true" : "false", {
            description: "Keep completed agent run artifacts for later inspection.",
            values: BOOLEANS,
          }),
          setting("agents.notifyOnComplete", "Notify on complete", config.agents.notifyOnComplete ? "true" : "false", {
            description: "Post a message when a background agent completes.",
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
              description: "Show child-agent and actor tool activity in Fabric tool-call previews.",
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
          setting(
            "compaction.targetContextRatio",
            "Target occupancy",
            String(config.compaction.targetContextRatio),
            {
              description:
                "Fraction of the advertised model window Fabric targets after compaction.",
              values: COMPACTION_TARGET_RATIOS,
            },
          ),
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
          setting("mesh.actorPollMs", "Actor poll fallback", formatMs(config.mesh.actorPollMs), {
            description: "Fallback polling interval when mesh filesystem notifications are unavailable.",
            submenu: numericSubmenu(
              theme,
              [50, 100, 250, 500, 1000],
              formatMs,
              "Actor poll fallback",
              "Fallback polling interval when mesh filesystem notifications are unavailable.",
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
          setting("mesh.eventContextChars", "Event context chars", config.mesh.eventContextChars.toLocaleString(), {
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
  const configuredClaudeModel = deps.state.config.agents.claude.model;
  const claudeModelSource: ModelSource = {
    models: configuredClaudeModel
      ? [{ provider: "claude", id: configuredClaudeModel.replace(/^claude\//, "") }]
      : [],
    lastUsed: {},
  };
  void populateClaudeModelSource(
    claudeModelSource,
    () => deps.state.agents.claudeModels(),
  ).catch((error: unknown) => {
    if (deps.state.config.agents.runner === "claude") {
      context.ui.notify(
        `Claude model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  });

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
        "Fabric settings saved. Run /fabric reload to apply mesh, agent, and MCP changes.",
        "info",
      );
    } else {
      context.ui.notify("Fabric settings saved.", "info");
    }
  }
}
