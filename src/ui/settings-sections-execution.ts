import type { SettingItem } from "@earendil-works/pi-tui";
import type { SettingsSectionContext } from "./settings-section-context.js";
import {
  setting,
  sectionSubmenu,
  numericSubmenu,
  stringInputSubmenu,
  modelPickerSubmenu,
} from "./settings-submenus.js";
import {
  BOOLEANS,
  summaryFor,
  EXECUTOR_KERNELS,
  PYTHON_RUNTIMES,
  EXECUTOR_RUNTIMES,
  formatMs,
  formatBytes,
  executorMemoryLimitOptions,
  RESULT_FORMATS,
  SCHEMA_MODES,
  APPROVAL_MODES,
} from "./settings-values.js";
import { maxExecutorMemoryLimitBytes } from "../config.js";
import { INHERIT_VALUE } from "./model-picker.js";

export const buildFullCodeModeSection = (
  { config }: Pick<SettingsSectionContext, "config">,
): SettingItem => {
  const envFullCode = process.env.PI_FABRIC_FULL_CODE_MODE;

  const fullCodeDescription = envFullCode
    ? "Fabric owns Pi core tools (read, bash, edit, write, grep, find, ls) via fabric_exec. Currently overridden by the PI_FABRIC_FULL_CODE_MODE environment variable."
    : "Fabric owns Pi core tools (read, bash, edit, write, grep, find, ls) via fabric_exec. Disable to keep native tools model-facing (orchestration-only mode).";

  return setting("fullCodeMode", "Full code mode", config.fullCodeMode ? "true" : "false", {
    description: fullCodeDescription,
    values: BOOLEANS,
  });
};

