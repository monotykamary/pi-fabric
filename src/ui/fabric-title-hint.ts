import { fabricExecTitleHint } from "./fabric-code-parser.js";
import type { FabricKernel } from "../runtime/kernel.js";

// The live card, activity feed and compaction share a bounded memo. Include
// the kernel: identical source can mean different things in each language.
const TITLE_HINT_CACHE_MAX = 256;
const titleHintCache = new Map<string, string | undefined>();

export const fabricExecTitleHintCached = (
  code: string,
  kernel: FabricKernel = "typescript",
): string | undefined => {
  const key = `${kernel}\0${code}`;
  const hit = titleHintCache.get(key);
  if (hit !== undefined || titleHintCache.has(key)) return hit;
  const hint = fabricExecTitleHint(code, kernel);
  if (titleHintCache.size >= TITLE_HINT_CACHE_MAX) {
    const oldest = titleHintCache.keys().next().value;
    if (oldest !== undefined) titleHintCache.delete(oldest);
  }
  titleHintCache.set(key, hint);
  return hint;
};
