import { fabricExecTitleHint, fabricScriptTitleHint } from "./fabric-code-parser.js";

// Session-wide memo for the lexical fallback title, keyed by the exact program
// string. The same key recurs in three places — the compact renderCall card
// (re-rendered on every streaming tick), the activity store start, and
// compaction normalization over recorded arguments — so one tokenize pass per
// unique program covers all three. Bounded with insertion-order eviction: run
// names stay cheap for arbitrarily long sessions without retention growth.
const TITLE_HINT_CACHE_MAX = 256;

const memoize = (
  cache: Map<string, string | undefined>,
  derive: (text: string) => string | undefined,
) => (text: string): string | undefined => {
  const hit = cache.get(text);
  if (hit !== undefined || cache.has(text)) return hit;
  const hint = derive(text);
  if (cache.size >= TITLE_HINT_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(text, hint);
  return hint;
};

export const fabricExecTitleHintCached = memoize(new Map(), fabricExecTitleHint);

// Separate cache, not a shared one: a shell payload and a TypeScript program can
// be the same string ("ls") and derive different titles, so one map keyed by
// text alone would hand a script the program's title.
const fabricScriptTitleHintCached = memoize(new Map(), fabricScriptTitleHint);

/**
 * Resolve the title of the model-authored surface. Callers pass the same flat
 * arguments that cross the public fabric_exec seam; script/code selection and
 * cache policy live here so UI, activity, and compaction cannot drift.
 */
export const fabricAuthoredTitleHintCached = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  if (typeof record.script === "string") {
    return fabricScriptTitleHintCached(record.script);
  }
  const code = Array.isArray(record.code) && record.code.every((line) => typeof line === "string")
    ? record.code.join("\n")
    : record.code;
  return typeof code === "string" ? fabricExecTitleHintCached(code) : undefined;
};
