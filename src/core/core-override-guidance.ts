import type { CapturedToolCatalog } from "../capture/catalog.js";
import { PI_CORE_TOOL_NAMES } from "./pi-tools.js";

/**
 * Append authored guidance from the current exact-name core overrides without
 * presenting those definitions as separate extension tools.
 */
export const coreOverridePromptGuidance = (
  catalog: CapturedToolCatalog,
): string => {
  const sections: string[] = [];
  for (const name of PI_CORE_TOOL_NAMES) {
    const entry = catalog.get(name);
    if (!entry) continue;
    const lines: string[] = [];
    if (entry.definition.promptSnippet) {
      lines.push(`Additional guidance for \`pi.${name}\`: ${entry.definition.promptSnippet}`);
    }
    const guidelines = entry.definition.promptGuidelines ?? [];
    if (guidelines.length > 0) {
      lines.push(`Guidelines for \`pi.${name}\`:`);
      lines.push(...guidelines.map((guideline) => `- ${guideline}`));
    }
    if (lines.length > 0) sections.push(lines.join("\n"));
  }
  return sections.length > 0
    ? `\n\nEffective compatible core override guidance:\n${sections.join("\n")}`
    : "";
};
