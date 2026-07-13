import type { AppKeybinding, Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { highlightCode, languageFromPath } from "./highlight.js";

export interface FabricRenderAudit {
  ref: string;
  tool?: string;
  provider?: string;
  success?: boolean;
  error?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  resultTruncated?: boolean;
}

const EXPAND_KEYBINDING = "app.tools.expand" as AppKeybinding;
const NUMBERED_TOOLS = new Set(["read", "grep", "find", "ls"]);

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

/** Compact one-line title for a nested Fabric call, e.g. `read src/index.ts` or `$ ls -la`. */
export function nestedCallTitle(
  audit: FabricRenderAudit,
  theme: Theme,
  invalidate?: () => void,
): string {
  const tool = audit.tool ?? audit.ref.split(".")[1] ?? audit.ref;
  const title = theme.fg("toolTitle", theme.bold(tool));
  const args = audit.args ?? {};
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
  return detail ? `${title} ${theme.fg("accent", detail)}` : title;
}

/** Extract the human-readable body text from a nested call result, if any. */
export function nestedCallBody(audit: FabricRenderAudit): string | undefined {
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

/** Whether a nested call's body should be rendered with line numbers (reads/searches/listings). */
export function isNumberedTool(audit: FabricRenderAudit): boolean {
  return audit.tool !== undefined && NUMBERED_TOOLS.has(audit.tool);
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
