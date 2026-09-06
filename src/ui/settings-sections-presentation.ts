import type { SettingItem } from "@earendil-works/pi-tui";
import type { SettingsSectionContext } from "./settings-section-context.js";
import {
  setting,
  listSubmenu,
  sectionSubmenu,
  numericSubmenu,
  stringOptionsSubmenu,
} from "./settings-submenus.js";
import {
  formatToolCount,
  summaryFor,
  BOOLEANS,
  RISKS,
  CORE_RISK_TOOLS,
  WIDGET_MODES,
  TOOL_DISPLAY_MODES,
  formatDebounce,
  formatMs,
  SHIKI_THEME_PRESETS,
  DIFF_INTENSITIES,
  WORD_EMPHASES,
  TOOL_CALL_BACKGROUNDS,
  PATH_ICON_MODES,
  CODE_PREVIEW_EDIT_LINES_ID,
  CODE_PREVIEW_ALL_LINES,
} from "./settings-values.js";

export const buildCaptureSection = (
  { config, theme, options, apply, persist }: Pick<SettingsSectionContext<"keepVisibleCandidates">, "config" | "theme" | "options" | "apply" | "persist">,
): SettingItem => {
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

  return setting("capture", "Capture", summaryFor("capture", config), {
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
          description: "Approval risk level applied to registered tools without an explicit override.",
          values: RISKS,
        }),
        keepVisibleItem,
        ...CORE_RISK_TOOLS.map((tool) =>
          setting(`capture.risks.${tool}`, `${tool} risk`, config.capture.risks[tool] ?? config.capture.defaultRisk, {
            description: `Approval risk level for the ${tool} tool on native and captured paths.`,
            values: RISKS,
          }),
        ),
      ],
      persist,
    ),
  });
};

