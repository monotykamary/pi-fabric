import { createHash } from "node:crypto";
import type { AppKeybinding, Theme } from "@earendil-works/pi-coding-agent";
import type { CodePreviewSettings } from "pi-code-previews";
import { getKeybindings, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { highlightCode, languageFromPath } from "./highlight.js";
import { headlineArg } from "../core/call-preview.js";
import { coreToolTitle, renderCoreToolBody } from "./core-tool-render.js";
import { isFabricNestedToolPreview, type FabricTranscriptEntry } from "./transcript.js";
import ts from "typescript";
import {
  applyDiffBackground,
  createDiffBackgroundResolver,
  parseMarkedDiffLine,
  wrapDiffAnsiToWidth,
  type DiffBackgroundIntensity,
} from "./diff-background.js";

export interface FabricRenderAudit {
  ref: string;
  tool?: string;
  provider?: string;
  success?: boolean;
  error?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  resultTruncated?: boolean;
  preview?: unknown;
  startedAt?: number;
  endedAt?: number;
  previewHeadline?: string;
}

const configuredDiffWrapRows = Number.parseInt(
  process.env.CODE_PREVIEW_DIFF_WRAP_ROWS ?? "",
  10,
);
const DIFF_WRAP_ROWS =
  Number.isFinite(configuredDiffWrapRows) && configuredDiffWrapRows > 0
    ? configuredDiffWrapRows
    : 3;

const EXPAND_KEYBINDING = "app.tools.expand" as AppKeybinding;
const COLLAPSED_MULTICALL_LIMIT = 8;
const EXPANDED_MULTICALL_LIMIT = 30;
const FULL_SGR_RESET = "\x1b[0m";
const TEXT_SGR_RESET = "\x1b[22;23;24;27;29;39m";

export const safeTerminalText = (value: string): string =>
  value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (character) => {
    const code = character.codePointAt(0)?.toString(16).padStart(2, "0") ?? "00";
    return `\\x${code}`;
  });

const truncateBoundedLine = (line: string, width: number): string => {
  const truncated = truncateToWidth(line, width, "");
  if (!truncated.endsWith(FULL_SGR_RESET)) return truncated;

  // truncateToWidth adds a full reset when clipping. Inside Pi's default tool Box,
  // that reset clears the enclosing background before the right padding cell.
  return truncated.slice(0, -FULL_SGR_RESET.length) + TEXT_SGR_RESET;
};

class BoundedLineList implements Component {
  #cachedWidth: number | undefined;
  #cachedRows: string[] | undefined;

  constructor(
    readonly lines: string[],
    private readonly theme?: Theme,
    private readonly diffIntensity: DiffBackgroundIntensity = "off",
  ) {}

  render(width: number): string[] {
    if (this.#cachedWidth === width && this.#cachedRows) return this.#cachedRows;
    if (width <= 0) return this.#cache(width, []);
    const diffBackground = createDiffBackgroundResolver(this.theme, this.diffIntensity);
    const rows: string[] = [];
    for (const rawLine of this.lines) {
      const { kind, line } = parseMarkedDiffLine(rawLine);
      if (!kind) {
        rows.push(truncateBoundedLine(line, width));
        continue;
      }
      const pipe = line.indexOf("│ ");
      const continuationPrefix = pipe < 0
        ? ""
        : " ".repeat(visibleWidth(line.slice(0, pipe + 2)));
      const wrappedRows = wrapDiffAnsiToWidth(
        line,
        width,
        DIFF_WRAP_ROWS,
        visibleWidth(continuationPrefix) < width ? continuationPrefix : "",
      );
      for (const row of wrappedRows) {
        const padding = " ".repeat(Math.max(0, width - visibleWidth(row)));
        rows.push(applyDiffBackground(row + padding, diffBackground(kind)));
      }
    }
    return this.#cache(width, rows);
  }

  invalidate(): void {
    this.#cachedWidth = undefined;
    this.#cachedRows = undefined;
  }

  #cache(width: number, rows: string[]): string[] {
    this.#cachedWidth = width;
    this.#cachedRows = rows;
    return rows;
  }
}

export const renderBoundedLines = (
  lines: string[],
  theme?: Theme,
  diffIntensity: DiffBackgroundIntensity = "off",
): Component => new BoundedLineList(lines, theme, diffIntensity);

