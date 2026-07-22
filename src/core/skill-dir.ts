import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import path from "node:path";

const SKILL_DIR_MARKER = "<skill-dir>";

export const expandSkillDirMarkers = (
  content: string,
  skillDir: string,
): string => content.replaceAll(SKILL_DIR_MARKER, skillDir);

export const expandSkillDirMarkersInSkillBlock = (content: string): string => {
  if (!content.includes(SKILL_DIR_MARKER)) return content;
  const block = parseSkillBlock(content);
  if (!block) return content;

  const closingTag = "</skill>";
  const closingIndex = content.indexOf(closingTag);
  if (closingIndex < 0) return content;
  const skillEnd = closingIndex + closingTag.length;
  return (
    expandSkillDirMarkers(
      content.slice(0, skillEnd),
      path.dirname(block.location),
    ) + content.slice(skillEnd)
  );
};

const resolveReadPath = (requestedPath: string, cwd: string): string => {
  const withoutAtPrefix = requestedPath.startsWith("@")
    ? requestedPath.slice(1)
    : requestedPath;
  const expandedHome = withoutAtPrefix === "~"
    ? homedir()
    : /^~[\\/]/.test(withoutAtPrefix)
      ? path.join(homedir(), withoutAtPrefix.slice(2))
      : withoutAtPrefix;
  return path.resolve(cwd, expandedHome);
};

export const expandSkillDirMarkersForRead = (
  content: string,
  args: Record<string, unknown>,
  cwd: string,
): string => {
  if (!content.includes(SKILL_DIR_MARKER) || typeof args.path !== "string") {
    return content;
  }
  const requestedPath = resolveReadPath(args.path, cwd);
  if (path.basename(requestedPath) !== "SKILL.md") return content;
  return expandSkillDirMarkers(content, path.dirname(requestedPath));
};
