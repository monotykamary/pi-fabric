import {
  formatSkillsForPrompt,
  type Skill,
} from "@earendil-works/pi-coding-agent";

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
): string => {
  const section = formatSkillsForPrompt([...skills]).replace(
    PI_SKILL_LOAD_INSTRUCTION,
    FABRIC_SKILL_LOAD_INSTRUCTION,
  );
  if (!section) return systemPrompt;

  if (systemPrompt.includes(SKILL_SECTION_HEADING)) {
    return systemPrompt.replace(
      PI_SKILL_LOAD_INSTRUCTION,
      FABRIC_SKILL_LOAD_INSTRUCTION,
    );
  }

  const cwdIndex = systemPrompt.lastIndexOf(CWD_MARKER);
  if (cwdIndex < 0) return `${systemPrompt}${section}`;
  return `${systemPrompt.slice(0, cwdIndex)}${section}${systemPrompt.slice(cwdIndex)}`;
};
