import type { AppKeybinding, Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";

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
export function nestedCallTitle(audit: FabricRenderAudit, theme: Theme): string {
  const tool = audit.tool ?? audit.ref.split(".")[1] ?? audit.ref;
  const title = theme.fg("toolTitle", theme.bold(tool));
  const args = audit.args ?? {};
  const path = argString(args, "path");
  const command = argString(args, "command");
  const pattern = argString(args, "pattern");
  const task = argString(args, "task");
  let detail = "";
  if (command) detail = `$ ${command}`;
  else if (path) detail = path;
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

/** Whether a nested call's body should be rendered with line numbers (reads/searches/listings). */
export function isNumberedTool(audit: FabricRenderAudit): boolean {
  return audit.tool !== undefined && NUMBERED_TOOLS.has(audit.tool);
}