export const buildExecutorSection = (
  { config, theme, persist }: Pick<SettingsSectionContext, "config" | "theme" | "persist">,
): SettingItem => {
  const executorMemoryDescription = (): string =>
    config.executor.kernel === "python" && config.executor.pythonRuntime === "monty"
      ? "Monty VM allocation limit. Host bridge result/output limits apply separately. No filesystem or network access is granted to the VM."
      : config.executor.kernel === "python"
      ? "CPython process address-space limit via RLIMIT_AS where the OS supports it; not a portable hard memory cap. Process limits are not a security sandbox."
      : config.executor.runtime === "quickjs"
        ? "Maximum QuickJS heap size. WASM32 limits this to less than 4 GiB."
        : config.executor.runtime === "bun-process"
          ? "Heap target for the disposable Bun process. Bun ignores V8 heap flags, so this limit is not enforced."
          : "V8 old-generation heap limit for the disposable Node process. Large allocations may destabilize the system.";
  const kernelDescription = "Exclusive language for all fabric_exec calls; no per-call switching. Python defaults to sandboxed Monty. CPython requires explicit selection and is trusted native code outside schema enforce.";
  const cpythonDescription = "CPython 3.10+ executable name or path (default python3), used only by the explicit CPython backend. No shell arguments.";
  const enforceTypeScript = config.schema.mode === "enforce" && config.executor.kernel === "typescript";

  return setting("executor", "Executor", summaryFor("executor", config), {
    description: "Kernel, Python/TypeScript backends, and resource limits. Node/Bun and CPython are unsafe trusted-code escape hatches.",
    submenu: sectionSubmenu(
      theme,
      "Executor",
      "Kernel, Python/TypeScript backends, and resource limits. Node/Bun and CPython are unsafe trusted-code escape hatches.",
      [
        setting("executor.kernel", "Kernel", config.executor.kernel, {
          description: kernelDescription,
          values: EXECUTOR_KERNELS,
        }),
        setting("executor.pythonRuntime", "Runtime (Python)", config.executor.pythonRuntime, {
          description: "Monty (default) is a sandboxed Python subset with no native filesystem, network, or environment access. CPython 3.10+ is an explicit trusted-native escape hatch. Schema enforce keeps the selected backend and never falls back.",
          values: PYTHON_RUNTIMES,
        }),
        setting("executor.cpython.binary", "CPython binary", config.executor.cpython.binary, {
          description: cpythonDescription,
          submenu: stringInputSubmenu(theme, "CPython binary", cpythonDescription),
        }),
        setting("executor.runtime", "Runtime (TS)", config.executor.runtime, {
          description: enforceTypeScript
            ? "TypeScript only. Schema enforce mode requires the isolated QuickJS runtime; it does not change the configured kernel."
            : "TypeScript only; ignored by Python. QuickJS is isolated and limited by WASM32. Node/Bun processes support larger heaps but are an unsafe trusted-code escape hatch, not a security sandbox.",
          values: enforceTypeScript ? ["quickjs"] : EXECUTOR_RUNTIMES,
        }),
        setting("executor.timeoutMs", "Timeout", formatMs(config.executor.timeoutMs), {
          description: `Default wall-clock time for a single fabric_exec program. A per-invocation timeoutMs or a matching executor.hostCallTimeouts ref can raise it up to the ${formatMs(config.executor.maxTimeoutMs)} policy maximum.`,
          submenu: numericSubmenu(
            theme,
            [15_000, 30_000, 60_000, 120_000, 300_000, 600_000],
            formatMs,
            "Executor timeout",
            `Default wall-clock time for a single fabric_exec program (policy max ${formatMs(config.executor.maxTimeoutMs)}).`,
          ),
        }),
        setting(
          "executor.maxTimeoutMs",
          "Policy max",
          formatMs(config.executor.maxTimeoutMs),
          {
            description:
              "Ceiling for every executor deadline: per-invocation timeoutMs requests and executor.hostCallTimeouts ref floors are capped at this value. Values above it are normalized on load.",
            submenu: numericSubmenu(
              theme,
              [300_000, 600_000, 900_000, 1_800_000, 3_600_000],
              formatMs,
              "Executor policy maximum",
              "Ceiling for every executor deadline, including per-invocation requests and per-ref floors.",
            ),
          },
        ),
        setting(
          "executor.hostCallTimeouts",
          "Per-ref floors",
          Object.keys(config.executor.hostCallTimeouts).length > 0
            ? Object.keys(config.executor.hostCallTimeouts)
                .map((ref) => `${ref}=${formatMs(config.executor.hostCallTimeouts[ref] ?? 0)}`)
                .join(", ")
            : "none",
          {
            description:
              "Exact-ref deadline floors for known long-running host calls (configured in the Fabric config file), e.g. \"extensions.subagent\": 3600000.",
          },
        ),
        setting(
          "executor.memoryLimitBytes",
          "Memory limit",
          formatBytes(config.executor.memoryLimitBytes),
          {
            description: executorMemoryDescription(),
            submenu: (currentValue, done) =>
              numericSubmenu(
                theme,
                executorMemoryLimitOptions(maxExecutorMemoryLimitBytes(config.executor.runtime, config.executor.kernel)),
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
  });
};

export const buildSchemaSection = (
  { config, theme, persist }: Pick<SettingsSectionContext, "config" | "theme" | "persist">,
): SettingItem => {
  return setting("schema", "Schema", summaryFor("schema", config), {
    description: "Typed evidence loop and local-file transaction channel. Enforcement is locked per session; mode changes take effect in the next session.",
    submenu: sectionSubmenu(
      theme,
      "Schema",
      "Typed evidence loop and local-file transaction channel. In enforce mode, protected-workspace mutations require schema.hypothesize → schema.verify → schema.commit inside one fabric_exec call.",
      [
        setting("schema.mode", "Mode", config.schema.mode, {
          description:
            "off (default) leaves the control plane ungated. audit records would_block events for actions enforce would deny. enforce admits only schema transactions for protected-workspace changes and preserves the kernel: TypeScript uses QuickJS; Python defaults to sandboxed Monty. Explicit CPython requires macOS sandbox-exec or Linux bwrap and fails closed without isolation. Takes effect in the next session.",
          values: SCHEMA_MODES,
        }),
        setting("schema.certificateTtlMs", "Certificate TTL", formatMs(config.schema.certificateTtlMs), {
          description: "How long a schema.verify certificate stays valid. Clamped to 1s–10min.",
          submenu: numericSubmenu(
            theme,
            [1_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000],
            formatMs,
            "Certificate TTL",
            "How long a schema.verify certificate stays valid. Clamped to 1s–10min.",
          ),
        }),
        setting("schema.maxFiles", "Max files", String(config.schema.maxFiles), {
          description: "Maximum files in one schema.commit transaction. Clamped to 1–1000.",
          submenu: numericSubmenu(
            theme,
            [1, 5, 10, 25, 50, 100, 250, 500, 1000],
            (n) => String(n),
            "Max files",
            "Maximum files in one schema.commit transaction. Clamped to 1–1000.",
          ),
        }),
        setting("schema.maxBytes", "Max bytes", formatBytes(config.schema.maxBytes), {
          description: "Maximum total bytes written by one schema.commit transaction. Clamped to 1 KiB–100 MiB.",
          submenu: numericSubmenu(
            theme,
            [1_048_576, 5_242_880, 10_485_760, 52_428_800, 104_857_600],
            formatBytes,
            "Max bytes",
            "Maximum total bytes written by one schema.commit transaction. Clamped to 1 KiB–100 MiB.",
          ),
        }),
      ],
      persist,
    ),
  });
};

export const buildApprovalsSection = (
  { config, theme, options, persist }: Pick<SettingsSectionContext<"modelSource">, "config" | "theme" | "options" | "persist">,
): SettingItem => {
  return setting("approvals", "Approvals", summaryFor("approvals", config), {
    description: "Per-action approval policy for Fabric and model-requested native tool calls.",
    submenu: sectionSubmenu(
      theme,
      "Approvals",
      "Approval policy for Fabric and model-requested native tool calls. Auto routes each call through a dedicated safety classifier and escalates uncertain actions to you.",
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
  });
};

export const buildMcpSection = (
  { config, theme, persist }: Pick<SettingsSectionContext, "config" | "theme" | "persist">,
): SettingItem => {
  return setting("mcp", "MCP", summaryFor("mcp", config), {
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
        setting("mcp.cache.enabled", "Descriptor cache", config.mcp.cache.enabled ? "true" : "false", {
          description: "Cache MCP tool metadata across sessions keyed by mcporter config; discovery no longer spawns every server.",
          values: BOOLEANS,
        }),
        setting("mcp.cache.revalidate", "Revalidate on start", config.mcp.cache.revalidate, {
          description: "Background re-listing at session start: changed servers only, all servers, or off.",
          values: ["changed", "all", "off"],
        }),
        setting("mcp.cache.revalidateBudgetMs", "Revalidate budget", formatMs(config.mcp.cache.revalidateBudgetMs), {
          description: "Wall-clock budget for the session-start background MCP revalidation.",
          submenu: numericSubmenu(
            theme,
            [15_000, 30_000, 60_000, 120_000, 300_000],
            formatMs,
            "MCP revalidate budget",
            "Wall-clock budget for the session-start background MCP revalidation.",
          ),
        }),
      ],
      persist,
    ),
  });
};