export const buildUiSection = (
  { config, theme, persist }: Pick<SettingsSectionContext, "config" | "theme" | "persist">,
): SettingItem => {
  return setting("ui", "UI", summaryFor("ui", config), {
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
        setting("ui.toolDisplay", "Tool display", config.ui.toolDisplay, {
          description:
            "Show full Fabric TypeScript or a compact intent-and-tools transcript; the tool-expand key (ctrl+o) expands a compact card to full.",
          values: TOOL_DISPLAY_MODES,
        }),
        setting(
          "ui.showAgentToolPreview",
          "Agent tool preview",
          config.ui.showAgentToolPreview ? "true" : "false",
          {
            description:
              "Show spawned agent/actor tool trees — including recursive descendants — in Fabric tool-call previews.",
            values: BOOLEANS,
          },
        ),
        setting(
          "ui.updateDebounceMs",
          "Update debounce",
          formatDebounce(config.ui.updateDebounceMs),
          {
            description: "One global coalescing window for live card updates — nested calls, progress, agent previews.",
            submenu: numericSubmenu(
              theme,
              [0, 16, 50, 100, 150, 250, 500, 1000],
              formatDebounce,
              "Update debounce",
              "One global coalescing window for live card updates — nested calls, progress, agent previews. Off emits every update.",
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
  });
};

export const buildCodePreviewSection = (
  { config, theme, persist }: Pick<SettingsSectionContext, "config" | "theme" | "persist">,
): SettingItem => {
  return setting("codePreview", "Code previews", summaryFor("codePreview", config), {
    description: "Core tool previews, diffs, and Shiki syntax highlighting.",
    submenu: sectionSubmenu(
      theme,
      "Code previews",
      "Core tool previews, diffs, and Shiki syntax highlighting. Persisted to fabric.json codePreview.",
      [
        setting("codePreview.shikiTheme", "Shiki theme", config.codePreview.shikiTheme, {
          description:
            "\"auto\" follows Pi's resolved light/dark variant; \"<light>/<dark>\" pins both; any other value fixes one theme.",
          submenu: stringOptionsSubmenu(
            theme,
            SHIKI_THEME_PRESETS,
            "Shiki theme",
            "\"auto\" follows Pi's light/dark switching (github-light/dark-plus); \"<light>/<dark>\" pins both variants.",
          ),
        }),
        setting("codePreview.syntaxHighlighting", "Syntax highlighting", config.codePreview.syntaxHighlighting ? "true" : "false", {
          description: "Highlight code in previews with Shiki.",
          values: BOOLEANS,
        }),
        setting("codePreview.diffIntensity", "Diff background", config.codePreview.diffIntensity, {
          description: "Full-row background tint for added and removed diff lines.",
          values: DIFF_INTENSITIES,
        }),
        setting("codePreview.wordEmphasis", "Word emphasis", config.codePreview.wordEmphasis, {
          description: "Highlight changed words inside added and removed diff lines.",
          values: WORD_EMPHASES,
        }),
        setting("codePreview.toolCallBackground", "Tool call background", config.codePreview.toolCallBackground, {
          description: "Background treatment for tool call frames.",
          values: TOOL_CALL_BACKGROUNDS,
        }),
        setting("codePreview.toolCallTiming", "Tool call timing", config.codePreview.toolCallTiming ? "true" : "false", {
          description: "Show per-call duration on tool frames.",
          values: BOOLEANS,
        }),
        setting("codePreview.pathIcons", "Path icons", config.codePreview.pathIcons, {
          description: "Icon set for path tree previews.",
          values: PATH_ICON_MODES,
        }),
        setting("codePreview.readCollapsedLines", "Read lines", String(config.codePreview.readCollapsedLines), {
          description: "Collapsed read preview budget.",
          submenu: numericSubmenu(theme, [3, 5, 10, 15, 20, 30], String, "Read lines", "Collapsed read preview budget."),
        }),
        setting("codePreview.writeCollapsedLines", "Write lines", String(config.codePreview.writeCollapsedLines), {
          description: "Collapsed write preview budget.",
          submenu: numericSubmenu(theme, [3, 5, 10, 15, 20, 30], String, "Write lines", "Collapsed write preview budget."),
        }),
        setting(
          CODE_PREVIEW_EDIT_LINES_ID,
          "Edit diff lines",
          config.codePreview.editCollapsedLines === "all"
            ? CODE_PREVIEW_ALL_LINES
            : String(config.codePreview.editCollapsedLines),
          {
            description: "Collapsed edit diff budget, or every diff line.",
            submenu: stringOptionsSubmenu(
              theme,
              ["10", "40", "80", "160", "320", CODE_PREVIEW_ALL_LINES],
              "Edit diff lines",
              "Collapsed edit diff budget, or every diff line.",
            ),
          },
        ),
        setting("codePreview.grepCollapsedLines", "Grep lines", String(config.codePreview.grepCollapsedLines), {
          description: "Collapsed grep result budget.",
          submenu: numericSubmenu(theme, [5, 10, 15, 25, 40], String, "Grep lines", "Collapsed grep result budget."),
        }),
        setting("codePreview.pathListCollapsedLines", "Path list lines", String(config.codePreview.pathListCollapsedLines), {
          description: "Collapsed find/ls path tree budget.",
          submenu: numericSubmenu(theme, [10, 20, 40, 80], String, "Path list lines", "Collapsed find/ls path tree budget."),
        }),
        setting("codePreview.readContentPreview", "Read preview", config.codePreview.readContentPreview ? "true" : "false", {
          description: "Show file content previews for read calls.",
          values: BOOLEANS,
        }),
        setting("codePreview.writeContentPreview", "Write preview", config.codePreview.writeContentPreview ? "true" : "false", {
          description: "Show content previews for write calls.",
          values: BOOLEANS,
        }),
        setting("codePreview.editDiffPreview", "Edit diff preview", config.codePreview.editDiffPreview ? "true" : "false", {
          description: "Show diffs for edit calls.",
          values: BOOLEANS,
        }),
        setting("codePreview.grepResultPreview", "Grep results", config.codePreview.grepResultPreview ? "true" : "false", {
          description: "Show grouped grep result previews.",
          values: BOOLEANS,
        }),
        setting("codePreview.findResultPreview", "Find results", config.codePreview.findResultPreview ? "true" : "false", {
          description: "Show find result path trees.",
          values: BOOLEANS,
        }),
        setting("codePreview.lsResultPreview", "Ls results", config.codePreview.lsResultPreview ? "true" : "false", {
          description: "Show ls result path trees.",
          values: BOOLEANS,
        }),
        setting("codePreview.readLineNumbers", "Read line numbers", config.codePreview.readLineNumbers ? "true" : "false", {
          description: "Show line-number gutters in read previews.",
          values: BOOLEANS,
        }),
        setting("codePreview.bashResultPreview", "Bash results", config.codePreview.bashResultPreview ? "true" : "false", {
          description: "Show bash output previews.",
          values: BOOLEANS,
        }),
        setting("codePreview.bashWarnings", "Bash warnings", config.codePreview.bashWarnings ? "true" : "false", {
          description: "Annotate risky bash commands.",
          values: BOOLEANS,
        }),
        setting("codePreview.secretWarnings", "Secret warnings", config.codePreview.secretWarnings ? "true" : "false", {
          description: "Flag suspected secrets in previews.",
          values: BOOLEANS,
        }),
      ],
      persist,
    ),
  });
};