export const fabricMulticallCallLimit = (expanded: boolean): number =>
  expanded ? EXPANDED_MULTICALL_LIMIT : COLLAPSED_MULTICALL_LIMIT;

/** Render the "keybinding to expand" hint, mirroring pi core's native tool previews. */
export function expandHint(theme: Theme): string {
  let keys: string[] = [];
  try {
    keys = getKeybindings().getKeys(EXPAND_KEYBINDING);
  } catch {
    keys = [];
  }
  const keyText = keys.length > 0 ? keys.join("/") : "ctrl-o";
  return theme.fg("dim", keyText) + theme.fg("muted", " to expand");
}

const truncateOneLine = (value: string, max: number): string => {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
};

const argString = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === "string" ? (args[key] as string) : undefined;

const LEGACY_COMMAND_DIGEST = /^sha256:[a-f0-9]{64}$/;
const legacyCommandCache = new WeakMap<object, ReadonlyMap<string, string>>();

const digestCommand = (command: string): string =>
  `sha256:${createHash("sha256").update(command).digest("hex")}`;

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const legacyCommandsFrom = (fabricArgs: unknown): ReadonlyMap<string, string> => {
  const args = recordOf(fabricArgs);
  if (!args) return new Map();
  const cached = legacyCommandCache.get(args);
  if (cached) return cached;

  const commands = new Map<string, string>();
  const remember = (candidate: unknown): void => {
    if (typeof candidate === "string") commands.set(digestCommand(candidate), candidate);
  };
  const namedStrings = recordOf(args.strings);
  if (namedStrings) {
    for (const value of Object.values(namedStrings)) remember(value);
  }
  const rawCode = args.code;
  const code =
    typeof rawCode === "string"
      ? rawCode
      : Array.isArray(rawCode) && rawCode.every((value) => typeof value === "string")
        ? rawCode.join("\n")
        : undefined;
  if (code) {
    const source = ts.createSourceFile(
      "fabric-exec-preview.ts",
      code,
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node)) remember(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  legacyCommandCache.set(args, commands);
  return commands;
};

export const restoreLegacyBashCommands = (
  audits: FabricRenderAudit[],
  fabricArgs: unknown,
): FabricRenderAudit[] => {
  const hasLegacyCommand = audits.some((audit) => {
    const digest = audit.ref === "pi.bash" ? argString(audit.args ?? {}, "commandDigest") : undefined;
    return Boolean(digest && LEGACY_COMMAND_DIGEST.test(digest));
  });
  if (!hasLegacyCommand) return audits;

  const commands = legacyCommandsFrom(fabricArgs);
  return audits.map((audit) => {
    if (audit.ref !== "pi.bash" || !audit.args) return audit;
    const digest = argString(audit.args, "commandDigest");
    if (!digest || !LEGACY_COMMAND_DIGEST.test(digest)) return audit;
    const { commandDigest: _commandDigest, ...argsWithoutDigest } = audit.args;
    const command = commands.get(digest);
    return {
      ...audit,
      args: command ? { ...argsWithoutDigest, command } : argsWithoutDigest,
    };
  });
};

export interface FabricWriteBinding {
  path: string;
  stringKey: string;
}

const propertyNameText = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;

const namedStringKey = (expression: ts.Expression): string | undefined => {
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "π"
  ) {
    return expression.name.text;
  }
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "π" &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }
  return undefined;
};

const literalText = (expression: ts.Expression): string | undefined =>
  ts.isStringLiteralLike(expression) ? expression.text : undefined;

