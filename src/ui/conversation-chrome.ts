import { homedir } from "node:os";
import path from "node:path";
import { SettingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens, safeText } from "./format.js";
import type { FabricConversationTarget } from "./conversation.js";

export interface FabricConversationAppearance {
  editorPaddingX: number;
  outputPad: 0 | 1;
  codeBlockIndent?: string;
  hideThinkingBlock?: boolean;
  showImages?: boolean;
  imageWidthCells?: number;
}

/** Read the host's public Pi settings without changing its editor or footer. */
export function readConversationAppearance(cwd: string, agentDir: string, projectTrusted: boolean): FabricConversationAppearance {
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
  return {
    editorPaddingX: settings.getEditorPaddingX(), outputPad: settings.getOutputPad(),
    codeBlockIndent: settings.getCodeBlockIndent(), hideThinkingBlock: settings.getHideThinkingBlock(),
    showImages: settings.getShowImages(), imageWidthCells: settings.getImageWidthCells(),
  };
}

const footerPath = (cwd: string): string => {
  const home = homedir();
  if (cwd === home) return "~";
  return cwd.startsWith(`${home}${path.sep}`) ? `~${cwd.slice(home.length)}` : cwd;
};

/** Native-shaped footer backed by this participant, never by Main's session stats. */
export function conversationFooter(target: FabricConversationTarget | undefined, theme: Theme, width: number): string[] {
  if (!target || width <= 0) return [];
  const location = target.cwd ? footerPath(target.cwd) : "cwd unavailable";
  const branch = target.branch ? ` (${target.branch})` : "";
  const pwd = safeText(`${location}${branch} • ${target.name}`);
  const stats = [safeText(target.status)];
  if (target.usage) {
    const usage = target.usage;
    // Agent usage is run-scoped; actor values describe the current/last activation.
    stats.push("run", `↑${formatTokens(usage.input)}`, `↓${formatTokens(usage.output)}`);
    if (usage.cacheRead > 0) stats.push(`R${formatTokens(usage.cacheRead)}`);
    if (usage.cacheWrite > 0) stats.push(`W${formatTokens(usage.cacheWrite)}`);
    if (Number.isFinite(usage.cost)) stats.push(`$${usage.cost.toFixed(3)}`);
  } else {
    stats.push("usage unavailable");
  }
  // Cumulative run tokens are not current context occupancy. Do not invent a percentage.
  stats.push(target.contextWindow ? `?/${formatTokens(target.contextWindow)} ctx` : "ctx ?");
  const model = safeText(target.model ?? `${target.runner ?? ""} model unavailable`).trim();
  const thinking = target.thinking ? ` • ${safeText(target.thinking === "off" ? "thinking off" : target.thinking)}` : "";
  const left = truncateToWidth(stats.join(" "), width, "…");
  const right = truncateToWidth(`${model}${thinking}`, Math.max(0, width - visibleWidth(left) - 2), "");
  const gap = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));
  return [
    truncateToWidth(theme.fg("dim", pwd), width, "…"),
    theme.fg("dim", `${left}${gap}${right}`),
  ];
}
