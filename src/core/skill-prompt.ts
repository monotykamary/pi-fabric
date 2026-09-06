import type { Skill } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "./skill-block.js";

const SKILL_SECTION_HEADING =
  "The following skills provide specialized instructions for specific tasks.";
const PI_SKILL_LOAD_INSTRUCTION =
  "Use the read tool to load a skill's file when the task matches its description.";
const FABRIC_SKILL_LOAD_INSTRUCTION =
  "Use `pi.read` inside `fabric_exec` to load a skill's file when the task matches its description.";
const CWD_MARKER = "\nCurrent working directory:";

export const restoreSkillsForFullCodePrompt = (
  systemPrompt: string,
  skills: readonly Skill[],
  fullCodeMode = true,
): string => {
  const section = formatSkillsForPrompt([...skills]).replace(
    PI_SKILL_LOAD_INSTRUCTION,
    fullCodeMode ? FABRIC_SKILL_LOAD_INSTRUCTION : PI_SKILL_LOAD_INSTRUCTION,
  );
  // Replace the catalog, not just its loader sentence: a previous catalog may
  // advertise skills for a different kernel, including in native-tool mode.
  const start = systemPrompt.indexOf(SKILL_SECTION_HEADING);
  const end = start < 0 ? -1 : systemPrompt.indexOf("</available_skills>", start);
  if (start >= 0 && end >= 0) {
    return systemPrompt.slice(0, start) + section.trimStart() +
      systemPrompt.slice(end + "</available_skills>".length);
  }
  if (!section) return systemPrompt;

  const cwdIndex = systemPrompt.lastIndexOf(CWD_MARKER);
  if (cwdIndex < 0) return `${systemPrompt}${section}`;
  return `${systemPrompt.slice(0, cwdIndex)}${section}${systemPrompt.slice(cwdIndex)}`;
};