export const fabricWriteBindings = (code: string): FabricWriteBinding[] => {
  const source = ts.createSourceFile(
    "fabric-exec-write-preview.ts",
    code,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const bindings: FabricWriteBinding[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "pi" &&
      node.expression.name.text === "write"
    ) {
      const args = node.arguments[0];
      if (args && ts.isObjectLiteralExpression(args)) {
        let path: string | undefined;
        let stringKey: string | undefined;
        for (const property of args.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const name = propertyNameText(property.name);
          if (name === "path" || name === "file" || name === "file_path") {
            path = literalText(property.initializer);
          } else if (name === "content" || name === "text" || name === "contents") {
            stringKey = namedStringKey(property.initializer);
          }
        }
        if (path !== undefined && stringKey !== undefined) bindings.push({ path, stringKey });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
};

export interface FabricWriteArgumentPreviewInput {
  bindings: FabricWriteBinding[];
  strings?: Record<string, string> | undefined;
  expanded: boolean;
  cwd?: string | undefined;
  settings?: CodePreviewSettings | undefined;
}

const renderWriteArgumentBody = (
  path: string,
  content: string,
  expanded: boolean,
  theme: Theme,
  invalidate?: () => void,
  parity?: { cwd: string; settings: CodePreviewSettings },
): { lines: string[]; hidden: number } => {
  if (parity) {
    const rendered = renderCoreToolBody(
      { ref: "pi.write", provider: "pi", tool: "write", args: { path, content } },
      theme,
      {
        cwd: parity.cwd,
        settings: parity.settings,
        expanded,
        maxLines: 200,
        ...(invalidate ? { invalidate } : {}),
      },
    );
    if (rendered) return rendered;
  }
  const allLines = safeTerminalText(content).split("\n");
  while (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
  const limit = expanded ? Math.min(allLines.length, 200) : 10;
  const shown = allLines.slice(0, limit);
  const lang = languageFromPath(path);
  const highlighted = lang && shown.length > 0
    ? highlightCode(shown.join("\n"), lang, invalidate)
    : null;
  return {
    lines: shown.map((line, index) =>
      highlighted?.[index] ?? theme.fg("toolOutput", line || " "),
    ),
    hidden: allLines.length - shown.length,
  };
};

export const renderFabricWriteArgumentPreview = (
  input: FabricWriteArgumentPreviewInput,
  theme: Theme,
  invalidate?: () => void,
): Component | null => {
  const available = input.bindings.map(
    (binding) => input.strings?.[binding.stringKey],
  );
  let activeIndex = -1;
  for (let index = 0; index < available.length; index++) {
    if (typeof available[index] === "string") activeIndex = index;
  }
  if (activeIndex < 0) return null;

  if (input.bindings.length === 1) {
    const binding = input.bindings[0]!;
    const rows = [
      nestedCallTitle(
        {
          ref: "pi.write",
          provider: "pi",
          tool: "write",
          args: { path: binding.path, content: available[0] ?? "" },
        },
        theme,
        invalidate,
        input.cwd && input.settings ? { cwd: input.cwd, settings: input.settings } : undefined,
      ),
    ];
    const body = renderWriteArgumentBody(
      binding.path,
      available[0] ?? "",
      input.expanded,
      theme,
      invalidate,
      input.cwd && input.settings ? { cwd: input.cwd, settings: input.settings } : undefined,
    );
    rows.push(...body.lines);
    if (body.hidden > 0) {
      rows.push(
        theme.fg("dim", `… ${body.hidden} more ${body.hidden === 1 ? "line" : "lines"}`) +
          (input.expanded ? "" : theme.fg("dim", " · ") + expandHint(theme)),
      );
    }
    return renderBoundedLines(rows);
  }

  const completed = Math.max(
    0,
    available.filter((value) => typeof value === "string").length - 1,
  );
  const rows = [
    theme.fg(
      "warning",
      `◆ Fabric composing · ${completed}/${input.bindings.length} writes`,
    ),
  ];
  const callLimit = fabricMulticallCallLimit(input.expanded);
  const shownBindings = input.bindings.slice(0, callLimit);
  for (let index = 0; index < shownBindings.length; index++) {
    const binding = shownBindings[index]!;
    const glyph =
      index !== activeIndex && typeof available[index] === "string"
        ? theme.fg("dim", "›")
        : index === activeIndex
          ? theme.fg("warning", "◐")
          : theme.fg("dim", "○");
    rows.push(
      `${glyph} ${nestedCallTitle(
        {
          ref: "pi.write",
          provider: "pi",
          tool: "write",
          args: {
            path: binding.path,
            ...(typeof available[index] === "string" ? { content: available[index] } : {}),
          },
        },
        theme,
        invalidate,
        input.cwd && input.settings ? { cwd: input.cwd, settings: input.settings } : undefined,
      )}`,
    );
    if (index === activeIndex) {
      const body = renderWriteArgumentBody(
        binding.path,
        available[index] ?? "",
        input.expanded,
        theme,
        invalidate,
        input.cwd && input.settings ? { cwd: input.cwd, settings: input.settings } : undefined,
      );
      for (const line of body.lines) rows.push(`  ${line}`);
      if (body.hidden > 0) {
        rows.push(
          theme.fg("dim", `  … ${body.hidden} more ${body.hidden === 1 ? "line" : "lines"}`),
        );
      }
    }
  }
  const hidden = input.bindings.length - shownBindings.length;
  if (hidden > 0) {
    rows.push(
      theme.fg("dim", `… ${hidden} more ${hidden === 1 ? "write" : "writes"}`) +
        (input.expanded ? "" : theme.fg("dim", " · ") + expandHint(theme)),
    );
  }
  return renderBoundedLines(rows);
};

const shortIdOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value.slice(0, 8) : undefined;

const countOf = (result: unknown): string =>
  Array.isArray(result) ? String(result.length) : "";

const providerCallDetail = (
  provider: string,
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
): string => {
  if (provider === "agents") {
    const name = argString(args, "name");
    const id = shortIdOf(args.id);
    const message = argString(args, "message");
    const task = argString(args, "task");
    switch (tool) {
      case "create":
        return name ?? "";
      case "remove":
      case "stop":
      case "cleanup":
      case "wait":
      case "status":
      case "actorStatus":
      case "messages":
        return id ?? name ?? "";
      case "ask":
      case "tell":
        return [id ?? name, message ? truncateOneLine(message, 48) : ""]
          .filter(Boolean)
          .join(" ");
      case "run":
      case "spawn":
        return name ?? (task ? truncateOneLine(task, 64) : "");
      case "actors":
      case "list":
        return countOf(result);
      default:
        return "";
    }
  }
  if (provider === "mesh") {
    switch (tool) {
      case "publish":
      case "read":
        return argString(args, "topic") ?? "";
      case "get":
      case "put":
      case "delete":
        return argString(args, "key") ?? "";
      case "list":
        return argString(args, "prefix") ?? "";
      case "members":
        return countOf(result);
      default:
        return "";
    }
  }
  if (provider === "mcp") {
    switch (tool) {
      case "$call":
        return [argString(args, "server"), argString(args, "tool")].filter(Boolean).join(".");
      case "$register":
        return argString(args, "name") ?? "";
      case "$servers":
        return countOf(result);
      default:
        return "";
    }
  }
  return "";
};

/** Compact one-line title for a nested Fabric call, e.g. `read src/index.ts` or `$ ls -la`. */
export function nestedCallTitle(
  audit: FabricRenderAudit,
  theme: Theme,
  invalidate?: () => void,
  core?: { cwd: string; settings: CodePreviewSettings },
): string {
  const coreTitle = core
    ? coreToolTitle(audit, theme, { ...core, ...(invalidate ? { invalidate } : {}) })
    : null;
  if (coreTitle) return coreTitle;
  const ref = audit.ref;
  const provider = audit.provider ?? ref.split(".")[0] ?? ref;
  const tool = audit.tool ?? ref.split(".")[1] ?? ref;
  const title = theme.fg("toolTitle", theme.bold(tool));
  const args = audit.args ?? {};
  const providerDetail = providerCallDetail(provider, tool, args, audit.result);
  if (providerDetail) return `${title} ${theme.fg("accent", providerDetail)}`;
  const command = argString(args, "command");
  if (command) {
    const firstLine = command.split("\n")[0] ?? "";
    const highlighted =
      firstLine.length > 0 ? highlightCode(firstLine, "bash", invalidate) : null;
    const cmd =
      highlighted && highlighted[0] ? highlighted[0] : theme.fg("accent", firstLine);
    return `${title} ${theme.fg("dim", "$")} ${cmd}`;
  }
  const path = argString(args, "path");
  const pattern = argString(args, "pattern");
  const task = argString(args, "task");
  let detail = "";
  if (path) detail = path;
  else if (pattern) detail = `/${pattern}/${path ? ` ${path}` : ""}`;
  else if (task) detail = truncateOneLine(task, 64);
  else detail = headlineArg(args) ?? audit.previewHeadline ?? "";
  return detail ? `${title} ${theme.fg("accent", detail)}` : title;
}

const transcriptToolAudit = (entry: FabricTranscriptEntry): FabricRenderAudit => {
  const rawName = entry.toolName ?? entry.label;
  const normalized = rawName.toLowerCase();
  const tool = normalized === "glob"
    ? "find"
    : ["read", "write", "edit", "bash", "grep", "find", "ls"].includes(normalized)
      ? normalized
      : rawName;
  const rawArgs = entry.args ?? {};
  const args: Record<string, unknown> = { ...rawArgs };
  if (typeof rawArgs.file_path === "string" && typeof args.path !== "string") {
    args.path = rawArgs.file_path;
  }
  if (tool === "edit" && !Array.isArray(args.edits)) {
    const oldText = typeof rawArgs.old_string === "string" ? rawArgs.old_string : undefined;
    const newText = typeof rawArgs.new_string === "string" ? rawArgs.new_string : undefined;
    if (oldText !== undefined && newText !== undefined) args.edits = [{ oldText, newText }];
  }
  return {
    ref: `pi.${tool}`,
    provider: "pi",
    tool,
    ...(Object.keys(args).length > 0 ? { args } : {}),
    ...(entry.result !== undefined ? { result: entry.result } : {}),
    ...(entry.status !== "running" ? { success: entry.status !== "failed" } : {}),
  };
};

export const renderNestedAgentToolLines = (
  audit: FabricRenderAudit,
  theme: Theme,
  options: {
    expanded: boolean;
    showTools?: boolean | undefined;
    core?: { cwd: string; settings: CodePreviewSettings } | undefined;
    invalidate?: (() => void) | undefined;
  },
): string[] => {
  if (!isFabricNestedToolPreview(audit.preview)) return [];
  const previewText = safeTerminalText(audit.preview.text ?? "").trim();
  if (audit.preview.tools.length === 0 && !previewText) return [];
  const limit = options.expanded ? 8 : 3;
  const tools = options.showTools === false ? [] : audit.preview.tools.slice(-limit);
  const metadata = theme.fg(
    "dim",
    `[${audit.preview.owner} · ${safeTerminalText(audit.preview.name)} · ${audit.preview.runner ?? "pi"} · ${audit.preview.id.slice(0, 8)}]`,
  );
  const lines: string[] = [];
  if (previewText) {
    const textLines = previewText.split("\n").map((line) => line.trimEnd()).filter(Boolean);
    const textLimit = options.expanded ? 12 : 3;
    const shown = textLines.slice(-textLimit);
    if (shown.length < textLines.length) {
      lines.push(theme.fg("dim", `  … ${textLines.length - shown.length} earlier lines`));
    }
    for (const line of shown) lines.push(`  ${theme.fg("toolOutput", line)}`);
    lines.push(`  ${metadata}`);
  }
  for (const entry of tools) {
    const nestedAudit = transcriptToolAudit(entry);
    const depth = Math.max(0, entry.depth ?? 0);
    const padding = `  ${"  ".repeat(depth)}`;
    const glyph = entry.status === "running"
      ? theme.fg("warning", "◐")
      : entry.status === "failed"
        ? theme.fg("error", "✗")
        : theme.fg("dim", "›");
    lines.push(
      `${padding}${glyph} ${nestedCallTitle(
        nestedAudit,
        theme,
        options.invalidate,
        options.core,
      )} ${metadata}`,
    );
    const codeChange = nestedAudit.tool === "edit" || nestedAudit.tool === "write";
    if (!options.core || (entry.status !== "running" && !options.expanded && !codeChange)) {
      continue;
    }
    const body = renderCoreToolBody(nestedAudit, theme, {
      cwd: options.core.cwd,
      settings: options.core.settings,
      expanded: options.expanded,
      maxLines: options.expanded ? 24 : 6,
      ...(options.invalidate ? { invalidate: options.invalidate } : {}),
    });
    if (!body) continue;
    for (const row of body.lines) lines.push(`${padding}  ${row}`);
    if (body.hidden > 0) lines.push(theme.fg("dim", `${padding}  … ${body.hidden} more lines`));
  }
  return lines;
};

interface FabricMulticallPreview {
  auditIndex: number;
  body: string;
  hidden: number;
}

export interface FabricMulticallPartialInput {
  audits: FabricRenderAudit[];
  phases: string[];
  progress?: string | undefined;
  expanded: boolean;
  preview?: FabricMulticallPreview | undefined;
  core?: { cwd: string; settings: CodePreviewSettings } | undefined;
  showNestedToolCalls?: boolean | undefined;
}

export const compactProgressPreview = (progress: string): string => {
  const lines = safeTerminalText(progress)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const latest = lines[lines.length - 1] ?? "";
  if (lines.length <= 1) return latest;
  return `… ${lines.length - 1} ${lines.length === 2 ? "line" : "lines"} · ${latest}`;
};

export const renderFabricMulticallPartial = (
  input: FabricMulticallPartialInput,
  theme: Theme,
  invalidate?: () => void,
): Component => {
  const done = input.audits.filter((audit) => audit.success !== undefined).length;
  let header = theme.fg(
    "warning",
    `◆ Fabric running · ${done}/${input.audits.length} calls`,
  );
  const progress = input.progress ? compactProgressPreview(input.progress) : "";
  if (progress) header += theme.fg("dim", ` · ${progress}`);

  const rows = [header];
  if (input.phases.length > 0) {
    rows.push(theme.fg("dim", input.phases.map((phase) => `◆ ${phase}`).join("  ")));
  }

  const callLimit = fabricMulticallCallLimit(input.expanded);
  const callsShown = input.audits.slice(0, callLimit);
  for (let index = 0; index < callsShown.length; index++) {
    const audit = callsShown[index]!;
    if (input.expanded && index > 0) rows.push("");
    const glyph =
      audit.success === undefined
        ? theme.fg("warning", "◐")
        : audit.success === false
          ? theme.fg("error", "✗")
          : theme.fg("dim", "›");
    rows.push(`${glyph} ${nestedCallTitle(audit, theme, invalidate, input.core)}`);
    if (audit.success === false && audit.error) {
      for (const line of safeTerminalText(audit.error).split("\n")) {
        rows.push(`  ${theme.fg("error", line)}`);
      }
    } else if (input.preview?.auditIndex === index) {
      for (const line of input.preview.body.split("\n")) rows.push(`  ${line}`);
      if (input.preview.hidden > 0) {
        rows.push(
          theme.fg(
            "dim",
            `  … ${input.preview.hidden} more ${input.preview.hidden === 1 ? "line" : "lines"}`,
          ),
        );
      }
    }
    rows.push(
      ...renderNestedAgentToolLines(audit, theme, {
        expanded: input.expanded,
        showTools: input.showNestedToolCalls,
        core: input.core,
        ...(invalidate ? { invalidate } : {}),
      }),
    );
  }

  const callsHidden = input.audits.length - callsShown.length;
  if (callsHidden > 0) {
    const label = `… ${callsHidden} nested ${callsHidden === 1 ? "call" : "calls"} hidden`;
    rows.push(
      theme.fg("dim", label) +
        (input.expanded ? "" : theme.fg("dim", " · ") + expandHint(theme)),
    );
  }
  return renderBoundedLines(rows, theme, input.core?.settings.diffIntensity ?? "off");
};

export interface FabricCoreToolPreview extends FabricRenderAudit {
  ref: string;
}

const CORE_TOOL_NAMES = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);

export const captureFabricCoreToolPreviews = (
  audits: FabricRenderAudit[],
  previous: FabricCoreToolPreview[] = [],
): FabricCoreToolPreview[] => {
  const prior = previous.slice();
  return audits.flatMap((audit) => {
    if (
      !audit.tool ||
      !CORE_TOOL_NAMES.has(audit.tool) ||
      (audit.provider !== "pi" && audit.ref !== `pi.${audit.tool}`)
    ) return [];
    const path = argString(audit.args ?? {}, "path");
    const index = prior.findIndex(
      (candidate) =>
        candidate.ref === audit.ref &&
        argString(candidate.args ?? {}, "path") === path,
    );
    const old = index >= 0 ? prior.splice(index, 1)[0] : undefined;
    return [{
      ...(old ?? {}),
      ...audit,
      args: { ...(old?.args ?? {}), ...(audit.args ?? {}) },
      ...(audit.result !== undefined
        ? { result: audit.result }
        : old?.result !== undefined
          ? { result: old.result }
          : {}),
      ...(audit.preview !== undefined
        ? { preview: audit.preview }
        : old?.preview !== undefined
          ? { preview: old.preview }
          : {}),
    }];
  });
};

export const restoreFabricCoreToolPreviews = (
  audits: FabricRenderAudit[],
  previews: FabricCoreToolPreview[],
): FabricRenderAudit[] => {
  const remaining = previews.slice();
  return audits.map((audit) => {
    if (
      !audit.tool ||
      !CORE_TOOL_NAMES.has(audit.tool) ||
      (audit.provider !== "pi" && audit.ref !== `pi.${audit.tool}`)
    ) return audit;
    const path = argString(audit.args ?? {}, "path");
    let index = remaining.findIndex(
      (preview) =>
        preview.ref === audit.ref &&
        argString(preview.args ?? {}, "path") === path,
    );
    if (index < 0) index = remaining.findIndex((preview) => preview.ref === audit.ref);
    if (index < 0) return audit;
    const preview = remaining.splice(index, 1)[0];
    if (!preview) return audit;
    return {
      ...preview,
      ...audit,
      args: { ...(preview.args ?? {}), ...(audit.args ?? {}) },
      ...(audit.result !== undefined
        ? { result: audit.result }
        : preview.result !== undefined
          ? { result: preview.result }
          : {}),
      ...(audit.preview !== undefined
        ? { preview: audit.preview }
        : preview.preview !== undefined
          ? { preview: preview.preview }
          : {}),
      ...(audit.resultTruncated !== undefined
        ? { resultTruncated: audit.resultTruncated }
        : preview.resultTruncated !== undefined
          ? { resultTruncated: preview.resultTruncated }
          : {}),
    };
  });
};

export interface FabricWritePreview {
  ref: string;
  path?: string | undefined;
  content: string;
}

export const captureFabricWritePreviews = (audits: FabricRenderAudit[]): FabricWritePreview[] =>
  audits.flatMap((audit) => {
    const rendererPreview =
      typeof audit.preview === "object" && audit.preview !== null && !Array.isArray(audit.preview)
        ? (audit.preview as Record<string, unknown>)
        : undefined;
    const content = audit.tool === "write"
      ? (typeof rendererPreview?.writeContent === "string"
          ? rendererPreview.writeContent
          : argString(audit.args ?? {}, "content"))
      : undefined;
    if (content === undefined) return [];
    return [{ ref: audit.ref, path: argString(audit.args ?? {}, "path"), content }];
  });

// Arbitrary provider arguments are deliberately absent from persisted traces.
// Keep only their selected one-line headlines in renderer state so completion
// does not erase a preview that was already visible while the call was live.
export interface FabricCallHeadlinePreview {
  ref: string;
  headline: string;
}

export const captureFabricCallHeadlinePreviews = (
  audits: FabricRenderAudit[],
): FabricCallHeadlinePreview[] =>
  audits.flatMap((audit) => {
    const headline = headlineArg(audit.args);
    return headline ? [{ ref: audit.ref, headline }] : [];
  });

export const restoreFabricCallHeadlinePreviews = (
  audits: FabricRenderAudit[],
  previews: FabricCallHeadlinePreview[],
): FabricRenderAudit[] => {
  const remaining = previews.slice();
  return audits.map((audit) => {
    const index = remaining.findIndex((preview) => preview.ref === audit.ref);
    if (index < 0) return audit;
    const [preview] = remaining.splice(index, 1);
    if (headlineArg(audit.args) || !preview) return audit;
    return { ...audit, previewHeadline: preview.headline };
  });
};

// Write content is also absent from persisted traces. Keep bounded live content
// so a fast write can still render when its final result replaces the partial.
export const restoreFabricWritePreviews = (
  audits: FabricRenderAudit[],
  previews: FabricWritePreview[],
): FabricRenderAudit[] => {
  const remaining = previews.slice();
  return audits.map((audit) => {
    if (audit.tool !== "write" || typeof audit.args?.content === "string") return audit;
    const path = argString(audit.args ?? {}, "path");
    const index = remaining.findIndex(
      (preview) => preview.ref === audit.ref && preview.path === path,
    );
    if (index < 0) return audit;
    const [preview] = remaining.splice(index, 1);
    return preview
      ? { ...audit, args: { ...(audit.args ?? {}), content: preview.content } }
      : audit;
  });
};

/** Extract the human-readable body text from a nested call result or write arguments, if any. */
export function nestedCallBody(audit: FabricRenderAudit): string | undefined {
  if (audit.tool === "write" && typeof audit.args?.content === "string") {
    return audit.args.content;
  }
  const result = audit.result;
  if (typeof result === "string") return result;
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    if (typeof obj.output === "string") return obj.output;
    if (typeof obj.text === "string") return obj.text;
  }
  return undefined;
}

/** Source code + language for syntax highlighting, for reads (file content) and writes (content being written). */
export function nestedCallCode(
  audit: FabricRenderAudit,
): { code: string; lang: string } | null {
  const args = audit.args ?? {};
  const path = typeof args.path === "string" ? args.path : undefined;
  const lang = languageFromPath(path);
  if (!lang) return null;
  if (audit.tool === "read") {
    return typeof audit.result === "string" ? { code: audit.result, lang } : null;
  }
  if (audit.tool === "write") {
    return typeof args.content === "string" ? { code: args.content, lang } : null;
  }
  return null;
}

const escapeControlChars = (text: string): string =>
  text
    .replace(/\x1b/g, "␛")
    .replace(/\r/g, "␍")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "�");

type DiffLine = { kind: "+" | "-" | " "; content: string };

const lineDiff = (oldLines: string[], newLines: string[]): DiffLine[] => {
  const m = oldLines.length;
  const n = newLines.length;
  if (m * n > 1_000_000) {
    return [
      ...oldLines.map((line) => ({ kind: "-" as const, content: line })),
      ...newLines.map((line) => ({ kind: "+" as const, content: line })),
    ];
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    const oldLine = oldLines[i] ?? "";
    const cur = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = n - 1; j >= 0; j--) {
      const newLine = newLines[j] ?? "";
      cur[j] =
        oldLine === newLine
          ? (next[j + 1] ?? 0) + 1
          : Math.max(next[j] ?? 0, cur[j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    const oldLine = oldLines[i] ?? "";
    const newLine = newLines[j] ?? "";
    if (oldLine === newLine) {
      out.push({ kind: " ", content: oldLine });
      i++;
      j++;
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      out.push({ kind: "-", content: oldLine });
      i++;
    } else {
      out.push({ kind: "+", content: newLine });
      j++;
    }
  }
  while (i < m) {
    out.push({ kind: "-", content: oldLines[i] ?? "" });
    i++;
  }
  while (j < n) {
    out.push({ kind: "+", content: newLines[j] ?? "" });
    j++;
  }
  return out;
};

/** Render a syntax-highlighted line diff for a nested `pi.edit` call, or null. */
export function nestedEditDiff(
  audit: FabricRenderAudit,
  theme: Theme,
  invalidate?: () => void,
): string[] | null {
  if (audit.tool !== "edit") return null;
  const args = audit.args ?? {};
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (edits.length === 0) return null;
  const lang = languageFromPath(typeof args.path === "string" ? args.path : undefined);
  const lines: string[] = [];
  for (const edit of edits.slice(0, 5)) {
    if (!edit || typeof edit !== "object") continue;
    const record = edit as Record<string, unknown>;
    const oldText = typeof record.oldText === "string" ? record.oldText : "";
    const newText = typeof record.newText === "string" ? record.newText : "";
    const diff = lineDiff(oldText.split("\n"), newText.split("\n"));
    if (diff.length === 0) continue;
    const contents = diff.map((entry) => entry.content);
    let highlighted: string[] | null = null;
    if (lang) highlighted = highlightCode(contents.join("\n"), lang, invalidate);
    for (let index = 0; index < diff.length; index++) {
      const entry = diff[index]!;
      const content =
        highlighted && highlighted[index] != null
          ? highlighted[index] || " "
          : theme.fg("toolOutput", escapeControlChars(entry.content) || " ");
      if (entry.kind === "+") {
        lines.push(`${theme.fg("toolDiffAdded", "+")} ${content}`);
      } else if (entry.kind === "-") {
        lines.push(`${theme.fg("toolDiffRemoved", "-")} ${content}`);
      } else {
        lines.push(`${theme.fg("toolDiffContext", " ")} ${content}`);
      }
    }
  }
  return lines.length > 0 ? lines : null;
}

const lineCountTrimmed = (value: string): number => {
  const lines = value.split("\n");
  let end = lines.length;
  while (end > 0) {
    const last = lines[end - 1];
    if (last === undefined || last.trim() === "") end--;
    else break;
  }
  return end;
};

// Mirrors pi core's read range notice: surface how many lines a fabric_exec
// program sent to the model vs. how many its nested read(s) returned, so
// sliced reads don't look like full-file reads. The audited body is unchanged.
export function modelReadHint(
  audits: FabricRenderAudit[],
  output: string,
  theme: Theme,
): string {
  if (!output) return "";
  const modelLines = lineCountTrimmed(output);
  let readLines = 0;
  let sawRead = false;
  for (const audit of audits) {
    if (audit.tool !== "read") continue;
    const body = nestedCallBody(audit);
    if (typeof body !== "string") continue;
    sawRead = true;
    readLines += lineCountTrimmed(body);
  }
  if (!sawRead || modelLines >= readLines) return "";
  return theme.fg("warning", "→ " + modelLines + " of " + readLines + " lines to model");
}
